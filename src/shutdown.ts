// Stopping the service: within a deadline, and with nothing it wrote down lost.
//
// Whatever stops the service sends SIGTERM and, a grace period later, kills it. So a
// stop is done in an order that finishes well inside that grace:
//
//   1. every connector stream ends, with the answer that tells its client to listen
//      again, which it does against whatever serves next;
//   2. every read waiting for something new answers now, rather than when its wait
//      of up to WAIT_SECONDS_MAX runs out, and no read waits after this;
//   3. the server stops taking connections and waits for the requests under way;
//   4. the loops stop, each waiting for a pass under way: a checkpoint pass cut off
//      by the pools ending would fail half done;
//   5. the request log's queued lines are appended, the stream positions a restore
//      is reconciled against among them;
//   6. the pools end, and the process exits 0.
//
// SHUTDOWN_DEADLINE_SECONDS bounds the whole: past it the process exits 1, with one
// line saying what was still open, so a stop that hangs says why rather than being
// killed in silence. Whatever stops the service must wait longer than this. A stop
// that fails, or runs out of time, still appends the lines the requests that did
// finish queued, before it exits; past the deadline it gives that one second at most.

import { envNumber } from "./config.ts";
import { flushRequestLogs, unflushedLines } from "./http/log.ts";
import { endAllWaits } from "./http/wait.ts";
import { endAllStreams } from "./mcp/listen.ts";

/** The longest a timer waits: a longer one fires at once. About 24.8 days. */
const LONGEST_TIMER_SECONDS = (2 ** 31 - 1) / 1000;

/** How long a stop that ran out of time gives the request log's last append. */
const FLUSH_PAST_DEADLINE_MS = 1000;

/** SHUTDOWN_DEADLINE_SECONDS: 20 unless set; anything that is not a positive number
 *  is the default, never "no deadline", and more than a timer can wait is the most
 *  it can. */
export function shutdownDeadlineSeconds(): number {
  return Math.min(envNumber("SHUTDOWN_DEADLINE_SECONDS", 20, { min: Number.MIN_VALUE }), LONGEST_TIMER_SECONDS);
}

/** What a stop needs of the server: Node's http.Server is one. */
type Closable = {
  close(callback: (error?: Error) => void): unknown;
  getConnections?(callback: (error: Error | null, count: number) => void): unknown;
  keepAliveTimeout?: number;
  keepAliveTimeoutBuffer?: number;
};

export type Stopping = {
  server: Closable;
  /** Each loop the service runs, named as the deadline's line names it while it stops. */
  loops: { name: string; stop(): Promise<void> }[];
  db: { end(): Promise<void> };
  deadlineMs: number;
  /** Where the deadline's line goes, and how the process ends: the test's way in. */
  write?: (line: string) => void;
  exit?: (code: number) => void;
};

/** Stop, in the order above, and exit. */
export async function shutdown(stopping: Stopping): Promise<void> {
  const write = stopping.write ?? ((line: string) => void process.stderr.write(line));
  const exit = stopping.exit ?? ((code: number) => process.exit(code));
  // Whichever ends the stop first, the stop itself or the deadline, is the only one
  // that exits: a stop that finishes while the deadline's last append runs does not
  // exit 0 after the line saying it ran out of time.
  let ended = false;
  const claimEnd = (): boolean => {
    if (ended) return false;
    ended = true;
    clearTimeout(deadline);
    return true;
  };
  const leave = (code: number) => {
    if (claimEnd()) exit(code);
  };

  /** What the stop is waiting on now. */
  let step: "connections" | "log" | "pools" | { loop: string } = "connections";
  const stillOpen = async (): Promise<string> => {
    const open: string[] = [];
    if (step === "connections") {
      const count = await new Promise<number | null>((resolve) => {
        if (stopping.server.getConnections === undefined) resolve(null);
        else stopping.server.getConnections((error, n) => resolve(error ? null : n));
      });
      open.push(count === null ? "connections" : `${count} connection(s)`);
    } else if (step === "pools") {
      open.push("the database pools");
    } else if (step !== "log") {
      open.push(step.loop);
    }
    const lines = unflushedLines();
    if (lines > 0) open.push(`${lines} request log line(s) unflushed`);
    else if (step === "log") open.push("the request log's last append");
    return open.join(", ");
  };

  const deadline = setTimeout(() => {
    if (!claimEnd()) return;
    void (async () => {
      const open = await stillOpen();
      write(`shutdown: not finished after ${stopping.deadlineMs / 1000} s, with ${open} still open; exiting.\n`);
      await Promise.race([flushRequestLogs().catch(() => {}), new Promise((resolve) => setTimeout(resolve, FLUSH_PAST_DEADLINE_MS))]);
      exit(1);
    })();
  }, stopping.deadlineMs);

  try {
    endAllStreams();
    endAllWaits();
    // close() closes the connections that are idle now; one whose request is answered
    // later would otherwise be kept open for a next request until its keep-alive
    // timeout ran out, five seconds and more, and the close would wait for it.
    if (stopping.server.keepAliveTimeout !== undefined) stopping.server.keepAliveTimeout = 1;
    if (stopping.server.keepAliveTimeoutBuffer !== undefined) stopping.server.keepAliveTimeoutBuffer = 0;
    await new Promise<void>((resolve) => stopping.server.close(() => resolve()));
    for (const loop of stopping.loops) {
      step = { loop: loop.name };
      await loop.stop();
    }
    step = "log";
    await flushRequestLogs();
    step = "pools";
    await stopping.db.end();
    leave(0);
  } catch (error) {
    write(`shutdown: failed: ${error instanceof Error ? error.message : String(error)}\n`);
    // The deadline still bounds this append.
    await flushRequestLogs().catch(() => {});
    leave(1);
  }
}
