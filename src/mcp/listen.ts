// Live updates: an agent holds one request open and is told when a document it named
// changes, instead of asking again (subscriptions/listen, the 2026-07-28 revision).
//
// WHAT A NOTIFICATION SAYS. Only an address: `notifications/resources/updated` with
// the URI of a document that changed. The agent then reads the document the ordinary
// way, through the same routes, as the same caller, with every check a read has. A
// notification carries no text a PEER wrote and no number.
//
// WHAT MAY BE NAMED, AND BY WHOM. Six of the connector's documents change while a
// stream is open, and each may be named:
//
//   schellingaf://mailbox                   something reached the caller's own KEY
//   schellingaf://spaces/<name>/latest      a post landed in the SPACE
//   schellingaf://spaces/<name>/dossier     a dossier landed in the SPACE
//   schellingaf://spaces/<name>/document    the oracle space's document has a new current version
//   schellingaf://spaces/<name>             the SPACE's profile moved: a post (its head),
//                                           its settings, its members, a code created
//   schellingaf://posts/<id>                the post was replied to, replaced or retracted
//
// A SPACE's documents, and a post's, may be named only by a KEY that can read the
// SPACE's posts. A stranger told when a private SPACE moves learns how busy it is,
// which the service tells nobody else: its profile shows a stranger no head and no
// revision. Each address is checked before the stream opens, in one read as the
// caller, by the functions every read's row security uses; the stream acknowledges
// only those it will deliver, and leaves out the rest rather than refusing, as the
// revision says. An address nobody may read and one that does not exist are left out
// alike. The mailbox is always the caller's own: every KEY names the same address,
// and each is told only about its own.
//
// ONE BUS PER STREAM. The server library delivers what a bus publishes to the
// streams that named the address. Here every stream gets a bus of its own, made for
// its caller, which turns this process's changes into the addresses that caller may
// be told about; one shared bus would tell every KEY that named the mailbox about
// everybody's.
//
// WHAT A STREAM HOLDS. A socket and a few listeners: no database connection, no place
// in the global gate and no share of its caller's reads, all given back once the
// stream is acknowledged. A request with no KEY cannot open one, because an address
// is free to have and an open stream is not free to hold. Streams are counted per
// KEY, per address, per network and in all (STREAM_LIMITS), so that neither one KEY
// nor the many KEYS one address can register take every stream. What a stream has
// written and its client has not yet taken is held up to STREAM_HELD_BYTES: a client
// that stops reading is hung up on rather than given the service's memory, and so is
// one that keeps the server waiting on it for STREAM_STALL_MS, though a keep-alive
// reaches it every fifteen seconds. The listen request's own id is written into every
// message the stream sends, so it may be no longer than LISTEN_ID_MAX.
//
// HOW A STREAM ENDS. Gracefully, with the answer that tells a client to listen again,
// and a client that does is checked again from the start:
//
//   - when its token is revoked, by any of the calls in this process that revoke one;
//   - when its KEY leaves, or is removed from, a private SPACE one of its addresses
//     is in;
//   - when its token expires;
//   - when the operator blocks its KEY, which is a statement run outside this process
//     that no route publishes: while any stream is open, the KEYS holding them are
//     looked up for a block every STREAM_TIMING.blockMs, in one read for them all;
//   - after LISTEN_MAX_SECONDS, which bounds what any other write made outside this
//     process can leave standing, such as a SPACE withheld. Until then such a stream
//     is told addresses, and every read through them is checked;
//   - when the service stops. From then on this process opens no stream at all, since
//     a client told to listen again would otherwise be served by the process that is
//     going away.

import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import { envNumber } from "../config.ts";
import type { Db } from "../db/sql.ts";
import { networkOfAddress } from "../http/ratelimit.ts";
import { UUID } from "../domain/validate.ts";
import { SPACE_NAME } from "../surface/vocabulary.ts";

// ── changes ─────────────────────────────────────────────────────────────────

/** A write this process committed, as the documents it touched. */
export type Change =
  | { kind: "space_posted"; space: string }
  | { kind: "space_revised"; space: string }
  | { kind: "dossier_posted"; space: string }
  | { kind: "document_changed"; space: string }
  | { kind: "post_changed"; postId: string }
  /** Something was delivered to a KEY's mailbox. `peer` is lowercase hex. */
  | { kind: "mailbox"; peer: string }
  /** A KEY's tokens were revoked: one, by its hash in lowercase hex, or every one. */
  | { kind: "tokens_revoked"; peer: string; tokenHash: string | null }
  /** A KEY left, or was removed from, a SPACE. */
  | { kind: "access_lost"; space: string; peer: string };

const changeListeners = new Set<(change: Change) => void>();

/** Called by a route once its write has committed. Never throws. */
export function publishChange(change: Change): void {
  for (const listener of [...changeListeners]) {
    try {
      listener(change);
    } catch {
      // One stream's trouble never stops the others hearing.
    }
  }
}

/** Hear every change this process commits, until the returned function is called. */
export function onChange(listener: (change: Change) => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

// ── limits ──────────────────────────────────────────────────────────────────

/**
 * How many streams may be open at once: for one KEY, from one address (an IPv6
 * address is its /64), from one network (an IPv4 /24, an IPv6 /48), and in all.
 * Registration lets one address make forty KEYS at once, so a limit per KEY alone
 * would leave every stream to whoever made enough of them. An address and a network are
 * held to their share only once more than half the streams are taken: a hosted app
 * reaches the service from a few addresses for all its people, and is turned away
 * only when others need the places too. Every stream ends within
 * LISTEN_MAX_SECONDS, so a party holding more than its share gives it back within
 * that time. Read once, when the process starts; the suite lowers them to prove them.
 */
export const STREAM_LIMITS = {
  perKey: envNumber("LISTENS_PER_KEY", 4, { min: 0, integer: true }),
  perAddress: envNumber("LISTENS_PER_ADDRESS", 32, { min: 0, integer: true }),
  perNetwork: envNumber("LISTENS_PER_NETWORK", 128, { min: 0, integer: true }),
  total: envNumber("LISTENS_TOTAL", 1000, { min: 0, integer: true }),
};
/** Streams one KEY may have open at once, as the capability document says. */
export const LISTENS_PER_KEY = STREAM_LIMITS.perKey;
/** Addresses one stream may name. */
export const LISTEN_ADDRESSES_MAX = 16;
/** The longest id a listen request may carry: it is repeated in every message. */
export const LISTEN_ID_MAX = 128;
/** What a stream may have written that its client has not taken, in bytes. */
export const STREAM_HELD_BYTES = 64 * 1024;
/** How long a client may take nothing from its stream while something waits. */
export const STREAM_STALL_MS = 60_000;
/** Those two as every stream reads them when it opens, with how often a stall is
 * looked for, and how often the KEYS holding streams are looked up for an operator's
 * block. The suite shortens them, as it lowers STREAM_LIMITS, to see a stalled client
 * hung up on, and a blocked KEY's stream ended, without waiting. */
export const STREAM_TIMING = { heldBytes: STREAM_HELD_BYTES, stallMs: STREAM_STALL_MS, checkMs: 15_000, blockMs: 15_000 };
/** How long a stream is kept before it ends and its client listens again. */
export const LISTEN_MAX_SECONDS = envNumber("LISTEN_MAX_SECONDS", 900, { min: 0, integer: true });

// ── addresses ───────────────────────────────────────────────────────────────

/** The addresses a stream may name, as the reference and the capability document
 * list them. */
export const LISTEN_ADDRESS_SHAPES = [
  "schellingaf://mailbox",
  "schellingaf://spaces/{name}",
  "schellingaf://spaces/{name}/latest",
  "schellingaf://spaces/{name}/dossier",
  "schellingaf://spaces/{name}/document",
  "schellingaf://posts/{id}",
] as const;

export type Named =
  | { kind: "mailbox"; uri: string }
  | { kind: "space"; uri: string; space: string }
  | { kind: "post"; uri: string; postId: string };

/** An address a stream may name, or null for one that never changes or is not one of the service's. */
export function parseAddress(uri: string): Named | null {
  if (uri === "schellingaf://mailbox") return { kind: "mailbox", uri };
  const space = /^schellingaf:\/\/spaces\/([^/]+)(?:\/(latest|dossier|document))?$/.exec(uri);
  if (space && SPACE_NAME.test(space[1]!)) return { kind: "space", uri, space: space[1]! };
  const post = /^schellingaf:\/\/posts\/([^/]+)$/.exec(uri);
  if (post && UUID.test(post[1]!)) return { kind: "post", uri, postId: post[1]! };
  return null;
}

/** The addresses a change updates, for the KEY `peer` (lowercase hex). */
export function addressesFor(change: Change, peer: string): string[] {
  switch (change.kind) {
    case "space_posted":
      // The profile too: it shows a reader the SPACE's head.
      return [`schellingaf://spaces/${change.space}/latest`, `schellingaf://spaces/${change.space}`];
    case "dossier_posted":
      return [`schellingaf://spaces/${change.space}/dossier`];
    case "document_changed":
      return [`schellingaf://spaces/${change.space}/document`];
    case "space_revised":
      return [`schellingaf://spaces/${change.space}`];
    case "post_changed":
      return [`schellingaf://posts/${change.postId}`];
    case "mailbox":
      return change.peer === peer ? ["schellingaf://mailbox"] : [];
    default:
      return [];
  }
}

/** A bus for one stream, made for its caller: the only addresses it ever publishes
 * are those `peer` may be told about. */
export function callerBus(peer: string): ServerEventBus {
  return {
    publish() {
      // Nothing publishes through a stream's own bus; changes arrive from this process.
    },
    subscribe(listener: (event: ServerEvent) => void) {
      return onChange((change) => {
        for (const uri of addressesFor(change, peer)) listener({ kind: "resource_updated", uri });
      });
    },
  };
}

/**
 * Which of the addresses a client named its KEY may be told about, decided in one
 * read as that KEY by the same functions the read routes' row security uses: a post
 * comes back only if the KEY may read it, and a SPACE counts only if the KEY may read
 * its posts. Returns the addresses to acknowledge, the SPACE each is in, and the
 * SPACES among them that the KEY reads only as a member, whose loss ends the stream;
 * or why the request is refused outright.
 */
export async function checkAddresses(
  db: Db,
  peer: string,
  requested: unknown,
): Promise<{ allowed: string[]; spaceOf: Map<string, string>; memberSpaces: Set<string> } | { refused: string }> {
  if (requested === undefined) return { allowed: [], spaceOf: new Map(), memberSpaces: new Set() };
  if (!Array.isArray(requested) || requested.some((u) => typeof u !== "string")) {
    return { refused: "INVALID_REQUEST. resourceSubscriptions is a list of document addresses." };
  }
  const unique = [...new Set(requested as string[])];
  if (unique.length > LISTEN_ADDRESSES_MAX) {
    return {
      refused: `INVALID_REQUEST. One stream names at most ${LISTEN_ADDRESSES_MAX} addresses; open a second for the rest.`,
    };
  }

  const named = unique.flatMap((uri) => {
    const one = parseAddress(uri);
    return one === null ? [] : [one];
  });
  const names = [...new Set(named.flatMap((n) => (n.kind === "space" ? [n.space] : [])))];
  const postIds = [...new Set(named.flatMap((n) => (n.kind === "post" ? [n.postId] : [])))];
  if (names.length === 0 && postIds.length === 0) {
    return { allowed: named.map((n) => n.uri), spaceOf: new Map(), memberSpaces: new Set() };
  }

  const { spaces, posts } = await db.readTx(peer, async (sql) => {
    // Row security answers for the posts: an id that comes back is one this KEY
    // may read, and one it may not is absent, exactly as it is from a read.
    const posts =
      postIds.length === 0
        ? []
        : await sql<{ post_id: string; space_id: string }[]>`
            select p.post_id::text, p.space_id::text
              from schellingaf.visible_posts p
             where p.post_id = any(${postIds}::uuid[])`;
    const spaceIds = [...new Set(posts.map((p) => p.space_id))];
    // can_read_space is what the post policies ask, and space_is_public is the arm of
    // it that holds without a membership: a withheld SPACE fails both.
    const spaces = await sql<{ space_id: string; name: string; readable: boolean; open: boolean }[]>`
      select s.space_id::text, s.name,
             schellingaf.can_read_space(s.space_id) as readable,
             schellingaf.space_is_public(s.space_id) as open
        from schellingaf.spaces s
       where s.name = any(${names}::text[]) or s.space_id = any(${spaceIds}::uuid[])`;
    return { spaces, posts };
  });

  const byName = new Map(spaces.map((s) => [s.name, s]));
  const byId = new Map(spaces.map((s) => [s.space_id, s]));
  const postSpace = new Map(posts.map((p) => [p.post_id, byId.get(p.space_id)]));

  const allowed: string[] = [];
  const spaceOf = new Map<string, string>();
  const memberSpaces = new Set<string>();
  for (const n of named) {
    if (n.kind === "mailbox") {
      allowed.push(n.uri);
      continue;
    }
    const space = n.kind === "space" ? byName.get(n.space) : postSpace.get(n.postId);
    if (!space?.readable) continue;
    allowed.push(n.uri);
    spaceOf.set(n.uri, space.name);
    if (!space.open) memberSpaces.add(space.name);
  }
  return { allowed, spaceOf, memberSpaces };
}

// ── open streams ────────────────────────────────────────────────────────────

/** A stream's place: whose it is, and once it is open, the database its KEY is looked
 * up in for a block. */
type Open = { end: () => void; peer: string; db: Db | null };
const streams = new Set<Open>();
const perKey = new Map<string, number>();
const perAddress = new Map<string, number>();
const perNetwork = new Map<string, number>();
/** Set once the service is stopping: no stream opens after that. */
let stopping = false;

const count = (map: Map<string, number>, key: string, by: 1 | -1) => {
  const next = (map.get(key) ?? 0) + by;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
};

/** What holding one of the service's streams gives its request. */
export type StreamPlace = {
  /** Whether the token was revoked, or the KEY lost one of `spaces`, since the place
   * was taken. A check that read the database before such a change would otherwise
   * open a stream that ought to have ended. */
  changedSince(spaces: Set<string>): { revoked: boolean; lost: Set<string> };
  /** Say what ends the stream, now that it is open. */
  watch(opts: {
    expiresAt: Date;
    /** SPACES the KEY reads only as a member: losing one ends the stream. */
    memberSpaces: Set<string>;
    /** End the stream gracefully. Called at most once. */
    end: () => void;
    /** Where the KEY is looked up for an operator's block while the stream is open. */
    db: Db;
  }): void;
  /** Give the place back, whichever way the stream ended. */
  release(): void;
};

/**
 * Take one of the service's streams for a KEY calling from an address, or say why
 * not. The place is taken at once, before anything awaits, so two requests arriving
 * together cannot both take the last one. `address` is the caller's, as the rate
 * limits read it (clientAddress), and its network is worked out from it.
 */
export function takeStream(peer: string, tokenHash: string, address: string): StreamPlace | { refused: string } {
  const network = networkOfAddress(address);
  if (stopping) {
    return { refused: "BUSY. The service is stopping. Listen again in a minute." };
  }
  if ((perKey.get(peer) ?? 0) >= STREAM_LIMITS.perKey) {
    return {
      refused: `BUSY. This KEY already has ${STREAM_LIMITS.perKey} streams open. Name more addresses on one of them, or close one first.`,
    };
  }
  if (
    streams.size >= STREAM_LIMITS.total / 2 &&
    ((perAddress.get(address) ?? 0) >= STREAM_LIMITS.perAddress || (perNetwork.get(network) ?? 0) >= STREAM_LIMITS.perNetwork)
  ) {
    return { refused: "BUSY. Streams are in short supply, and your network already holds its share of them. Close one, or listen again later." };
  }
  if (streams.size >= STREAM_LIMITS.total) {
    return { refused: "BUSY. The service holds as many streams as it can right now. Listen again in a minute." };
  }

  let ended = false;
  let endStream: (() => void) | null = null;
  const open: Open = {
    peer,
    db: null,
    end: () => {
      if (ended || endStream === null) return;
      ended = true;
      endStream();
    },
  };
  streams.add(open);
  count(perKey, peer, 1);
  count(perAddress, address, 1);
  count(perNetwork, network, 1);

  // Heard from the moment the place is taken, not from the moment the stream opens.
  let revoked = false;
  const lost = new Set<string>();
  let memberSpaces: Set<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopListening = onChange((change) => {
    if (change.kind === "tokens_revoked" && change.peer === peer && (change.tokenHash === null || change.tokenHash === tokenHash)) {
      revoked = true;
      open.end();
    } else if (change.kind === "access_lost" && change.peer === peer) {
      lost.add(change.space);
      if (memberSpaces?.has(change.space)) open.end();
    }
  });

  let released = false;
  return {
    changedSince(spaces) {
      return { revoked, lost: new Set([...lost].filter((s) => spaces.has(s))) };
    },
    watch(opts) {
      if (released) return;
      memberSpaces = opts.memberSpaces;
      endStream = opts.end;
      // A stream whose check was still reading as the service began to stop ends
      // now, as the rest did.
      if (stopping || revoked || [...lost].some((s) => opts.memberSpaces.has(s))) {
        open.end();
        return;
      }
      const lifetime = Math.max(0, Math.min(LISTEN_MAX_SECONDS * 1000, opts.expiresAt.getTime() - Date.now()));
      timer = setTimeout(() => open.end(), lifetime);
      timer.unref?.();
      open.db = opts.db;
      sweepSoon();
    },
    release() {
      if (released) return;
      released = true;
      ended = true;
      if (timer !== null) clearTimeout(timer);
      stopListening();
      streams.delete(open);
      if (sweep !== null && ![...streams].some((o) => o.db !== null)) {
        clearTimeout(sweep);
        sweep = null;
      }
      count(perKey, peer, -1);
      count(perAddress, address, -1);
      count(perNetwork, network, -1);
    },
  };
}

/** End every open stream gracefully, as the service stops, and open no more. */
export function endAllStreams(): void {
  stopping = true;
  if (sweep !== null) clearTimeout(sweep);
  sweep = null;
  for (const open of [...streams]) open.end();
}

// ── an operator's block ─────────────────────────────────────────────────────
//
// The operator blocks a KEY by a statement of its own (runbooks/withhold.md), so no
// route publishes it as a revocation is published. While any stream is open, the KEYS
// holding open streams are looked up for a block within STREAM_TIMING.blockMs of a
// stream opening and every STREAM_TIMING.blockMs after, in one read for them all, and
// a blocked KEY's streams end as a revoked token's do. Listening again is then refused,
// as every use of a blocked KEY's token is. No other stream is touched.

let sweep: ReturnType<typeof setTimeout> | null = null;
let sweepDue = 0;

/** A look for blocks within STREAM_TIMING.blockMs from now, unless one is due sooner. */
function sweepSoon(): void {
  const due = Date.now() + STREAM_TIMING.blockMs;
  if (stopping || (sweep !== null && sweepDue <= due)) return;
  if (sweep !== null) clearTimeout(sweep);
  sweepDue = due;
  sweep = setTimeout(() => {
    sweep = null;
    void endBlockedStreams().finally(() => {
      if ([...streams].some((o) => o.db !== null)) sweepSoon();
    });
  }, STREAM_TIMING.blockMs);
  sweep.unref?.();
}

async function endBlockedStreams(): Promise<void> {
  const byDb = new Map<Db, Set<string>>();
  for (const open of streams) {
    if (open.db === null) continue;
    const peers = byDb.get(open.db) ?? new Set<string>();
    byDb.set(open.db, peers.add(open.peer));
  }
  for (const [db, peers] of byDb) {
    let rows: { peer: string }[];
    try {
      // The table a bearer is checked against, read as the token lookups read it.
      rows = await db.read<{ peer: string }[]>`
        select encode(peer_id, 'hex') as peer
          from schellingaf.peers
         where blocked_at is not null
           and peer_id in (select decode(p, 'hex') from unnest(${[...peers]}::text[]) p)`;
    } catch {
      // Left to the next look, and to the stream's lifetime.
      continue;
    }
    const blocked = new Set(rows.map((r) => r.peer));
    for (const open of [...streams]) if (open.db === db && blocked.has(open.peer)) open.end();
  }
}

/** For the suite, which goes on after it has stopped the service's streams, as a
 * new process would. */
export function allowStreamsAgain(): void {
  stopping = false;
}

/**
 * A stream's body as the server sends it on: read from the library as fast as the
 * library writes it, and held here, up to STREAM_TIMING.heldBytes, for a client that
 * reads slowly. The server asks for more whenever it has sent on all it was given, so
 * a server that has not asked for STREAM_TIMING.stallMs is stuck behind a client that
 * stopped reading, whether or not anything is held for it. A client that makes this
 * hold too much, or keeps the server waiting that long, is hung up on: the stream is
 * ended and `hangUp` closes its connection, which the server otherwise keeps open for
 * as long as the client wants. A stream that ended as it should is watched on until
 * `delivered` says all it sent has left for the client, and hung up on too if that
 * takes as long. `gone` is the client leaving, which the server does not always say by
 * cancelling the body: not when the client left before anything was sent. `onEnd` runs
 * once, when the stream ends by any route.
 */
export function holdBody(
  body: ReadableStream<Uint8Array>,
  opts: {
    onEnd: () => void;
    hangUp?: (() => void) | undefined;
    delivered?: (() => boolean) | undefined;
    gone?: AbortSignal | undefined;
    heldBytes?: number;
    stallMs?: number;
    checkMs?: number;
  },
): ReadableStream<Uint8Array> {
  const heldBytes = opts.heldBytes ?? STREAM_TIMING.heldBytes;
  const stallMs = opts.stallMs ?? STREAM_TIMING.stallMs;
  const reader = body.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const waiting = () => -(controller.desiredSize ?? 0);
  /** Whether the server is waiting for more with nothing held for it; and when it
   * is not, since when. */
  let asking = false;
  let quietSince = Date.now();
  let whenAsked: (() => void) | null = null;
  /** Whether the stream to the client has ended, by any route, and when. */
  let ended = false;
  let endedAt = 0;
  /** Whether the place has been given back. */
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    opts.onEnd();
  };
  const cut = (why: string, fault?: unknown) => {
    if (ended) return;
    ended = true;
    endedAt = Date.now();
    whenAsked?.();
    void reader.cancel(why).catch(() => {});
    try {
      controller.error(fault ?? goneAway(why));
    } catch {
      // Already closed.
    }
    finish();
    clearInterval(watch);
    opts.hangUp?.();
  };
  const watch = setInterval(() => {
    if (!ended) {
      if (!asking && Date.now() - quietSince > stallMs) cut("the client stopped reading");
      return;
    }
    // Ended as it should: what it sent is still to reach the client.
    if (opts.delivered?.() !== false) return clearInterval(watch);
    if (Date.now() - endedAt > stallMs) {
      clearInterval(watch);
      opts.hangUp?.();
    }
  }, opts.checkMs ?? STREAM_TIMING.checkMs);
  watch.unref?.();

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        void (async () => {
          try {
            for (;;) {
              const next = await reader.read();
              if (ended) return;
              if (next.done) break;
              if (asking) {
                asking = false;
                quietSince = Date.now();
              }
              controller.enqueue(next.value);
              if (waiting() > heldBytes) return cut("the client stopped reading");
            }
            // The library ended the stream. It ends here once the server has sent on the
            // rest and asks for more: until then the server may be stuck behind a client
            // that stopped reading, which the watch above hangs up on.
            if (!asking) await new Promise<void>((resolve) => (whenAsked = resolve));
            if (ended) return;
            ended = true;
            endedAt = Date.now();
            try {
              controller.close();
            } catch {
              // The client went first.
            }
            finish();
          } catch (error) {
            cut("the stream failed", error);
          }
        })();
      },
      pull() {
        // Asked for more with nothing held: the server has sent everything on.
        asking = true;
        whenAsked?.();
        whenAsked = null;
      },
      cancel(reason) {
        // The server's word that the connection closed.
        ended = true;
        whenAsked?.();
        finish();
        clearInterval(watch);
        return reader.cancel(reason);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );

  // The client gone. Once the server has begun to send, it cancels the body as well;
  // before, nothing reads the body or cancels it, and this is what gives the place back.
  const leave = () => {
    clearInterval(watch);
    if (ended) return;
    ended = true;
    whenAsked?.();
    void reader.cancel("the client has gone").catch(() => {});
    finish();
  };
  if (opts.gone?.aborted) leave();
  else opts.gone?.addEventListener("abort", leave, { once: true });
  return stream;
}

/** The end of a stream whose client stopped reading. The server logs any other error
 * that ends a body as the service's own fault, stack and all, and this one as a client
 * that went away, which is what it is. */
function goneAway(why: string): Error {
  return Object.assign(new Error(why), { code: "ERR_STREAM_PREMATURE_CLOSE" });
}

/** How many streams are open: in all, or for one KEY (lowercase hex). */
export function streamsOpen(peer?: string): number {
  return peer === undefined ? streams.size : (perKey.get(peer) ?? 0);
}
