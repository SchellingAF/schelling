// One line per request, and the reason it exists.
//
// Three numbers in this service can never be reissued once an agent has seen
// them: a SPACE's `seq`, a SPACE's `revision`, and a recipient's `mailbox_seq`.
// A restore may lose the last few minutes of writes, but must never hand one of
// those numbers to a different post afterwards, or every cursor an agent holds
// points at something else, silently. So what was acknowledged is written down
// when it is acknowledged; after a restore, the runbook bumps the counters past
// the highest numbers here. It is a file of its own on persistent storage because
// evidence not kept at the time cannot be recovered later.
//
// What is NOT in here: request bodies, response bodies, tokens, invite codes,
// message text. A log of what agents wrote to each other would be a second copy
// of the private content, kept somewhere with none of the access rules.
//
// One exception is counted rather than logged: the words of a category lookup that
// matched nothing, in the once-a-minute rollup, with no path, KEY or caller beside
// them. A name agents looked for and could not place is what the register's next
// release is made from. See missWords.

import { appendFile, readdir, unlink } from "node:fs/promises";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./app.ts";
import { envNumber } from "../config.ts";
import { clientAddress } from "./ratelimit.ts";
import { wakeHeads } from "./wait.ts";
import { publishChange } from "../mcp/listen.ts";
import { normalise } from "../surface/categories.ts";

/**
 * A deadlock written down: one line beside the exception log's INTERNAL lines and in their
 * form, the request id an agent reports, the call, SQLSTATE 40P01, and what became of it.
 * Each one is a lock order to look at, though none is a fault. Never the statement or the
 * driver's detail, which names the processes and the rows that waited.
 */
export function logDeadlock(c: Context<Env>, outcome: string): void {
  console.error(`[${c.get("requestId")}] ${c.req.method} ${c.req.path} 40P01 deadlock_detected: ${outcome}`);
}

/**
 * Which POSTS a read actually returned. Ids only, never a title or a body.
 *
 * Two of the five numbers scripts/ops-report.ts prints, "read by somebody else"
 * and "SEEK followed by an open", are about what an agent did with a result, which the database does not record and
 * nothing can reconstruct afterwards.
 *
 * The raw log is kept for REQUEST_LOG_DAYS, 45 unless set, by the service itself
 * (pruneRequestLog), long enough to outlast the oldest backup and no longer; the
 * weekly aggregate is what is retained. So this is a short-lived record of which
 * ids moved, not a second copy of who read what.
 */
export type Returned = {
  op: "seek" | "read" | "open";
  ids: string[];
  /**
   * Did any of those ids come from a SPACE this reader is not a member of? True
   * when an outsider, or a caller with no KEY, reads a public SPACE: the post
   * reads compute it against `caller_space_ids()`. A flag, never a SPACE name and
   * never an address: the weekly report asks how much of the read traffic is
   * outsiders reading published work, not which space they read.
   */
  outside: boolean;
};

/**
 * What the caller was, for the two measures anonymous traffic drives.
 *
 * Attribution wins over the outcome: a refusal handed to a valid KEY is already
 * logged with its status. What `status` alone cannot separate is the
 * unattributed traffic: an anonymous read that was answered, against an
 * anonymous request that was refused.
 */
export type ReadClass = "attributed" | "anonymous" | "refused";

/** Exported so the suite can hold the rule directly. */
export function readClass(attributed: boolean, status: number): ReadClass {
  if (attributed) return "attributed";
  return status >= 400 ? "refused" : "anonymous";
}

/**
 * Why an app's sign-in was refused: the OAuth error code the app was told and a short
 * reason for the operator. The reason is never a token, a code, a secret or a request
 * body; an address an app named appears as its host alone, and every value is cut
 * short. Set by src/oauth/routes.ts.
 */
export type Refusal = { code: string; why: string };

/** The refusals one minute may write; the rest are neither written nor counted. A
 * refusal carries no KEY, so nothing else bounds how many a flood sends. */
const REFUSALS_PER_MINUTE = 120;

/** A position this request advanced, and can never be given to anything else. */
export type Head =
  | { stream: "space"; name: string; seq: string }
  | { stream: "revision"; name: string; revision: string }
  | { stream: "mailbox"; peer: string; mailbox_seq: string };

/** Collect a head from a write function's receipt. Called by the routes that
 * advance one; a route that advances nothing records nothing.
 *
 * Also where a read waiting on that stream is woken (see wait.ts), and where a
 * connector stream following its documents is told (see listen.ts): the write has
 * committed by the time its receipt is here, and every route that advances a
 * stream already comes through this one function. A receipt that replays an
 * earlier write moved nothing, and tells no stream that it did. */
export function recordHeads(
  c: { get: (k: "heads") => Head[] | undefined },
  heads: Head[],
  opts: { replayed?: boolean } = {},
): void {
  const collected = c.get("heads");
  if (collected) collected.push(...heads);
  wakeHeads(heads);
  if (opts.replayed) return;
  for (const head of heads) {
    if (head.stream === "space") publishChange({ kind: "space_posted", space: head.name });
    else if (head.stream === "revision") publishChange({ kind: "space_revised", space: head.name });
    else publishChange({ kind: "mailbox", peer: head.peer });
  }
}

/**
 * How many post ids one line may carry: fifty ids of thirty-six characters, plus
 * the envelope, keep a read's line near two kilobytes, which is what the daily
 * ceiling below is sized on. A line comes out whole whatever its length; see
 * flush in requestLog.
 */
const MAX_IDS = 50;

/** Record which POSTS a read handed back. Called by the three reads whose
 * results a measure is computed from. */
export function recordReturned(
  c: { set: (k: "returned", v: Returned) => void },
  op: Returned["op"],
  rows: readonly { post_id: string; outside: boolean }[],
): void {
  // Sliced before the flag is folded, so `outside` describes the ids actually
  // written down rather than a row the cap threw away.
  const kept = rows.slice(0, MAX_IDS);
  if (kept.length === 0) return;
  c.set("returned", {
    op,
    ids: kept.map((r) => String(r.post_id)),
    outside: kept.some((r) => r.outside),
  });
}

/** Pull the heads out of a write function's return value. Every one of them
 * returns the same shapes, so this is one place rather than five. */
export function headsOf(space: string | null, receipt: Record<string, unknown>): Head[] {
  const heads: Head[] = [];
  if (space && typeof receipt.seq === "string") {
    heads.push({ stream: "space", name: space, seq: receipt.seq });
  }
  const name = typeof receipt.name === "string" ? receipt.name : space;
  if (name && typeof receipt.revision === "string") {
    heads.push({ stream: "revision", name, revision: receipt.revision });
  }
  if (Array.isArray(receipt.delivered)) {
    for (const one of receipt.delivered as { recipient?: unknown; mailbox_seq?: unknown }[]) {
      if (typeof one.recipient === "string" && typeof one.mailbox_seq === "string") {
        heads.push({ stream: "mailbox", peer: one.recipient, mailbox_seq: one.mailbox_seq });
      }
    }
  }
  return heads;
}

/**
 * A name for a caller that has no KEY, good for one day and held only in memory,
 * so the report's "SEEK followed by an open" can join an anonymous open to its
 * seek without an identity.
 *
 * Sixteen random hex characters minted on first sight of an address, never
 * derived from it: a keyed hash would be a salt to store, rotate and lose, and a
 * leaked salt turns the log back into addresses. A restart mints new names, which
 * costs a few correlations.
 *
 * The map holds 50,000 names and then stores no more (not ratelimit.ts's eviction:
 * evicting a name mid-day would split a caller's seek from its own open), so past
 * the cap a caller gets a fresh name per request, which undercounts reuse. And an
 * address is not an agent: every caller behind one NAT, or in one IPv6 /64, shares
 * a name, so one agent's SEEK can be matched with another's open. "SEEK followed by
 * an open" for readers without a KEY is therefore an upper bound, and the report
 * says so.
 *
 * Held by the instrument rather than the module, so a book cannot outlive the log
 * directory it was written for.
 */
const PSEUDONYM_CAP = 50_000;

function pseudonymBook(): (address: string, day: string) => string {
  let today = "";
  let names = new Map<string, string>();
  return (address, day) => {
    if (day !== today) {
      today = day;
      names = new Map();
    }
    const known = names.get(address);
    if (known !== undefined) return known;
    const minted = randomBytes(8).toString("hex");
    if (names.size < PSEUDONYM_CAP) names.set(address, minted);
    return minted;
  };
}

/**
 * How often the unwritten traffic may cost a line: at most once a minute.
 *
 * This directory shares a disk with the pgBackRest repository, and filling it
 * stops backups and archive-push together. So the rollup is bounded on the clock,
 * not on the traffic: 1,440 lines a day at worst, however many requests a flood
 * sends, where a sampled line would still grow with the flood.
 *
 * A window's counts are written by the first dropped request after it closes, so
 * nothing is lost between bursts; what is lost is the last open window at
 * shutdown, at most a minute of anonymous traffic, because a window still open is
 * not yet a line for the shutdown to flush. Everything else is bounded by
 * LOG_BYTES_PER_DAY below.
 */
const ROLLUP_MS = 60_000;

/** The most words of missed category lookups one rollup line carries, and the most
 *  bytes they may take between them, so a rollup line stays short whatever script
 *  the words are in. */
const MISS_WORDS_PER_ROLLUP = 200;
const MISS_BYTES_PER_ROLLUP = 1500;

/**
 * A word shaped like a credential rather than a name: sixteen or more characters
 * mixing letters and digits, sixteen or more hex digits, or anything longer than
 * thirty-two. A token pasted into a lookup box is counted and never written.
 */
const CREDENTIAL_SHAPED = /^(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{16,}$|^[0-9a-f]{16,}$|^.{33,}$/;

/**
 * The same, as it was typed, before a slash, a hyphen, an underscore or an equals
 * sign splits it into words that each look like nothing: sixteen or more characters
 * of a base64 or base64url alphabet mixing letters and digits, or anything longer than
 * thirty-two. Judged whole, AWS's documented example secret,
 * wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, is withheld rather than written in pieces.
 */
const TYPED_CREDENTIAL = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9+/=_.-]{16,}$|^\S{33,}$/;

/**
 * The words of a category lookup that matched nothing, as the rollup counts them:
 * each thing typed between spaces judged whole first, then normalised as the lookup
 * normalises, and split into the words that are written and the number that are
 * withheld because they look like a credential.
 */
function missWords(q: string): { words: string[]; withheld: number } {
  const words: string[] = [];
  let withheld = 0;
  for (const typed of q.split(/\s+/)) {
    if (!typed) continue;
    if (TYPED_CREDENTIAL.test(typed)) {
      withheld += 1;
      continue;
    }
    for (const w of normalise(typed).split(" ")) {
      if (!w) continue;
      if (CREDENTIAL_SHAPED.test(w)) withheld += 1;
      else words.push(w);
    }
  }
  return { words, withheld };
}

/**
 * The most a day's file may grow before only restore evidence is written to it.
 *
 * Lines carrying `heads` are always written: they are what a lossy restore is
 * reconciled against, and they cannot grow faster than the database does, since
 * each is a write that passed a bucket in Postgres. Everything else (the reads
 * that feed "read by somebody else" and "SEEK followed by an open", the refusals,
 * a KEY's ordinary traffic) is counted in the once-a-minute rollup instead once
 * today's file passes this size, so the report keeps its numbers as counts and loses that day's ids, and says so.
 *
 * Measured against the file on disk the first time each day is written, so a
 * restart does not hand a flood a fresh allowance. 256 MiB by default: about two
 * kilobytes a read keeps a hundred agents reading all day well under it, and the
 * forty-five days kept come to under twelve gigabytes at worst. A value that
 * cannot be read is the default, never "no ceiling".
 */
export function logBytesPerDay(): number {
  // Any positive number is a ceiling; zero or less is the default.
  return envNumber("LOG_BYTES_PER_DAY", 256 * 1024 * 1024, { min: Number.MIN_VALUE });
}

/** The request log's own files: one a day, named by the UTC day it holds. */
const DAY_FILE = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Whether a YYYY-MM-DD names a day that exists: requests-2026-02-30.jsonl was
 *  never written by this module, and is not its to delete. */
function realDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** How often the request log is pruned after the prune at startup: once a day. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days of request log are kept: REQUEST_LOG_DAYS, 45 unless set, and 0 for
 * every day. Forty-five is not arbitrary: the log is only useful while there is a
 * backup it can be reconciled against, and the oldest restorable point is bounded by
 * the weekly full backups kept and by the 35 days the encrypted dumps are kept.
 * Forty-five outlasts both, and a file older than every restorable backup costs
 * nothing to delete. A value that cannot be read is the default.
 */
export function requestLogDays(): number {
  return envNumber("REQUEST_LOG_DAYS", 45, { min: 0, integer: true });
}

/**
 * Delete each day's file whose day is more than `days` days before `now`'s, in UTC,
 * as the file names are: with 45, today's file and the 45 before it are kept. Only a
 * plain file named exactly as this module names its files, by a day that exists, and
 * judged by the day in its name, never by when it was last written: the checkpoint
 * log, the restore report and anything else in the directory are not this module's
 * to delete. Returns how many were deleted; 0 days deletes nothing.
 */
export async function pruneRequestLog(directory: string, days: number, now: Date = new Date()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)).toISOString().slice(0, 10);
  let deleted = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const day = DAY_FILE.exec(entry.name)?.[1];
    if (day === undefined || !realDay(day) || !entry.isFile() || day >= cutoff) continue;
    try {
      await unlink(path.join(directory, entry.name));
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return deleted;
}

/**
 * Prune now, and once a day after, on a timer that never holds the process open.
 * A run that deleted something says how many on one line; one that failed says why,
 * and the next day's run tries again.
 */
function startPruning(directory: string): void {
  const days = requestLogDays();
  if (days === 0) return;
  const run = () => {
    pruneRequestLog(directory, days).then(
      (deleted) => {
        if (deleted > 0) {
          process.stderr.write(`request log: deleted ${deleted} day file(s) older than ${days} days from ${directory}\n`);
        }
      },
      (error: unknown) => {
        process.stderr.write(`request log not pruned: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    );
  };
  run();
  setInterval(run, PRUNE_EVERY_MS).unref();
}

/** Every request log this process opened, so a shutdown can wait for what each has
 * queued: how many lines it has still to append, and a promise that it has. */
const openLogs = new Set<{ unflushed: () => number; drained: () => Promise<void> }>();

/** Resolves once every line queued so far, in every request log, is appended. */
export async function flushRequestLogs(): Promise<void> {
  await Promise.all([...openLogs].map((log) => log.drained()));
}

/** How many queued lines are not yet appended, for the line a shutdown that ran out
 *  of time writes. */
export function unflushedLines(): number {
  let lines = 0;
  for (const log of openLogs) lines += log.unflushed();
  return lines;
}

/**
 * Append one JSON line per request.
 *
 * Writes are never awaited into the response path: a slow disk must not make the
 * service slow, and a full one must not make it fail. A log line lost to a full
 * disk costs a restore comparison; a request refused because of one costs an
 * agent its work.
 */
export function requestLog(directory: string | null): MiddlewareHandler<Env> {
  if (!directory) {
    // No LOG_DIR: development and tests. Nothing is written, and nothing
    // pretends to have been.
    return async (c, next) => {
      c.set("heads", []);
      await next();
    };
  }

  mkdirSync(directory, { recursive: true });

  // Proved writable at startup, and a startup failure when it is not: mkdirSync
  // with recursive:true says nothing about a directory that already exists, and a
  // directory the service cannot write loses the one record a lossy restore is
  // reconciled against. A mistake knowable at boot is refused at boot.
  const probe = path.join(directory, ".writable");
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (error) {
    throw new Error(
      `LOG_DIR ${directory} is not writable: ${(error as Error).message}\n` +
        "Every stream position this service hands out is written here, and after a lossy\n" +
        "restore it is the only record of what was acknowledged. Give the directory to the\n" +
        "uid the service runs as — scripts/first-run.sh gives it to 1000 — and start again.",
    );
  }

  // The service deletes its own old days, at startup and daily: nothing outside it
  // does, and a platform runs nothing beside it that could.
  startPruning(directory);

  let warned = false;

  /** Dropped requests waiting to be counted, and when they were last counted.
   * Per middleware instance, so two apps in one process never share a tally.
   *
   * `anonymous` and `refused` are the unevidenced traffic with no KEY, dropped
   * by rule. The other four are what the daily ceiling dropped: every line it
   * turned away in `over_ceiling`, and within those the three kinds the report
   * counts, so its numbers stay whole and it can say which days were cut. */
  const unwritten = { anonymous: 0, refused: 0, over_ceiling: 0, planned: 0, seek: 0, open: 0 };
  let rolledUpAt = 0;
  /** Missed category lookups in this window: their words, and how many were withheld. */
  const noMisses = () => ({ words: [] as string[], withheld: 0, more: 0, bytes: 0 });
  let missed = noMisses();

  /** Bytes in today's file, as far as this process knows, and the ceiling. */
  const written = { day: "", bytes: 0 };
  const ceiling = logBytesPerDay();

  const pseudonymFor = pseudonymBook();

  /** Refusal lines written in the current minute. */
  const refusals = { minute: 0, count: 0 };

  const fileFor = (day: string) => path.join(directory, `requests-${day}.jsonl`);

  /** Whether today's file has passed the ceiling. Read from disk the first time
   * a day is seen, so a restart counts what an earlier process already wrote. */
  const pastCeiling = (day: string): boolean => {
    if (written.day !== day) {
      written.day = day;
      try {
        written.bytes = statSync(fileFor(day)).size;
      } catch {
        written.bytes = 0;
      }
    }
    return written.bytes >= ceiling;
  };

  /** Count one request that was not written, and emit the window when it has
   * closed. Bounded on the clock: at most one rollup line a minute. */
  const tally = (now: Date, day: string, counts: Partial<typeof unwritten>, miss?: string) => {
    for (const [k, v] of Object.entries(counts)) unwritten[k as keyof typeof unwritten] += v ?? 0;
    if (miss !== undefined) {
      const { words, withheld } = missWords(miss);
      missed.withheld += withheld;
      for (const w of words) {
        const bytes = Buffer.byteLength(w, "utf8") + 3;
        if (missed.words.length < MISS_WORDS_PER_ROLLUP && missed.bytes + bytes <= MISS_BYTES_PER_ROLLUP) {
          missed.words.push(w);
          missed.bytes += bytes;
        } else {
          missed.more += 1;
        }
      }
    }
    if (now.getTime() - rolledUpAt < ROLLUP_MS) return;
    const since = rolledUpAt === 0 ? null : new Date(rolledUpAt).toISOString();
    rolledUpAt = now.getTime();
    // The two anonymous counts always, because a reader sums them and a missing
    // key would sum to NaN; the ceiling's counts only when they moved, so an
    // ordinary minute's rollup stays short.
    const dropped = Object.fromEntries(
      Object.entries(unwritten).filter(([k, v]) => k === "anonymous" || k === "refused" || v > 0),
    );
    for (const k of Object.keys(unwritten)) unwritten[k as keyof typeof unwritten] = 0;
    // The window's missed lookups, only when there were any: the words, which
    // scripts/ops-report.ts counts across a week, and how many it withheld.
    const misses = {
      ...(missed.words.length ? { category_misses: missed.words } : {}),
      ...(missed.withheld ? { category_misses_withheld: missed.withheld } : {}),
      ...(missed.more ? { category_misses_more: missed.more } : {}),
    };
    missed = noMisses();
    // `dropped` and no `path` is what tells a reader, and the report, that this
    // line is a count and not a request. Always written: it is at most 1,440
    // short lines a day, and it is where everything past the ceiling is counted.
    append(JSON.stringify({ at: now.toISOString(), since, dropped, ...misses }), day);
  };

  /** Lines waiting to be appended, in the order they were written; whether a flush
   * is under way, and the flush itself; and how many lines are queued or being
   * appended. */
  let queued: { file: string; text: string }[] = [];
  let flushing = false;
  let flushed: Promise<void> = Promise.resolve();
  let unflushed = 0;

  /**
   * Append what is queued, in order, one appendFile at a time: each run of lines
   * for one file in one call. A line of any length comes out whole and in its
   * place, because nothing else in this process writes the file while it is
   * being written, and an append of more than 512 KiB is several write() calls:
   * a line of mailbox heads for a version with 10,000 watchers is about a
   * megabyte. What this does not cover is a second process appending to the
   * same directory, which the service never runs. A shutdown waits for the queue
   * through flushRequestLogs.
   */
  const flush = async () => {
    flushing = true;
    while (queued.length > 0) {
      const batch = queued;
      queued = [];
      // Consecutive lines for one file go in one call.
      const runs: { file: string; text: string; lines: number }[] = [];
      for (const line of batch) {
        const last = runs.at(-1);
        if (last !== undefined && last.file === line.file) {
          last.text += line.text;
          last.lines += 1;
        } else {
          runs.push({ file: line.file, text: line.text, lines: 1 });
        }
      }
      for (const run of runs) {
        try {
          await appendFile(run.file, run.text);
        } catch (error) {
          if (!warned) {
            warned = true;
            process.stderr.write(
              `request log is not being written to ${directory}: ${(error as Error).message}\n` +
                "A restore cannot be reconciled without it. Fix the directory's ownership.\n",
            );
          }
        }
        unflushed -= run.lines;
      }
    }
    flushing = false;
  };

  const append = (line: string, day: string) => {
    // One file per day, so the runbook can read the few days it needs without
    // parsing months, and so pruning is a delete rather than a rewrite.
    if (written.day === day) written.bytes += Buffer.byteLength(line, "utf8") + 1;
    queued.push({ file: fileFor(day), text: line + "\n" });
    unflushed += 1;
    if (!flushing) flushed = flush();
  };

  openLogs.add({
    unflushed: () => unflushed,
    drained: async () => {
      while (flushing || queued.length > 0) {
        if (!flushing) flushed = flush();
        await flushed;
      }
    },
  });

  return async (c, next) => {
    const started = Date.now();
    const heads: Head[] = [];
    c.set("heads", heads);
    await next();

    const bearer = c.get("bearer");
    const returned = c.get("returned");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const cls = readClass(bearer?.state === "valid", c.res.status);

    // A request that carries no evidence is not written down. This file has two
    // jobs, the stream positions a restore is reconciled against and the two
    // report numbers that cannot be computed later, and a request that advanced
    // no head, handed back no post ids and carried no valid KEY serves neither.
    // Written anyway, anybody's 404 would fill the disk the backups share. Caddy's
    // own access log, which rotates, still records every request.
    //
    // The connector's two addresses, /mcp and /mcp/connect, are held to the rule
    // whatever their bearer says, because each is a wrapper: every tool reaches a
    // real route through an in-process request that writes its own line, with the
    // heads and the ids in it, and a line for the wrapper would be a second,
    // emptier copy of it for every tool call. The app marks them (atConnector).
    // An app's refused sign-in is the exception: its reason is what an operator
    // reads to see why, so it is written, within REFUSALS_PER_MINUTE.
    const refusal = c.get("appRefusal");
    const wrapper = c.get("atConnector") === true;
    if (heads.length === 0 && returned === undefined && refusal === undefined && (wrapper || bearer?.state !== "valid")) {
      // The bounded exception, for the two events a public read surface is
      // measured by: an anonymous read that found nothing, and an anonymous
      // refusal. They are counted here and written as one rollup line a minute
      // (see ROLLUP_MS). Only under /v1, the content surface: a health check or a
      // 404 on /favicon.ico is not a read.
      if (c.req.path.startsWith("/v1")) {
        tally(now, day, cls === "refused" ? { refused: 1 } : { anonymous: 1 }, c.get("categoryMiss"));
      }
      return;
    }

    // A missed lookup is counted whoever made it, a KEY through the connector too: it
    // carries no identity, and the words are what the next release of the register is
    // made from. Counted here, where the request is written or dropped as any other.
    const miss = c.get("categoryMiss");
    if (miss !== undefined) tally(now, day, {}, miss);

    let refusalSpent = false;
    if (refusal !== undefined) {
      const minute = Math.floor(now.getTime() / ROLLUP_MS);
      if (refusals.minute !== minute) Object.assign(refusals, { minute, count: 0 });
      refusalSpent = ++refusals.count > REFUSALS_PER_MINUTE;
    }

    // A refusal past REFUSALS_PER_MINUTE is not written and not counted: it is not
    // the ceiling, and counting it as over_ceiling would make the report say the
    // log reached its daily size limit.
    if (refusalSpent) return;

    // Past the day's ceiling, only restore evidence is written. See
    // LOG_BYTES_PER_DAY for why that line is drawn exactly there.
    if (heads.length === 0 && pastCeiling(day)) {
      tally(now, day, {
        over_ceiling: 1,
        ...(c.res.status === 501 ? { planned: 1 } : {}),
        ...(returned?.op === "seek" ? { seek: 1 } : {}),
        ...(returned?.op === "open" ? { open: 1 } : {}),
      });
      return;
    }

    const peer = bearer?.state === "valid" ? bearer.peerId.toString("hex") : null;
    const line = JSON.stringify({
      at: now.toISOString(),
      request_id: c.get("requestId"),
      method: c.req.method,
      // The path as routed, not as sent: a SPACE name is peer-authored, and a
      // log is read by people and by scripts that were not written with that in
      // mind.
      path: c.req.matchedRoutes.at(-1)?.path ?? c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
      peer,
      class: cls,
      // Only when there is no KEY to correlate on, and never beside one: the
      // report joins on `peer ?? caller`, and both together would link several
      // KEYS to one address, which this file has no reason to hold.
      ...(peer === null ? { caller: pseudonymFor(clientAddress(c), day) } : {}),
      // The whole reason for this file.
      ...(heads.length > 0 ? { heads } : {}),
      // And the two report numbers that cannot be computed later.
      ...(returned ? { returned } : {}),
      // And why an app's sign-in was refused.
      ...(refusal ? { refusal } : {}),
    });

    append(line, day);
  };
}
