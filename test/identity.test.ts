// The identity flow, end to end over HTTP, including the attacks it is shaped
// against. Nothing here binds a port: the app is a fetch handler, so a test can
// call it directly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import type postgres from "postgres";
import { useService, app, db, fixture, config, call, send, read, HOST } from "./lib/service.ts";
import { withEnv } from "./lib/env.ts";
import type { Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { challengePreimage, CHALLENGE_BYTES } from "../src/domain/protocol.ts";
import { peerIdOf } from "../src/domain/keys.ts";
import {
  ceilingPerMinute,
  clientAddress,
  LIMITS,
  REGISTRATION_BURST_DEFAULT,
  REGISTRATIONS_PER_HOUR_DEFAULT,
  registrationsPerDay,
  resetReadWindows,
  UNPARSEABLE_ADDRESS,
} from "../src/http/ratelimit.ts";

useService("identity");

/** A real Ed25519 keypair, and the raw 32-byte public key the API wants. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, raw: Buffer.from(raw), hex: Buffer.from(raw).toString("hex") };
}

async function challengeFor(publicKeyHex: string) {
  const out = await call("POST", "/v1/keys/challenge", null, { public_key: publicKeyHex });
  assert.equal(out.status, 200);
  return out.body as {
    peer_id: string;
    challenge: string;
    audience: string;
    expires_at: string;
  };
}

function signChallenge(privateKey: ReturnType<typeof keypair>["privateKey"], challengeHex: string, audience = HOST) {
  const preimage = challengePreimage(audience, Buffer.from(challengeHex, "hex"));
  return signBytes(null, preimage, privateKey).toString("hex");
}

const verify = (body: Record<string, unknown>) => call("POST", "/v1/keys/verify", null, body);

/** A db whose two pools record the statements they are handed. */
function counted(real: Db) {
  const seen: { pool: "read" | "write"; sql: string }[] = [];
  const watch = (pool: "read" | "write", sql: postgres.Sql) =>
    new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0];
        seen.push({ pool, sql: Array.isArray(strings) ? strings.join(" ") : String(strings) });
        return Reflect.apply(target as never, thisArg, args as never);
      },
    }) as postgres.Sql;
  return {
    seen,
    db: { ...real, read: watch("read", real.read), write: watch("write", real.write) } as Db,
  };
}

/** Register through an app configured with (or without) a welcome SPACE, and the verify's answer. */
async function mintWith(welcome: string | null, existing?: ReturnType<typeof keypair>) {
  const scoped = createApp({ ...config, welcomeSpace: welcome }, db);
  const k = existing ?? keypair();
  const ch = (await call("POST", "/v1/keys/challenge", null, { public_key: k.hex }, scoped)).body as { challenge: string; peer_id: string };
  const verified = await call("POST", "/v1/keys/verify", null, {
    public_key: k.hex,
    challenge: ch.challenge,
    signature: signChallenge(k.privateKey, ch.challenge),
  }, scoped);
  return { peerId: ch.peer_id, key: k, status: verified.status, body: verified.body as { token?: string; peer_id: string } };
}

describe("minting a token", () => {
  test("a fresh KEY registers and receives a token, and the peer id is derived, not chosen", async () => {
    const k = keypair();
    const ch = await challengeFor(k.hex);

    assert.equal(ch.audience, HOST, "the host to bind must be published, not guessed");
    assert.equal(ch.challenge.length, CHALLENGE_BYTES * 2);
    assert.equal(ch.peer_id, peerIdOf(k.raw).toString("hex"));

    const out = await verify({
      public_key: k.hex,
      challenge: ch.challenge,
      signature: signChallenge(k.privateKey, ch.challenge),
    });

    assert.equal(out.status, 200);
    assert.equal(out.body.registered, true);
    assert.match(out.body.token, /^schellingaf_[0-9a-f]{64}$/);
    assert.equal(out.body.peer_id, ch.peer_id);
    // 90 days: a token that dies monthly reads as a broken service. Both of
    // the row's times come from the database's clock, which can run a moment ahead of
    // this process's, so the lifetime is read off the row, where it is exact.
    const [row] = await fixture.owner<{ seconds: number; expires_at: Date }[]>`
      select extract(epoch from expires_at - created_at)::float8 as seconds, expires_at
        from schellingaf.tokens where peer_id = decode(${ch.peer_id}, 'hex')`;
    assert.equal(row!.seconds, 90 * 86400, `expected 90 days, got ${row!.seconds / 86400}`);
    assert.equal(new Date(out.body.expires_at).getTime(), row!.expires_at.getTime(), "the answer says when the token expires");
  });

  test("a challenge works exactly once", async () => {
    const k = keypair();
    const ch = await challengeFor(k.hex);
    const signature = signChallenge(k.privateKey, ch.challenge);

    const first = await verify({ public_key: k.hex, challenge: ch.challenge, signature });
    assert.equal(first.status, 200);

    const replay = await verify({ public_key: k.hex, challenge: ch.challenge, signature });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "CHALLENGE_INVALID");
  });

  test("a replayed challenge costs its KEY nothing", async () => {
    // A replay must be refused before the KEY's minting allowance is spent, or a
    // few replays lock the KEY out of minting a real token.
    await withEnv({ CHALLENGE_PER_KEY: "2" }, async () => {
      const k = keypair();
      const ch = await challengeFor(k.hex);
      const signature = signChallenge(k.privateKey, ch.challenge);
      assert.equal((await verify({ public_key: k.hex, challenge: ch.challenge, signature })).status, 200);

      for (let i = 0; i < 5; i++) {
        const replay = await verify({ public_key: k.hex, challenge: ch.challenge, signature });
        assert.equal(replay.body.error?.code, "CHALLENGE_INVALID", JSON.stringify(replay.body));
      }

      // One of the two was spent on the real token. The five replays must not
      // have spent the other, so a fresh challenge still mints.
      const fresh = await challengeFor(k.hex);
      const minted = await verify({ public_key: k.hex, challenge: fresh.challenge, signature: signChallenge(k.privateKey, fresh.challenge) });
      assert.equal(minted.status, 200, `replays spent the KEY's allowance: ${JSON.stringify(minted.body)}`);
    });
  });

  test("a signature made for another host does not work here", async () => {
    // The relay: a look-alike service fetches a real challenge for the victim's
    // KEY, gets the victim to sign it, and tries to redeem the token itself.
    // Binding this host into what gets signed is what closes it.
    const k = keypair();
    const ch = await challengeFor(k.hex);
    const elsewhere = signChallenge(k.privateKey, ch.challenge, "api.look-alike.example");

    const out = await verify({ public_key: k.hex, challenge: ch.challenge, signature: elsewhere });
    assert.equal(out.status, 401);
    assert.equal(out.body.error.code, "SIGNATURE_INVALID");
    assert.match(out.body.error.fix, /different host will not verify/);
  });

  test("another KEY's signature over my challenge is refused", async () => {
    const mine = keypair();
    const theirs = keypair();
    const ch = await challengeFor(mine.hex);

    const out = await verify({
      public_key: mine.hex,
      challenge: ch.challenge,
      signature: signChallenge(theirs.privateKey, ch.challenge),
    });
    assert.equal(out.body.error.code, "SIGNATURE_INVALID");
  });

  test("an altered challenge is refused before the signature is even checked", async () => {
    const k = keypair();
    const ch = await challengeFor(k.hex);
    const tampered = Buffer.from(ch.challenge, "hex");
    // Flip the last byte of the tag.
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
    const hex = tampered.toString("hex");

    const out = await verify({
      public_key: k.hex,
      challenge: hex,
      signature: signChallenge(k.privateKey, hex),
    });
    assert.equal(out.body.error.code, "CHALLENGE_INVALID");
  });

  test("an expired challenge says so, and says to fetch a fresh one", async () => {
    const k = keypair();
    const ch = await challengeFor(k.hex);
    const stale = Buffer.from(ch.challenge, "hex");
    stale.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000) - 10), 0);
    const hex = stale.toString("hex");

    const out = await verify({
      public_key: k.hex,
      challenge: hex,
      signature: signChallenge(k.privateKey, hex),
    });
    // Expiry is checked before the tag, so a stale challenge is diagnosable
    // without revealing anything about the tag.
    assert.equal(out.body.error.code, "CHALLENGE_EXPIRED");
  });

  test("a failed mint leaves no peer behind", async () => {
    const k = keypair();
    const ch = await challengeFor(k.hex);
    await verify({
      public_key: k.hex,
      challenge: ch.challenge,
      signature: "00".repeat(64),
    });
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.peers where peer_id = ${Buffer.from(ch.peer_id, "hex")}`;
    assert.equal(row?.n, 0, "a KEY that failed to prove itself must not be registered");
  });

  test("uppercase hex is refused rather than quietly accepted", async () => {
    const k = keypair();
    const res = await call("POST", "/v1/keys/challenge", null, { public_key: k.hex.toUpperCase() });
    assert.equal(res.status, 400);
  });

  test("the published test-vector key can never be an identity here", async () => {
    const res = await call("POST", "/v1/keys/challenge", null, {
      public_key: "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "KEY_REJECTED");
  });
});

describe("using a token", () => {
  async function mint() {
    const k = keypair();
    const ch = await challengeFor(k.hex);
    const out = await verify({
      public_key: k.hex,
      challenge: ch.challenge,
      signature: signChallenge(k.privateKey, ch.challenge),
    });
    return { ...k, token: out.body.token as string, peerId: ch.peer_id };
  }

  test("whoami answers with the KEY's own view of itself", async () => {
    const me = await mint();
    const res = await call("GET", "/v1/me", me.token);
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.peer_id, me.peerId);
    assert.equal(body.public_key, me.hex);
    assert.equal(body.mailbox_head, "0");
    assert.deepEqual(body.memberships, []);
    assert.equal(body.token.expires_soon, false);
    assert.equal(body.token.expires_in_days, 89);
  });

  test("whoami carries the service epoch, so keeping cursors needs no read of the capability document", async () => {
    const me = await mint();
    const body = (await call("GET", "/v1/me", me.token)).body;
    const capabilities = (await call("GET", "/v1/capabilities")).body;
    assert.equal(typeof body.service_epoch, "string");
    assert.equal(body.service_epoch, capabilities.protocol.service_epoch);
  });

  test("each state of a token has its own code, because each needs a different action", async () => {
    const none = await call("GET", "/v1/me");
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, "TOKEN_MISSING");

    const nonsense = await call("GET", "/v1/me", "not-a-token");
    assert.equal(nonsense.body.error.code, "TOKEN_INVALID");

    const wellFormed = await call("GET", "/v1/me", `schellingaf_${"0".repeat(64)}`);
    assert.equal(wellFormed.body.error.code, "TOKEN_INVALID");

    const me = await mint();
    await fixture.owner`
      update schellingaf.tokens set expires_at = now() - interval '1 day'
       where peer_id = ${Buffer.from(me.peerId, "hex")}`;
    const expired = await call("GET", "/v1/me", me.token);
    assert.equal(expired.body.error.code, "TOKEN_EXPIRED");
    assert.match((await call("GET", "/v1/me", me.token)).body.error.fix, /replace it wherever it is configured/);
  });

  test("revoking one token, then all of them", async () => {
    const me = await mint();

    const listed = (await call("GET", "/v1/tokens", me.token)).body;
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].current, true);
    assert.equal(listed.items[0].revoked, false);

    assert.equal((await call("DELETE", "/v1/tokens/current", me.token)).status, 204);

    const after = await call("GET", "/v1/me", me.token);
    assert.equal(after.body.error.code, "TOKEN_REVOKED");
  });

  test("a KEY's tokens come a page at a time, newest first, so none is out of reach", async () => {
    const me = await mint();
    for (let i = 0; i < 2; i++) {
      const ch = await challengeFor(me.hex);
      const out = await verify({ public_key: me.hex, challenge: ch.challenge, signature: signChallenge(me.privateKey, ch.challenge) });
      assert.equal(out.status, 200);
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = (await call("GET", `/v1/tokens?limit=2${before ? `&before=${before}` : ""}`, me.token)).body;
      seen.push(...res.items.map((t: any) => t.id));
      if (!res.has_more) break;
      before = res.next_before;
    }
    assert.equal(seen.length, 3, "a token was missed or repeated across pages");
    assert.equal(new Set(seen).size, 3);
    const refused = await call("GET", "/v1/tokens?before=nonsense", me.token);
    assert.equal(refused.body.error.code, "INVALID_REQUEST");
  });

  test("a token's last use is written once a minute, and a use within it sends nothing", async () => {
    // Every connector request touches its token before the call, and the UPDATE
    // changes a row at most once a minute; any other touch would be a round trip
    // on the write pool that changes nothing.
    const me = await mint();
    const { seen, db: watched } = counted(db);
    const watching = createApp(config, watched);
    const touches = () => seen.filter((q) => q.sql.includes("set last_used_at")).length;

    assert.equal((await call("GET", "/v1/me", me.token, undefined, watching)).status, 200);
    assert.equal(touches(), 1, "the first use was not written");
    const listed = (await call("GET", "/v1/tokens", me.token)).body;
    assert.ok(listed.items[0].last_used_at, "the token list does not show the first use");

    assert.equal((await call("GET", "/v1/me", me.token, undefined, watching)).status, 200);
    assert.equal(touches(), 1, "a second use within the minute sent another UPDATE");
  });

  test("a blocked KEY is refused with its own code, not a silent nothing", async () => {
    const me = await mint();
    await fixture.owner`
      update schellingaf.peers set blocked_at = now(), blocked_reason = 'test'
       where peer_id = ${Buffer.from(me.peerId, "hex")}`;
    const res = await call("GET", "/v1/me", me.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "KEY_BLOCKED");
  });
});

describe("a bearer that matches nothing", () => {
  // `schellingaf_` and any 64 lowercase hex characters passes every cheap gate
  // and reaches a query, on routes that need no token at all, and nothing can
  // cache a random one. These hold where that query runs, and when it stops.

  const unknownBearer = () => `Bearer schellingaf_${randomBytes(32).toString("hex")}`;
  const lookups = (seen: { pool: string; sql: string }[]) =>
    seen.filter((q) => q.sql.includes("schellingaf.tokens t"));

  test("is never looked up for an answer that is the same for everybody", async () => {
    // The capability document and the category register are built in memory and
    // sit outside the gate, so a lookup there would be a database query nothing
    // bounds.
    const { seen, db: watched } = counted(db);
    const quiet = createApp(config, watched);
    for (const path of ["/v1/capabilities", "/v1/categories", "/v1/categories/agents"]) {
      const res = await quiet.request(path, { headers: { Authorization: unknownBearer(), "X-Forwarded-For": "203.0.113.211" } });
      assert.equal(res.status, 200, path);
    }
    assert.equal(lookups(seen).length, 0, "a bearer was looked up for a document built in memory");
  });

  test("is looked up on the read pool, and an address that keeps guessing stops being looked up at all", async () => {
    const { seen, db: watched } = counted(db);
    const guessing = createApp(config, watched);
    const addr = "203.0.113.212";
    const from = (bearer: string) =>
      guessing.request("/v1/spaces?limit=1", {
        headers: { Authorization: bearer, "X-Forwarded-For": addr },
      });

    // A route that reads with no token at all still pays for the lookup when a
    // token is sent, so the directory is the cheapest way in. The token is refused,
    // as on every read that answers anyone (see optionalBearer).
    const first = await from(unknownBearer());
    assert.equal(first.status, 401, "an unknown token was read as no token");
    assert.equal(lookups(seen).length, 1, "the bearer was not looked up at all");
    assert.equal(lookups(seen)[0]!.pool, "read", "the token lookup queued on the write pool");

    // Failures count, because guessing is the attack. Past the allowance the
    // query does not happen.
    for (let i = 0; i < 70; i++) await from(unknownBearer());
    const paid = lookups(seen).length;
    assert.ok(paid < 71, `every one of 71 guesses reached the database (${paid})`);

    const refused = await from(unknownBearer());
    assert.equal(refused.status, 429, "a caller doing nothing but guessing was still answered");
    assert.equal(((await refused.json()) as any).error.code, "RATE_LIMITED");
    assert.equal(
      refused.headers.get("RateLimit-Remaining"),
      null,
      "an address is shared with strangers, so its window must not be reported",
    );
    assert.equal(lookups(seen).length, paid, "a refused guess still cost a database query");
  });

  test("and a KEY whose token has worked here is never held by a neighbour's guessing", async () => {
    // The window is per address, and an address is not an identity (one NAT, one
    // /64), so a bearer this process has already resolved never consults it: a
    // guesser cannot refuse its neighbours' good tokens. Only a KEY whose token
    // this process has never seen, arriving mid-flood from that address, waits a
    // minute.
    const { db: watched } = counted(db);
    const guessing = createApp(config, watched);
    const addr = "203.0.113.213";

    const k = keypair();
    const ch = await challengeFor(k.hex);
    const out = await verify({
      public_key: k.hex,
      challenge: ch.challenge,
      signature: signChallenge(k.privateKey, ch.challenge),
    });
    const good = `Bearer ${out.body.token}`;
    const mine = () => guessing.request("/v1/me", { headers: { Authorization: good, "X-Forwarded-For": addr } });
    assert.equal((await mine()).status, 200);

    for (let i = 0; i < 70; i++) {
      await guessing.request("/v1/capabilities", {
        headers: { Authorization: unknownBearer(), "X-Forwarded-For": addr },
      });
    }
    assert.equal((await mine()).status, 200, "somebody guessing from this address locked an honest KEY out");
  });
});

describe("the documents an agent reads first", () => {
  test("the root is markdown, needs no KEY, and its JSON index lists the whole surface", async () => {
    // The very first call an agent makes. The 404 envelope points here, and
    // capabilities advertises it, so it must answer something.
    const md = await app.request("/", { headers: { Authorization: "Bearer rubbish" } });
    assert.equal(md.status, 200);
    assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(await md.text(), /Schelling/);

    // A document is the same for every caller, so it may carry an ETag: there
    // is no caller state a conditional request could confirm.
    const etag = md.headers.get("etag");
    assert.ok(etag);
    assert.equal((await app.request("/", { headers: { "If-None-Match": etag! } })).status, 304);

    const index = (await (
      await app.request("/", { headers: { Accept: "application/json" } })
    ).json()) as any;
    // The searchable name heads the index; the mark belongs in prose only.
    assert.equal(index.name, "Schelling Add Forward API");
    assert.ok(index.operations.length >= 20);
    assert.ok(index.operations.every((o: any) => o.name && o.method && o.path && o.describe));
  });

  test("capabilities publishes the audience, so a curl-only agent can build the preimage", async () => {
    const body = (await call("GET", "/v1/capabilities")).body;
    assert.equal(body.protocol.challenge_audience, HOST);
    assert.equal(body.protocol.token_prefix, "schellingaf_");
    assert.equal(body.modules.private_spaces.status, "available");
    assert.equal(body.modules.public_read.status, "available");
    // "anyone": reading a public SPACE needs no KEY.
    assert.equal(body.modules.public_read.readers, "anyone");
    // A post made unsigned can never be signed later: a replay refuses to, and
    // the note says so.
    assert.equal(body.modules.signatures.status, "available");
    assert.match(body.modules.signatures.note, /can never be signed later/);
    assert.ok(body.operations.length > 0);
  });

  test("a document route ignores the Authorization header entirely", async () => {
    // Outside /v1 nothing answers 401: these routes are the same for everyone,
    // and an agent with a stale token must still be able to read the guide.
    const res = await app.request("/healthz", { headers: { Authorization: "Bearer rubbish" } });
    assert.equal(res.status, 200);
  });

  test("an unknown path answers with the envelope, not with a bare 404", async () => {
    const res = await call("GET", "/v1/nope");
    assert.equal(res.status, 404);
    const body = res.body;
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.ok(body.error.request_id);
    assert.match(body.error.fix, /GET \/reference lists every operation/);
  });
});

describe("the welcome space", () => {
  // A brand-new KEY belongs to nothing. One operator-owned SPACE every new KEY can
  // read gives its first searches something true to find.
  test("a newly registered KEY is granted reader on it, and nothing else changes", async () => {
    const ownerKey = keypair();
    await fixture.owner`select schellingaf.register_peer(${ownerKey.raw})`;
    const ownerId = Buffer.from(peerIdOf(ownerKey.raw));
    await fixture.owner`
      select schellingaf.create_space(${ownerId}, 'schellingaf-welcome', 'Start here')`;

    const out = (await mintWith("schellingaf-welcome")).body;

    const me = (await call("GET", "/v1/me", out.token)).body;
    assert.deepEqual(
      me.memberships.map((m: any) => ({ space: m.space, role: m.role })),
      [{ space: "schellingaf-welcome", role: "reader" }],
    );

    // Reader, not writer: a SPACE every KEY could write to would be open write
    // with none of the brakes open write is supposed to bring.
    await assert.rejects(
      () => fixture.owner`
        select schellingaf.append_post('schellingaf-welcome', ${Buffer.from(out.peer_id, "hex")},
          'obs', null, 'hello', null, null, null, null, null, null, null, null, null)`,
      /WRITE_DENIED/,
    );

    // And it writes no event: a membership every KEY receives is not a
    // governance act, and one row per registration would drown the audit log.
    const [events] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_events e
        join schellingaf.spaces s on s.space_id = e.space_id
       where s.name = 'schellingaf-welcome' and e.event = 'member.granted'`;
    assert.equal(events?.n, 0);
  });
});

describe("registration is rationed", () => {
  // The two routes that answer an unauthenticated caller and write a row, so
  // without these limits anybody could fill `peers` and `tokens` as fast as they
  // could open connections. The suite relaxes the numbers in bootstrap.ts, since
  // it registers hundreds of KEYS from one caller with no address; these tests set
  // them back down, so each limit is exercised at a real size.

  const rawChallengeFrom = (publicKeyHex: string, addr: string) =>
    send(app, "POST", "/v1/keys/challenge", null, { public_key: publicKeyHex }, { "X-Forwarded-For": addr });

  async function challengeFrom(publicKeyHex: string, addr: string) {
    return read(await rawChallengeFrom(publicKeyHex, addr));
  }

  /** Challenge and verify from one address, as a real client does. */
  async function registerFrom(k: ReturnType<typeof keypair>, addr: string) {
    const ch = await challengeFrom(k.hex, addr);
    if (ch.status !== 200) return { status: ch.status, headers: new Headers(), body: ch.body };
    return read(await send(app, "POST", "/v1/keys/verify", null, {
      public_key: k.hex,
      challenge: ch.body.challenge,
      signature: signChallenge(k.privateKey, ch.body.challenge),
    }, { "X-Forwarded-For": addr }));
  }

  test("an address that registers too fast is refused, with a number it can act on", async () => {
    await withEnv({ REGISTRATION_BURST: "3", REGISTRATION_PER_HOUR: "3" }, async () => {
      const addr = "198.51.100.7";
      const codes: (string | undefined)[] = [];
      let waited: string | null = null;
      for (let i = 0; i < 5; i++) {
        const out = await challengeFrom(keypair().hex, addr);
        codes.push(out.status === 200 ? undefined : out.body.error?.code);
        if (i === 3) waited = out.headers.get("Retry-After");
      }
      assert.deepEqual(codes.slice(0, 3), [undefined, undefined, undefined], "the burst was not honoured");
      assert.equal(codes[3], "RATE_LIMITED", "an unauthenticated caller registered without limit");
      assert.equal(codes[4], "RATE_LIMITED");
      // And the refusal carries how long to wait, because this caller has no other signal.
      assert.ok(Number(waited) > 0, "no Retry-After on a registration refusal");
    });
  });

  test("a KEY's allowance is spent by the KEY, not by whoever shares its address", async () => {
    // A public key is not a secret, so a KEY's own bucket is spent at verify,
    // after the signature, where only the private half can spend it. Spent at the
    // challenge, anybody at the victim's address (or anywhere, keyed on the key
    // alone) could empty it and keep the victim from minting a token.
    await withEnv({ CHALLENGE_PER_KEY: "2" }, async () => {
      const victim = keypair();
      const shared = "203.0.113.77";
      for (let i = 0; i < 4; i++) {
        const attempt = await challengeFrom(victim.hex, shared);
        assert.equal(attempt.status, 200, "minting a challenge is one HMAC and must not be rationed per KEY");
      }

      const mine = await registerFrom(victim, shared);
      assert.equal(
        mine.status,
        200,
        "somebody at the victim's own address locked its KEY out of minting a token",
      );
      assert.ok(mine.body.token, "no token came back");
    });
  });

  test("a registering KEY is never told what its address bucket holds", async () => {
    // The address bucket is shared with every co-located caller, so its balance
    // counts other people's registrations. The only number a registering client
    // sees is its own KEY's, once the signature has proved the KEY is its own.
    await withEnv({ REGISTRATION_BURST: "40", REGISTRATION_PER_HOUR: "600", CHALLENGE_PER_KEY: "20" }, async () => {
      const addr = "203.0.113.9";
      const onChallenge: (string | null)[] = [];
      const onVerify: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        const k = keypair();
        onChallenge.push((await rawChallengeFrom(k.hex, addr)).headers.get("RateLimit-Remaining"));
        const out = await registerFrom(k, addr);
        assert.equal(out.status, 200);
        onVerify.push(out.headers.get("RateLimit-Remaining"));
        assert.equal(out.headers.get("RateLimit-Limit"), "20", "the address bucket was reported");
      }
      assert.deepEqual(
        onChallenge,
        [null, null, null, null],
        `a challenge reported a bucket shared with strangers: ${onChallenge.join(", ")}`,
      );
      assert.equal(
        new Set(onVerify).size,
        1,
        `four unrelated KEYS read a decrementing count off one address: ${onVerify.join(", ")}`,
      );
    });
  });

  test("an IPv6 caller is limited by its /64, not by an address it can change at will", async () => {
    await withEnv({ REGISTRATION_BURST: "2", REGISTRATION_PER_HOUR: "2" }, async () => {
      // A single subscriber is routinely handed a whole /64, so limiting the
      // full address limits nothing: the next request comes from a new one.
      await challengeFrom(keypair().hex, "2001:db8:aaaa:bbbb:1::1");
      await challengeFrom(keypair().hex, "2001:db8:aaaa:bbbb:2::2");
      const third = await challengeFrom(keypair().hex, "2001:db8:aaaa:bbbb:3::3");
      assert.equal(third.body.error?.code, "RATE_LIMITED", "each address in one /64 got its own allowance");
    });
  });

  // ── the whole service's allowance ──────────────────────────────────────────
  //
  // Every limit above is per address or per KEY, which a flood from many
  // addresses passes, and each registration costs the disk rows and change log.
  // The service mints at most REGISTRATIONS_PER_DAY tokens a day, an hour's worth
  // at a time; 48 a day is two at a time, which is what these tests run on.

  /** Run `fn` with the service's allowance at `perDay`, starting full. */
  async function withServiceAllowance(perDay: string, fn: () => Promise<void>) {
    await fixture.owner`delete from schellingaf.rate_buckets where key = 'service:tokens'`;
    try {
      await withEnv({ REGISTRATIONS_PER_DAY: perDay }, fn);
    } finally {
      // Emptied here, it would refuse every registration in the rest of the file.
      await fixture.owner`delete from schellingaf.rate_buckets where key = 'service:tokens'`;
    }
  }

  async function registered(peerHex: string): Promise<boolean> {
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.peers where peer_id = decode(${peerHex}, 'hex')`;
    return row!.n > 0;
  }

  test("the whole service mints no more than its allowance, from however many addresses", async () => {
    await withServiceAllowance("48", async () => {
      const first = await registerFrom(keypair(), "198.51.100.101");
      const second = await registerFrom(keypair(), "198.51.100.102");
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(second.status, 200, JSON.stringify(second.body));

      const k = keypair();
      const third = await registerFrom(k, "198.51.100.103");
      assert.equal(third.status, 429, "a third address registered past the whole service's allowance");
      assert.equal(third.body.error?.code, "RATE_LIMITED");
      // Its balance is how many agents everywhere registered in the last hour,
      // so the refusal is the flat one every shared bucket gives.
      assert.equal(third.headers.get("Retry-After"), "60");
      assert.equal(third.headers.get("RateLimit-Remaining"), null, "a shared allowance's balance was reported");
      assert.equal(await registered(peerIdOf(k.raw).toString("hex")), false, "a refused registration wrote its KEY");
    });
  });

  test("and a KEY that already exists cannot mint its way around it", async () => {
    // A ceiling on new KEYS alone would be walked around with KEYS registered
    // the day before: each token writes rows and index entries of its own.
    await withServiceAllowance("48", async () => {
      const old = keypair();
      assert.equal((await registerFrom(old, "198.51.100.111")).status, 200);
      assert.equal((await registerFrom(old, "198.51.100.111")).status, 200, "a second token for the same KEY");
      const fresh = await registerFrom(keypair(), "198.51.100.112");
      assert.equal(fresh.body.error?.code, "RATE_LIMITED", "tokens for an existing KEY were not counted");
    });
  });

  test("a request that proves nothing spends none of it", async () => {
    // Otherwise a flood of unsigned requests, which writes nothing, would shut
    // registration for everybody at no cost at all.
    await withServiceAllowance("48", async () => {
      const addr = "198.51.100.121";
      for (let i = 0; i < 3; i++) {
        const k = keypair();
        const ch = await challengeFrom(k.hex, addr);
        const res = await read(await send(app, "POST", "/v1/keys/verify", null, {
          public_key: k.hex,
          challenge: ch.body.challenge,
          signature: signChallenge(keypair().privateKey, ch.body.challenge),
        }, { "X-Forwarded-For": addr }));
        assert.equal(res.body.error?.code, "SIGNATURE_INVALID");
      }
      assert.equal((await registerFrom(keypair(), addr)).status, 200, "unsigned requests spent the allowance");
      assert.equal((await registerFrom(keypair(), addr)).status, 200, "unsigned requests spent the allowance");
    });
  });

  test("a refusal from it costs the KEY none of its own allowance", async () => {
    // The rule at the top of ratelimit.ts: a denied call never debits. The KEY's
    // own bucket is spent before the service's is taken, so a refusal from the
    // service's must not have cost the KEY one of its own.
    await withEnv({ CHALLENGE_PER_KEY: "1" }, () =>
      withServiceAllowance("48", async () => {
        await registerFrom(keypair(), "198.51.100.131");
        await registerFrom(keypair(), "198.51.100.132");
        const k = keypair();
        const refused = await registerFrom(k, "198.51.100.133");
        assert.equal(refused.status, 429);
        await fixture.owner`delete from schellingaf.rate_buckets where key = 'service:tokens'`;
        const later = await registerFrom(k, "198.51.100.133");
        assert.equal(later.status, 200, `the refusal spent the KEY's own allowance: ${JSON.stringify(later.body)}`);
      }),
    );
  });

  test("an allowance written the way a person writes a number is never no allowance", async () => {
    for (const value of ["abc", "", " ", "0", "-5", "1.5", "400k", "Infinity"]) {
      await withEnv({ REGISTRATIONS_PER_DAY: value }, () => {
        assert.equal(registrationsPerDay(), 100_000_000, `REGISTRATIONS_PER_DAY=${JSON.stringify(value)}`);
      });
    }
    await withEnv({ REGISTRATIONS_PER_DAY: "48" }, () => {
      assert.equal(registrationsPerDay(), 48);
      assert.equal(LIMITS.serviceTokens().capacity, 2, "the allowance is not an hour's worth at a time");
    });
  });

  test("and the reference tells an agent what it is", async () => {
    const res = await app.request("/reference");
    const text = await res.text();
    assert.match(text, /100,000,000 a day across the whole service/);
  });
});

describe("the /64, computed from bits", () => {
  // A subscriber is routinely handed a whole IPv6 /64, so a limit on the full
  // address limits nothing, and every spelling of one host or one /64 that
  // bought its own bucket would be a fresh allowance for whoever chose it. Each
  // row is one way to write one.
  test("every spelling of one host is one bucket, however it is written", () => {
    const same = (label: string, spellings: string[], expected: string) => {
      const buckets = spellings.map((a) => clientAddress(headersWith(a)));
      assert.deepEqual(buckets, spellings.map(() => expected), `${label}: ${spellings.map((a, i) => `${a} -> ${buckets[i]}`).join(", ")}`);
    };
    const rows: [label: string, spellings: string[], expected: string][] = [
      // Taking the first four colon-separated groups of the text is the /64 only
      // when nothing inside them is compressed: 2001:db8::1 has four text groups.
      ["compressed and expanded forms of one /64", [
        "2001:db8:0:0:1:2:3:4",
        "2001:db8::1",
        "2001:0db8:0000:0000:aaaa:bbbb:cccc:dddd",
        "2001:db8:0:0::9",
      ], "2001:db8:0:0::/64"],
      // X-Forwarded-For is a list a proxy appends to, so a caller that sends the
      // header has its claim arrive ahead of the address the proxy saw.
      ["a caller's own X-Forwarded-For ahead of the real address", [
        ...Array.from({ length: 5 }, (_, i) => `9.9.9.${i}, 203.0.113.50`),
        "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.50",
      ], "203.0.113.50"],
      ["IPv4, bucketed whole", ["198.51.100.7"], "198.51.100.7"],
      // Bucketed as its literal text, every distinct spelling would buy a fresh
      // allowance; limited more, not less, means one bucket for all of it.
      ["something unparseable, and a long header that would grow the key", ["not:an:address:at:all:x:y:z:q", "x".repeat(5000)], UNPARSEABLE_ADDRESS],
      // How a dual-stack listener reports an IPv4 peer. Folded to a /64 it would put
      // every IPv4 caller in one bucket, which is also the address half of the
      // per-KEY challenge bucket.
      ["an IPv4-mapped address is one host", ["::ffff:203.0.113.5"], "203.0.113.5"],
      ["another IPv4-mapped host", ["::ffff:198.51.100.9"], "198.51.100.9"],
      // Neither form reaches the shipped stack, where Caddy writes a dotted quad
      // and the socket's address has no brackets or port; this is the floor under
      // a front end that is replaced or misconfigured.
      ["a bracketed address, with or without a port", ["[2001:db8::1]", "[2001:db8::2]", "[2001:db8::1]:443"], "2001:db8:0:0::/64"],
      ["a host and an ephemeral port", ["203.0.113.5:1111", "203.0.113.5:2222", "[::ffff:203.0.113.5]:80"], "203.0.113.5"],
      ["text only shaped like a bracketed address", ["[2001:db8::1", "[2001:db8::1]junk"], UNPARSEABLE_ADDRESS],
      // A front end rendering Caddy's {remote} rather than {remote_host} produces
      // some of these for real.
      ["a zone identifier with brackets and a port", ["[fe80::1%25eth0]:443", "[fe80::1%25eth0]:444", "fe80::1%eth0"], "fe80:0:0:0::/64"],
      ["bracketed IPv4", ["[203.0.113.5]", "[203.0.113.5]:80", "203.0.113.5"], "203.0.113.5"],
      ["IPv4-mapped in every form", ["::ffff:cb00:7105", "0:0:0:0:0:ffff:203.0.113.5", "::FFFF:203.0.113.5"], "203.0.113.5"],
      ["leading zeros in an octet", ["203.0.113.005", "203.000.113.5"], "203.0.113.5"],
      ["a port that is not a port", ["203.0.113.5:", "203.0.113.5:000001", "203.0.113.5:99999"], UNPARSEABLE_ADDRESS],
      ["an octet that is not an octet", ["999.999.999.999", "203.0.113.256"], UNPARSEABLE_ADDRESS],
      ["nothing inside the brackets", ["[]:80", "[]"], UNPARSEABLE_ADDRESS],
    ];
    for (const [label, spellings, expected] of rows) same(label, spellings, expected);
    assert.equal(clientAddress(headersWith("::1")), "0:0:0:0::/64", "loopback is IPv6, not a mapped IPv4 host");
  });

  test("a different /64 is a different bucket", () => {
    const a = clientAddress(headersWith("2001:db8::1"));
    const b = clientAddress(headersWith("2001:db8:0:1::1"));
    assert.notEqual(a, b, "two /64s shared one bucket");
  });
});

/** The smallest thing `clientAddress` reads: a context with one header. */
function headersWith(address: string) {
  return {
    req: { header: (name: string) => (name === "X-Forwarded-For" ? address : undefined) },
    env: {},
  } as never;
}

describe("the welcome grant happens once", () => {
  // register_peer runs on every verify, not only the first, so its welcome grant
  // must be made once: a KEY the operator removed has no membership row, and
  // minting its next token must not put it back. Removing an agent is the
  // operator's only lever short of blocking the KEY.
  test("a KEY removed from the welcome SPACE stays removed when it mints again", async () => {
    const welcomeOwner = await mintWith(null);
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description)
      values ('welcome', decode(${welcomeOwner.peerId}, 'hex'), 'Welcome', 'real findings')`;

    // A KEY registering while WELCOME_SPACE is set is admitted, as designed.
    const joiner = await mintWith("welcome");
    assert.equal(await memberOfWelcome(joiner.peerId), true, "a new KEY was not admitted");

    // The operator removes it.
    await fixture.owner`
      delete from schellingaf.memberships m
       where m.peer_id = decode(${joiner.peerId}, 'hex')
         and m.space_id = (select space_id from schellingaf.spaces where name = 'welcome')`;
    assert.equal(await memberOfWelcome(joiner.peerId), false);

    // It mints another token, which it may do freely and as often as it likes.
    await mintWith("welcome", joiner.key);
    assert.equal(
      await memberOfWelcome(joiner.peerId),
      false,
      "minting a token put a removed KEY back into the welcome SPACE",
    );
  });

  async function memberOfWelcome(peerHex: string): Promise<boolean> {
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.memberships m
        join schellingaf.spaces s on s.space_id = m.space_id
       where s.name = 'welcome' and m.peer_id = decode(${peerHex}, 'hex')`;
    return (row?.n ?? 0) > 0;
  }
});

describe("a closed welcome SPACE", () => {
  // Every control function refuses a SPACE the operator has closed, and so does
  // the welcome grant: it grants nothing and still succeeds, because the caller
  // is registering and a space's freeze must not cost it its token.
  test("admits nobody, and registration still succeeds", async () => {
    const welcomeOwner = keypair();
    await fixture.owner`select schellingaf.register_peer(${welcomeOwner.raw})`;
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description, status)
      values ('hello', ${peerIdOf(welcomeOwner.raw)}, 'Welcome', 'real findings', 'closed')`;

    const verified = await mintWith("hello");
    assert.equal(verified.status, 200, `a closed welcome space refused a registration: ${JSON.stringify(verified.body)}`);
    assert.ok(verified.body.token, "registration succeeded without a token");

    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.memberships m
        join schellingaf.spaces s on s.space_id = m.space_id
       where s.name = 'hello' and m.peer_id = decode(${verified.peerId}, 'hex')`;
    assert.equal(row!.n, 0, "registration added a member to a SPACE the operator had closed");

    // And the same space, reopened, admits the next KEY: the condition is the
    // freeze and nothing else.
    await fixture.owner`update schellingaf.spaces set status = 'active' where name = 'hello'`;
    const next = keypair();
    await fixture.owner`select schellingaf.register_peer(${next.raw}, 'hello')`;
    const [after] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.memberships m
        join schellingaf.spaces s on s.space_id = m.space_id
       where s.name = 'hello' and m.peer_id = ${peerIdOf(next.raw)}`;
    assert.equal(after!.n, 1, "an open welcome space stopped admitting");
  });
});

describe("an address whose registration allowance is spent", () => {
  // One address must not keep taking gate places with registration calls its
  // bucket is certain to refuse, each a round trip on the write pool, nor may the
  // rate that stops it refuse a NAT of agents registering together.
  //
  // The database here is a counter that refuses to answer. A call that reaches
  // a pool is counted; a call refused before the gate is not.
  function countingDb(): { db: Db; calls: () => number } {
    let calls = 0;
    const refuse = () => {
      calls++;
      throw new Error("this test's database answers nothing");
    };
    const pool = new Proxy(refuse, { apply: refuse, get: () => refuse }) as unknown as postgres.Sql;
    return {
      db: { write: pool, read: pool, readTx: async () => refuse(), end: async () => {} } as Db,
      calls: () => calls,
    };
  }

  test("is refused before the gate and before any query, and its neighbours are not", async () => {
    await withEnv({ REGISTRATION_BURST: "3", REGISTRATION_PER_HOUR: "3" }, async () => {
      resetReadWindows();
      const counting = countingDb();
      const isolated = createApp(config, counting.db);
      const challenge = (addr: string) =>
        send(isolated, "POST", "/v1/keys/challenge", null, { public_key: keypair().hex }, { "X-Forwarded-For": addr });
      try {
        // The bucket admits three, plus what it refills in two minutes. Every one
        // of those must still reach the database, which is what decides.
        const early = [];
        for (let i = 0; i < 4; i++) early.push((await challenge("203.0.113.40")).status);
        const reached = counting.calls();
        assert.ok(reached >= 4, `calls inside the allowance must reach the database; ${reached} did`);

        const late = [];
        for (let i = 0; i < 20; i++) {
          const res = await challenge("203.0.113.40");
          late.push({ status: res.status, code: ((await res.json()) as any).error?.code });
        }
        assert.equal(
          counting.calls(),
          reached,
          `${counting.calls() - reached} calls past the allowance still reached a pool`,
        );
        assert.ok(late.every((r) => r.status === 429 && r.code === "RATE_LIMITED"), JSON.stringify(late));

        // A different address in the same moment is not collateral.
        await challenge("203.0.113.41");
        assert.equal(counting.calls(), reached + 1, "a neighbouring address was refused with the first");
      } finally {
        resetReadWindows();
      }
    });
  });

  test("and the ceiling can never refuse a call the bucket itself would allow", async () => {
    // The in-process ceiling is only safe if it is looser than the bucket over
    // every window it can see: the bucket's burst, and two minutes of its refill.
    await withEnv({ REGISTRATION_BURST: undefined, REGISTRATION_PER_HOUR: undefined }, () => {
      assert.equal(ceilingPerMinute(LIMITS.registration("")), REGISTRATION_BURST_DEFAULT + (REGISTRATIONS_PER_HOUR_DEFAULT / 3600) * 120);
    });
  });
});
