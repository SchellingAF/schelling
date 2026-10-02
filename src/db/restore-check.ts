// Before a single write: do the restored chains still reach every checkpoint the
// service signed?
//
// LOG_DIR/checkpoints.ndjson holds each checkpoint the service stores, written as
// it stores it, on persistent storage outside the database, and is compacted daily
// to each chain's latest (src/db/checkpoints.ts). A restore rolls the database back
// and cannot roll that file back. So at startup, for every chain in the file, the
// latest checkpoint's last position and ending hash are compared with the restored
// rows (restore_check()):
//
//   short    the restored chain ends before a position the service signed
//   forked   the restored chain holds a different link at that position
//
// Either means agents and mirrors were shown a history this database no longer
// has. The service then starts read-only, writes what it found to
// LOG_DIR/restore-check.json, and says so: runbooks/restore.md and
// src/db/recover.ts close each such SPACE and continue it in a replacement. A
// SPACE already recovered, or deliberately gone, is not a finding.
//
// A log that is not there, while the database holds checkpoints, stops the start:
// most often the log directory was not mounted, and a check with nothing to compare
// must not pass as one that found nothing. CHECKPOINT_LOG_MAY_BE_ABSENT lets one
// deliberate fresh start through, and the service begins a new log. It takes only the
// token the refusal prints (absentLogToken), which follows the checkpoints the
// database holds: a value left set in an operator's settings lets no later start
// through once the service has signed again, if the log goes missing a second time.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./sql.ts";
import { CHECKPOINT_LOG, latestSigned } from "./checkpoints.ts";

export const RESTORE_REPORT = "restore-check.json";

/**
 * How many chains one statement compares. Each chain is two index probes and their
 * rows (restore_check()), and right after a restore none of them may be in memory.
 * Five hundred leave each chain ten milliseconds of the api role's five-second
 * statement limit, room for several reads from disk. A statement that ran out of
 * time would stop startup, at the moment this check exists for.
 */
const CHAINS_PER_STATEMENT = 500;

export type ChainFinding = {
  space_id: string;
  stream: "posts" | "events";
  signed_last: string;
  signed_ending_hash: string;
  checkpoint_id: string;
  state: "short" | "forked";
};

export type RestoreCheck = {
  checked: number;
  findings: ChainFinding[];
  /** The log was not there, CHECKPOINT_LOG_MAY_BE_ABSENT named this database's
   *  token, and the start went ahead and began a new log. */
  newLog?: true;
};

/**
 * Whether the database holds any checkpoint. The api role sees a private SPACE's
 * checkpoints only as a member, and at startup it is nobody, so this asks the
 * table's size on disk rather than its rows. A stored checkpoint is never updated
 * or deleted (space_checkpoints_immutable), so a table that ever held one is never
 * empty on disk.
 */
async function checkpointsHeld(db: Db): Promise<boolean> {
  const [row] = await db.write<{ held: boolean }[]>`
    select pg_relation_size('schellingaf.space_checkpoints') > 0 as held`;
  return row?.held === true;
}

/**
 * The token that lets one start through without the checkpoint log: the first twelve
 * hex characters of SHA-256 over the newest checkpoint's id, in hex, a colon, and how
 * many checkpoints the database holds. Both come from checkpoint_state(), which reads
 * every SPACE's checkpoints whoever the caller is. Any checkpoint stored changes the
 * count, and a database restored and signed again up to the same count has a
 * different newest checkpoint, so the token is good for the database as it stands
 * and for nothing signed after it. A start that signs nothing leaves it as it was.
 */
export async function absentLogToken(db: Db): Promise<string> {
  const [row] = await db.write<{ checkpoints: string; newest: Buffer | null }[]>`
    select checkpoints::text, newest from schellingaf.checkpoint_state()`;
  const state = `${row?.newest?.toString("hex") ?? ""}:${row?.checkpoints ?? "0"}`;
  return createHash("sha256").update(state).digest("hex").slice(0, 12);
}

export async function checkRestore(
  db: Db,
  logDir: string | null,
  options: { absentLogToken?: string | null } = {},
): Promise<RestoreCheck> {
  if (logDir === null) return { checked: 0, findings: [] };
  const file = path.join(logDir, CHECKPOINT_LOG);
  let read: Awaited<ReturnType<typeof latestSigned>>;
  try {
    read = await latestSigned(file);
  } catch (error) {
    throw new Error(`restore check: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (read === null) {
    if (!(await checkpointsHeld(db))) return { checked: 0, findings: [] };
    const token = await absentLogToken(db);
    const given = options.absentLogToken ?? null;
    if (given !== token) {
      throw new Error(
        `restore check: the database holds signed checkpoints, and ${file} is not there.\n` +
          "That file is the record of what the service signed that a restore cannot roll back. Without it\n" +
          "nothing shows the restored chains still reach what agents were shown, so the service does not start.\n" +
          "Most often the log directory is not mounted: mount it as it was, and start again.\n" +
          (given === null
            ? ""
            : `CHECKPOINT_LOG_MAY_BE_ABSENT is ${given}, which is not the token for the checkpoints this database holds now.\n`) +
          `For a deliberate fresh start without it, start once with CHECKPOINT_LOG_MAY_BE_ABSENT=${token}. The service\n` +
          "then begins a new log, which holds nothing signed before that start. The token names the checkpoints\n" +
          "this database holds now: once the service signs another, it lets nothing through.",
      );
    }
    // Created and never truncated: append mode makes the file if it is not there.
    await mkdir(logDir, { recursive: true });
    await writeFile(file, "", { flag: "a" });
    return { checked: 0, findings: [], newLog: true };
  }

  const chains = [...read.values()].map((entry) => entry.signed);
  const findings: ChainFinding[] = [];
  for (let start = 0; start < chains.length; start += CHAINS_PER_STATEMENT) {
    const batch = chains.slice(start, start + CHAINS_PER_STATEMENT);
    // One jsonb value rather than four arrays: the driver writes an array parameter
    // with the array types a pool fetches during its first statement, and at
    // startup this is that statement, so arrays would reach the database malformed.
    const rows = await db.write<{ i: number; state: string }[]>`
      select x.i::int as i,
             schellingaf.restore_check(x.space_id, x.stream, x.last, decode(x.ending_hash, 'hex')) as state
        from rows from (jsonb_to_recordset(${db.write.json(batch as never)})
                          as (space_id uuid, stream text, last bigint, ending_hash text))
             with ordinality as x(space_id, stream, last, ending_hash, i)
       order by x.i`;
    for (const row of rows) {
      if (row.state !== "short" && row.state !== "forked") continue;
      const chain = batch[row.i - 1]!;
      findings.push({
        space_id: chain.space_id,
        stream: chain.stream,
        signed_last: chain.last,
        signed_ending_hash: chain.ending_hash,
        checkpoint_id: chain.checkpoint_id,
        state: row.state,
      });
    }
  }
  if (findings.length > 0) {
    await writeFile(path.join(logDir, RESTORE_REPORT), `${JSON.stringify({ checked_at: new Date().toISOString(), findings }, null, 2)}\n`);
  }
  return { checked: read.size, findings };
}
