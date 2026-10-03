// Housekeeping on what a caller holding no KEY can make grow, and one deletion
// that keeps a promise.
//
//   `rate_buckets` gains a row per address that asks for a challenge, and a row
//   per public key and address that completes one. Key pairs cost nothing, so
//   the distinct-value space is whatever an attacker cares to supply.
//   `prune_rate_buckets()` deletes rows idle for more than a day.
//
//   `tokens` gains a row per registration. `prune_tokens()` deletes a token
//   ninety days after it expired or was revoked, long after its challenge could
//   be replayed.
//
//   `oauth_requests` and `oauth_clients` gain a row per request to connect an app
//   and per app that registers itself. `prune_oauth()` deletes a request a day
//   after it was made, an app that registered and never got a token a day after
//   it registered, and any app unused for 180 days.
//
//   `prune_messages()` is the promise: it deletes every direct message older than
//   its sender's retention setting, and every conversation idle for longer than
//   any message is kept. The published rule is "checked hourly", and this is the
//   hour.
//
//   `space_files` gains a row per file a member uploads. `prune_files()` deletes
//   uploads past the pending window and every file no post attached and nobody's
//   upload still holds; a file a post attaches is never deleted.
//
//   `task_check_offers` gains a row each time `next` sends a KEY to check a task.
//   `prune_check_offers()` deletes offers a day old: each counts for 30 minutes at
//   most, and the same KEY's next `next` drops it sooner.
//
// Each of the six runs in a transaction of its own, so one that meets the api
// role's five-second statement timeout loses only itself and is tried again an
// hour later, and a table grown too big for one delete does not stop the others.
//
// A registration also writes a peer, a mailbox and, with a welcome space
// configured, a membership: about 850 bytes that are never deleted, because a
// peer id and a mailbox position are never reissued. They are bounded by the
// registration allowance per address and by the service-wide ceiling on tokens
// minted a day (`serviceTokens` in src/http/ratelimit.ts).
//
// The first prune runs at boot, because `setInterval` does not fire at zero: a
// process restarting more often than hourly (a crash loop, a redeploy, an OOM
// kill) would otherwise never prune. Two api processes would run the same
// unindexed full-table DELETE at the same moment, so the prune takes an advisory
// lock, and `pg_try_advisory_xact_lock` refuses instead of queueing: if somebody
// else is pruning, this process has nothing to do.

import type postgres from "postgres";
import type { Db } from "./sql.ts";
import { ATTACHMENT_LIMITS } from "../surface/vocabulary.ts";

/**
 * The advisory lock key. Arbitrary, stable, and this service's alone — advisory
 * locks share one namespace across the whole database, so the number matters
 * only in that it must never change.
 */
const PRUNE_LOCK = 903_551_101;

type Counts = { buckets: number; tokens: number; apps: number; messages: number; files: number; offers: number };

/** What a prune attempt did. `busy` is a success: another process has it. */
type PruneResult = ({ state: "pruned" } & Counts) | { state: "busy" };

/** The six deletes, in order, each under the name its count is reported by. */
const STEPS: [keyof Counts, (tx: postgres.Sql) => Promise<{ n: number }[]>][] = [
  ["buckets", (tx) => tx<{ n: number }[]>`select schellingaf.prune_rate_buckets()::int as n`],
  ["tokens", (tx) => tx<{ n: number }[]>`select schellingaf.prune_tokens()::int as n`],
  ["apps", (tx) => tx<{ n: number }[]>`select schellingaf.prune_oauth()::int as n`],
  ["messages", (tx) => tx<{ n: number }[]>`select schellingaf.prune_messages()::int as n`],
  // Uploaded bytes no post attached within the window: the one deletion attachments make.
  ["files", (tx) => tx<{ n: number }[]>`select schellingaf.prune_files(${ATTACHMENT_LIMITS.pendingHours})::int as n`],
  // Offers to check a task, long past the minutes they count for.
  ["offers", (tx) => tx<{ n: number }[]>`select schellingaf.prune_check_offers()::int as n`],
];

/** Delete idle rate buckets, dead tokens, stale apps, expired messages, files no post
 * attached and old offers to check a task, once, under the lock. */
export async function prune(db: Db): Promise<PruneResult> {
  const counts: Counts = { buckets: 0, tokens: 0, apps: 0, messages: 0, files: 0, offers: 0 };
  const failed: string[] = [];
  for (const [name, run] of STEPS) {
    let held: boolean;
    try {
      held = (await db.write.begin(async (tx) => {
        const [lock] = await tx<{ held: boolean }[]>`
          select pg_try_advisory_xact_lock(${PRUNE_LOCK}) as held`;
        if (lock?.held !== true) return false;
        const [row] = await run(tx as unknown as postgres.Sql);
        counts[name] = row?.n ?? 0;
        return true;
      })) as boolean;
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Somebody else has it: before the first delete, this process has nothing to do.
    if (!held && name === "buckets") return { state: "busy" };
  }
  // After every other delete has had its turn.
  if (failed.length > 0) throw new Error(failed.join("; "));
  return { state: "pruned", ...counts };
}

/**
 * Prune now, and every hour after.
 *
 * A failure is written to stderr and not thrown: a prune that cannot run is
 * worth knowing about and is not worth stopping the service for. Returns the
 * timer so a caller can stop it; it is unref'd, so it never holds the process
 * open by itself.
 */
export function startPrune(db: Db, everyMs = 3_600_000): NodeJS.Timeout {
  const run = () => {
    void prune(db).catch((error: unknown) => {
      process.stderr.write(`prune failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
