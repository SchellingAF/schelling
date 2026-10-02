// The worker that signs checkpoints.
//
// Every minute, under an advisory lock so a second service process makes none of
// the same, it asks the database which ranges are due (checkpoints_due(), a slice
// of SPACES at a time), computes each range's Merkle root
// from the ids and links the database holds, signs the checkpoint with the service's
// online key, and hands it back to insert_checkpoint, which refuses it unless it
// extends the last one exactly.
//
// Each checkpoint it stores is also appended to LOG_DIR/checkpoints.ndjson, on the
// persistent storage beside the request log and outside the database. After a disaster
// restore that file still says how far every chain had been signed, and
// src/db/restore-check.ts compares the restored chains with it before the service
// accepts a single write. A copy the restore cannot roll back is the whole point.
//
// The check reads only each chain's latest entry, so once a day the log is
// compacted to exactly that (compactCheckpointLog), and it grows with the number of
// chains rather than with time.

import { createReadStream } from "node:fs";
import { appendFile, link, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type postgres from "postgres";
import type { Db } from "./sql.ts";
import { canonicalBytes } from "../domain/jcs.ts";
import { leavesOf, merkleRoot } from "../domain/merkle.ts";
import { signStatement, type ServiceKey } from "../domain/service.ts";

export const CHECKPOINT_EVERY_RECORDS = 1024;

/**
 * How old a range's oldest position must be before a shorter range is signed, and
 * how often the worker looks. Ten minutes and one minute by default;
 * CHECKPOINT_AFTER_SECONDS and CHECKPOINT_EVERY_SECONDS set them, and a value that
 * is not a whole number of seconds keeps the default rather than becoming none.
 */
function seconds(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}
export const CHECKPOINT_AFTER_SECONDS = seconds("CHECKPOINT_AFTER_SECONDS", 600, 0);
export const CHECKPOINT_EVERY_SECONDS = seconds("CHECKPOINT_EVERY_SECONDS", 60, 5);
export const CHECKPOINT_LOG = "checkpoints.ndjson";

/** The log as it stood before the latest compaction, kept until the next one. */
export const CHECKPOINT_LOG_PREVIOUS = `${CHECKPOINT_LOG}.1`;

/** How often the log is compacted after the compaction at startup: once a day. */
const COMPACT_EVERY_MS = 24 * 60 * 60 * 1000;

/** Arbitrary, stable, and this service's alone. See PRUNE_LOCK in prune.ts. The
 *  worker appends to the log only while it holds this lock, and the compaction
 *  takes it too. */
const CHECKPOINT_LOCK = 903_551_207;

/**
 * How many SPACES one call to checkpoints_due reads. One call over every SPACE takes
 * about 44 ms per ten thousand, so near a million it would pass the five-second
 * statement limit and nothing would be checkpointed again. A slice costs the same
 * however many SPACES there are.
 */
export const CHECKPOINT_SLICE = 10_000;

/** How many due ranges one call to checkpoints_due returns. */
const DUE_PER_CALL = 200;

/** The lowest uuid, where the first slice begins. A sealed SPACE's id is chosen by its
 *  maker and can be this one, so the first slice includes it. */
const FIRST = "00000000-0000-0000-0000-000000000000";

export type CheckpointRun = { state: "busy" } | { state: "done"; made: number; failed: number };

/** The online key in service_keys, so everything it signs names a key anybody can look up. */
export async function registerServiceKey(sql: postgres.ISql, key: ServiceKey): Promise<void> {
  await sql`select schellingaf.register_service_key(${key.publicKey}, ${key.root}, ${key.certificate},
                                                    ${key.certificateSignature}, ${key.development})`;
}

/** The service epoch now, the latest one started; the schema starts the first. */
export async function currentEpoch(sql: postgres.ISql): Promise<string | null> {
  const [row] = await sql<{ epoch: string }[]>`
    select epoch::text from schellingaf.service_epochs order by started_at desc limit 1`;
  return row?.epoch ?? null;
}

type Due = {
  space_id: string;
  stream: "posts" | "events";
  first_position: string;
  last_position: string;
  previous_checkpoint_id: Buffer | null;
  predecessor_hash: Buffer;
};

export async function makeCheckpoints(
  db: Db,
  key: ServiceKey,
  options: { minAgeSeconds?: number; logDir?: string | null; slice?: number; laps?: number } = {},
): Promise<CheckpointRun> {
  const minAge = options.minAgeSeconds ?? CHECKPOINT_AFTER_SECONDS;
  const slice = options.slice ?? CHECKPOINT_SLICE;
  const laps = options.laps ?? 50;
  const conn = await db.write.reserve();
  try {
    const [lock] = await conn<{ held: boolean }[]>`select pg_try_advisory_lock(${CHECKPOINT_LOCK}) as held`;
    if (lock?.held !== true) return { state: "busy" };
    try {
      await registerServiceKey(conn, key);
      let made = 0;
      let failed = 0;
      let epoch: string | null = null;
      // A lap asks every slice once, which makes at most one range for each SPACE and
      // stream, so a SPACE three thousand posts behind needs three laps. Laps repeat while
      // one makes something, fifty at most: fifty thousand positions, more than a minute of
      // any real traffic. Every SPACE is served on a lap before any is served twice, so a
      // SPACE far behind never keeps the others waiting.
      const edges: (string | null)[] = [];
      for (let lap = 0; lap < laps; lap++) {
        let progress = 0;
        let after: string | null = null;
        for (let i = 0; ; i++) {
          if (i === edges.length) {
            // Where this slice ends, found once a pass. None: it runs to the last SPACE.
            const [edge] = await conn<{ id: string }[]>`
              select s.space_id::text as id from schellingaf.spaces s
               where s.space_id >= coalesce(${after}::uuid, ${FIRST}::uuid)
                 and s.space_id is distinct from ${after}::uuid
               order by s.space_id offset ${slice - 1} limit 1`;
            edges.push(edge?.id ?? null);
          }
          const through = edges[i] ?? null;
          const due = await conn<Due[]>`
            select space_id::text, stream, first_position::text, last_position::text,
                   previous_checkpoint_id, predecessor_hash
              from schellingaf.checkpoints_due(${`${minAge} seconds`}::interval, ${DUE_PER_CALL},
                                               ${after}::uuid, ${through}::uuid)`;
          if (due.length > 0 && epoch === null) {
            epoch = await currentEpoch(conn);
            if (epoch === null) throw new Error("no service epoch");
          }
          for (const range of due) {
            try {
              if (await makeOne(conn, key, range, epoch!, options.logDir ?? null)) {
                made++;
                progress++;
              }
            } catch (error) {
              failed++;
              process.stderr.write(
                `checkpoint for ${range.space_id} ${range.stream} ${range.first_position}-${range.last_position} failed: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            }
          }
          if (through === null) break;
          after = through;
        }
        if (progress === 0) break;
      }
      return { state: "done", made, failed };
    } finally {
      await conn`select pg_advisory_unlock(${CHECKPOINT_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

async function makeOne(
  conn: Awaited<ReturnType<Db["write"]["reserve"]>>,
  key: ServiceKey,
  range: Due,
  epoch: string,
  logDir: string | null,
): Promise<boolean> {
  const first = BigInt(range.first_position);
  const last = BigInt(range.last_position);
  const leaves = await conn<{ position: string; id: Buffer; chain_hash: Buffer }[]>`
    select leaf_position::text as position, id, chain_hash
      from schellingaf.checkpoint_leaves(${range.space_id}::uuid, ${range.stream}, ${first.toString()}::bigint, ${last.toString()}::bigint)`;
  if (BigInt(leaves.length) !== last - first + 1n) return false;
  const hashes = leavesOf(range.stream, range.space_id, leaves.map((leaf) => ({ position: BigInt(leaf.position), id: leaf.id, chainHash: leaf.chain_hash })));
  const body: Record<string, unknown> = {
    v: 1,
    space_id: range.space_id,
    stream: range.stream,
    first: first.toString(),
    last: last.toString(),
    predecessor_hash: range.predecessor_hash.toString("hex"),
    ending_hash: leaves.at(-1)!.chain_hash.toString("hex"),
    merkle_root: merkleRoot(hashes).toString("hex"),
    service_epoch: epoch,
    signer_key_id: key.keyId.toString("hex"),
    created_at: new Date().toISOString(),
  };
  if (range.previous_checkpoint_id) body.previous_checkpoint_id = range.previous_checkpoint_id.toString("hex");
  const canonical = canonicalBytes(body);
  const signature = signStatement("checkpoint", canonical, key.privateKey);
  const [row] = await conn<{ r: { checkpoint_id: string; created: boolean } }[]>`
    select schellingaf.insert_checkpoint(${canonical}, ${signature}) as r`;
  if (row?.r.created && logDir) {
    await mkdir(logDir, { recursive: true });
    await appendFile(
      path.join(logDir, CHECKPOINT_LOG),
      `${JSON.stringify({ checkpoint_id: row.r.checkpoint_id, ...body, canonical: canonical.toString("base64url"), signature: signature.toString("hex") })}\n`,
    );
  }
  return row?.r.created === true;
}

/** What the restore check compares of one log entry. */
type Signed = { space_id: string; stream: "posts" | "events"; last: string; ending_hash: string; checkpoint_id: string };

/** A chain's latest entry in the log, and the line it was read from when the
 *  reader was asked to keep it. */
type Latest = { signed: Signed; line?: string };

/** A log entry as a checkpoint, or null when it lacks a member the check compares. */
function signedOf(entry: unknown): Signed | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { space_id, stream, last, ending_hash, checkpoint_id } = entry as Record<string, unknown>;
  if (typeof space_id !== "string" || typeof checkpoint_id !== "string") return null;
  if (stream !== "posts" && stream !== "events") return null;
  if (typeof last !== "string" || !/^\d+$/.test(last)) return null;
  if (typeof ending_hash !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(ending_hash)) return null;
  return { space_id, stream, last, ending_hash, checkpoint_id };
}

/**
 * The latest checkpoint of each chain in the log, in the order each chain first
 * appears, and with `keepLines` the line it was read from, which the compaction
 * writes. Read a line at a time, so what is held grows with the number of chains,
 * never with the size of the log. Null when there is no log. A line that is not
 * JSON is skipped, as a write cut short would leave it. Any other error reading the
 * log, or an entry that is not a checkpoint, is thrown: a check that could not read
 * the log has compared nothing, and must never pass as a check that found nothing.
 */
export async function latestSigned(file: string, options: { keepLines?: boolean } = {}): Promise<Map<string, Latest> | null> {
  const latest = new Map<string, Latest>();
  const input = createReadStream(file, { encoding: "utf8" });
  let lineNumber = 0;
  let wrongLine = 0;
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      lineNumber++;
      if (line.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const signed = signedOf(entry);
      if (signed === null) {
        wrongLine = lineNumber;
        break;
      }
      const key = `${signed.space_id}/${signed.stream}`;
      const held = latest.get(key);
      if (!held || BigInt(signed.last) > BigInt(held.signed.last)) {
        const kept: Latest = { signed };
        // readline hands back each line as a slice of the chunk it read, and a kept
        // slice keeps that whole chunk, about 64 KB, alive. A copy keeps only the line.
        if (options.keepLines === true) kept.line = Buffer.from(line, "utf8").toString("utf8");
        latest.set(key, kept);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    input.destroy();
  }
  if (wrongLine > 0) throw new Error(`${file} line ${wrongLine} is not a checkpoint entry`);
  return latest;
}

type Compaction = { state: "busy" } | { state: "done"; chains: number };

/**
 * Rewrites the log to each chain's latest entry, which is all the restore check
 * reads, so its answer is the same before and after.
 *
 * The worker appends only while it holds CHECKPOINT_LOCK, in this process or any
 * other on the same database, so the compaction holds it too, and no append falls
 * between reading the log and replacing it; while the worker runs, the compaction
 * is busy and is tried again on the next pass. The new log is written beside the
 * old one, flushed, and renamed over it, so a crash at any moment leaves one whole
 * log or the other, and never none. The old log is kept as
 * checkpoints.ndjson.1 until the next compaction. No log is nothing to compact.
 *
 * `beforeRename` runs once the new log is written, and is the test's way to
 * append while a compaction is under way.
 */
export async function compactCheckpointLog(
  db: Db,
  logDir: string,
  options: { beforeRename?: () => Promise<void> } = {},
): Promise<Compaction> {
  const conn = await db.write.reserve();
  try {
    const [lock] = await conn<{ held: boolean }[]>`select pg_try_advisory_lock(${CHECKPOINT_LOCK}) as held`;
    if (lock?.held !== true) return { state: "busy" };
    try {
      const file = path.join(logDir, CHECKPOINT_LOG);
      const latest = await latestSigned(file, { keepLines: true });
      if (latest === null) return { state: "done", chains: 0 };

      const next = `${file}.next`;
      const handle = await open(next, "w");
      try {
        // A thousand lines a write, rather than one string of the whole new log
        // beside the lines it is made of.
        let lines: string[] = [];
        for (const { line } of latest.values()) {
          lines.push(line!);
          if (lines.length === 1000) {
            await handle.write(`${lines.join("\n")}\n`);
            lines = [];
          }
        }
        if (lines.length > 0) await handle.write(`${lines.join("\n")}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await options.beforeRename?.();

      // The old log takes its second name by a link, not a rename, so the log's own
      // name always holds a whole log.
      const previous = path.join(logDir, CHECKPOINT_LOG_PREVIOUS);
      await rm(`${previous}.next`, { force: true });
      await link(file, `${previous}.next`);
      await rename(`${previous}.next`, previous);
      await rename(next, file);
      return { state: "done", chains: latest.size };
    } finally {
      await conn`select pg_advisory_unlock(${CHECKPOINT_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

/**
 * One of the worker's passes, each a minute apart. The log is compacted first, on
 * the first pass and then once a day. A compaction that is busy is tried on the
 * next pass; one that fails goes to stderr and is tried again a day later: until
 * then the log only grows. `now` is the test's clock.
 */
export function checkpointPass(db: Db, key: ServiceKey, logDir: string | null, now: () => number = Date.now): () => Promise<void> {
  let compactedAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (logDir !== null && now() - compactedAt >= COMPACT_EVERY_MS) {
      const compaction = await compactCheckpointLog(db, logDir).catch((error: unknown) => {
        process.stderr.write(`checkpoint log not compacted: ${error instanceof Error ? error.message : String(error)}\n`);
        return { state: "failed" } as const;
      });
      if (compaction.state !== "busy") compactedAt = now();
    }
    await makeCheckpoints(db, key, { logDir });
  };
}

export type CheckpointWorker = {
  /** Start no more passes, and wait for any under way to finish. */
  stop(): Promise<void>;
};

/**
 * Checkpoint now, and every minute after. A failure goes to stderr and does not
 * stop the service: an unsigned range is signed on the next pass, and every
 * refusal insert_checkpoint makes is a fact worth an operator's attention.
 *
 * Stopped before the pools end, as the service stops: a pass cut off mid-way by
 * the pools ending would fail, and a checkpoint stored but not yet appended to the
 * log would be one the log does not name.
 */
export function startCheckpoints(db: Db, key: ServiceKey, logDir: string | null): CheckpointWorker {
  const pass = checkpointPass(db, key, logDir);
  const running = new Set<Promise<void>>();
  const run = () => {
    const one = pass().catch((error: unknown) => {
      process.stderr.write(`checkpoints failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    running.add(one);
    void one.finally(() => running.delete(one));
  };
  run();
  const timer = setInterval(run, CHECKPOINT_EVERY_SECONDS * 1000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await Promise.all(running);
    },
  };
}
