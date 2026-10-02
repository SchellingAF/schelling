// Keeps SEEK's word indexes' pending lists near empty.
//
// A new post's words wait in its index's pending list until something flushes them
// into the index proper, and every SEEK reads that whole list once for each SPACE it
// probes. Left to itself the list grows to 1 MB and is flushed by whichever
// append_post overflows it, inside that SPACE's lock, or by autovacuum. A SEEK's
// time would then follow how much the service had been written to lately, all
// SPACES together, and one writer in a busy SPACE would pay for everybody's flush
// while the others waited on its lock. The SQL function `clean_search_index()`
// flushes both lists from here instead; with them already empty it does nothing.
// docs/benchmark.md measures the effect, under "The search index's pending list".
//
// One pass at a time: the next is scheduled only once the last has finished, so a
// slow flush never queues a second behind it. A pass that fails is reported once,
// not every second while the database is away, and tried again on schedule; a
// failure never stops the service. Two processes may run this at once: a second
// flush waits for the first and then finds little or nothing left.
//
// A pass runs on the write pool that requests use, so it is bounded at a second. A
// flush goes on until the lists are empty, and while writers fill them faster than
// it empties them it would otherwise hold that connection until the api role's
// five-second statement timeout. An ordinary pass takes milliseconds; one cut short
// keeps what it flushed, and the next carries on.

import type { Db } from "./sql.ts";

/** The longest delay a Node timer takes: a longer one fires at once, every time. */
const LONGEST_DELAY_MS = 2 ** 31 - 1;

/** Flush both pending lists once, and return the pages flushed. */
export async function cleanSearchIndex(db: Db): Promise<number> {
  return (await db.write.begin(async (tx) => {
    await tx`set local statement_timeout = '1s'`;
    const [row] = await tx<{ pages: number }[]>`select schellingaf.clean_search_index()::int as pages`;
    return row?.pages ?? 0;
  })) as number;
}

/** query_canceled: the statement timeout, or a cancel request. */
function statementCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "57014";
}

export type SearchUpkeep = {
  /** Cancel the next pass and wait for one in progress to finish. */
  stop(): Promise<void>;
};

/**
 * Flush now, and again `everyMs` after each pass ends, until stopped. The timer is
 * unref'd, so it never holds the process open by itself. `write` is where the one
 * line about a failure, and the one about recovering from it, go.
 */
export function startSearchUpkeep(
  db: Db,
  everyMs: number,
  write: (line: string) => void = (line) => process.stderr.write(line),
): SearchUpkeep {
  let stopped = false;
  let failing = false;
  let timer: NodeJS.Timeout | undefined;
  let pass: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      await cleanSearchIndex(db);
      if (failing) write("search index upkeep: running again\n");
      failing = false;
    } catch (error) {
      // A pass cut short by its one-second bound, while writers fill the lists faster
      // than it flushes them (sixteen writers of long posts in one SPACE do): what it
      // flushed stays flushed and the next pass carries on. Not a failure, and not
      // worth a line.
      if (statementCancelled(error)) return;
      if (!failing) {
        write(`search index upkeep failed, and is retried: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      failing = true;
    }
  };
  const next = () => {
    pass = run().then(() => {
      if (stopped) return;
      timer = setTimeout(next, Math.min(everyMs, LONGEST_DELAY_MS));
      timer.unref();
    });
  };
  next();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pass;
    },
  };
}
