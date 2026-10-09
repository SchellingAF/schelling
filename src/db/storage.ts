// The nightly recount of what each SPACE stores.
//
// Three counters, kept by triggers as posts, files and tasks are written, hidden and
// withheld: space_storage.post_bytes (0148), space_file_totals.attached_bytes (0121) and
// space_storage.task_bytes (0154). A trigger cannot drift unless something writes past it,
// but a bill is measured from them, so once a day each SPACE with a post or a task is
// counted again from its rows, in two calls.
// storage_recount_drift() compares without a lock, under RECOUNT_CHECK_TIMEOUT, long
// enough for a large SPACE. Only when a counter looks wrong does storage_recount() take
// the SPACE's lock and correct it, under RECOUNT_TIMEOUT. So a correct SPACE never waits
// for its writers, nor they for it, and the lock is held only for a correction.
//
// Each call is its own transaction, with its own lock and statement timeouts: a SPACE
// that fails is counted and left for the next night, and the others go on. Each
// correction is one line on stdout naming the SPACE by its id, never its name; the
// operator needs the id to look.

import type { TransactionSql } from "postgres";
import type { Db } from "./sql.ts";

/** The SPACES asked for at a time. */
const PAGE = 500;

/**
 * The lock and statement timeout of a SPACE's correction, which holds its lock, set in its
 * own transaction so they hold whatever the role's settings. Under the api role's 2 s
 * lock_timeout (postgres/init/01_roles.sh): a POST waiting behind a correction that holds
 * the SPACE gets it before the POST gives up, and a correction stuck behind a writer fails
 * fast and is counted. A SPACE too large to correct in this time fails each night it
 * drifted, counted failed; its counters are still kept by the triggers.
 */
export const RECOUNT_TIMEOUT = "1500ms";

/**
 * The lock and statement timeout of a SPACE's unlocked comparison. It holds no lock a
 * writer waits for, so it may take as long as a large SPACE needs to count.
 */
export const RECOUNT_CHECK_TIMEOUT = "30s";

/** What a recount did: SPACES counted, corrected and failed, and the sums of the corrections. */
export type Recount = {
  spaces: number;
  corrected: number;
  failed: number;
  post_bytes_delta: number;
  file_bytes_delta: number;
  task_bytes_delta: number;
};

/** Writes one line on stdout. */
export const stdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Sets the transaction's lock and statement timeouts, for it alone. */
const timeouts = (tx: TransactionSql, timeout: string) =>
  tx`select set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`;

/** Count every SPACE with a post or a task again, and correct each counter that drifted. */
export async function recountStorage(db: Db, log: (line: string) => void = stdoutLine): Promise<Recount> {
  const out: Recount = { spaces: 0, corrected: 0, failed: 0, post_bytes_delta: 0, file_bytes_delta: 0, task_bytes_delta: 0 };
  let after: string | null = null;
  for (;;) {
    const rows: { ids: string[] }[] = await db.write<{ ids: string[] }[]>`
      select schellingaf.storage_recount_spaces(${after}::uuid, ${PAGE})::text[] as ids`;
    const ids: string[] = rows[0]?.ids ?? [];
    for (const id of ids) {
      out.spaces++;
      try {
        const [check] = await db.write.begin(async (tx) => {
          await timeouts(tx, RECOUNT_CHECK_TIMEOUT);
          return tx<{ drift: boolean }[]>`select schellingaf.storage_recount_drift(${id}::uuid) as drift`;
        });
        if (check?.drift !== true) continue;
        const [row] = await db.write.begin(async (tx) => {
          await timeouts(tx, RECOUNT_TIMEOUT);
          return tx<{ post_delta: string; file_delta: string; task_delta: string }[]>`
            select post_delta::text, file_delta::text, task_delta::text from schellingaf.storage_recount(${id}::uuid)`;
        });
        const postDelta = Number(row?.post_delta ?? 0);
        const fileDelta = Number(row?.file_delta ?? 0);
        const taskDelta = Number(row?.task_delta ?? 0);
        if (postDelta !== 0 || fileDelta !== 0 || taskDelta !== 0) {
          out.corrected++;
          out.post_bytes_delta += postDelta;
          out.file_bytes_delta += fileDelta;
          out.task_bytes_delta += taskDelta;
          log(JSON.stringify({
            event: "storage.recount", space_id: id, post_bytes_delta: postDelta, file_bytes_delta: fileDelta, task_bytes_delta: taskDelta,
          }));
        }
      } catch (error) {
        out.failed++;
        process.stderr.write(`storage recount of SPACE ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ids.length < PAGE) return out;
    after = ids[ids.length - 1]!;
  }
}
