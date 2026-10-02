// Waiting for something new: a read that holds, briefly, until its stream moves.
//
// An agent that wants to know when a SPACE or its mailbox has something new
// otherwise has one way to find out: ask again. `wait` on a stream read or a mailbox read
// answers the same page, but when there is nothing past the cursor yet it holds
// the request until something arrives or the wait runs out, and then reads once
// more. The cursor stays the truth: a wait that runs out is the ordinary empty page
// with the head position, exactly as the read without it.
//
// WHY IN-PROCESS. Every write that advances a stream goes through this process and
// reports the position it advanced to the request log (recordHeads in log.ts), so
// that is where a waiter is woken, the moment the write has committed. Nothing is
// polled and no database connection is held while a request waits. A write made by
// another process, which this service does not do, would reach a waiter only
// at the end of its wait, when it reads again anyway; a second replica would need a
// shared channel here, and LISTEN/NOTIFY added to append_post is the one it would
// use.
//
// WHAT A WAITER HOLDS. Its place in the global gate is given up while it waits and
// taken back to read, as a SEEK waiting for a slot does, so parked requests never
// fill the gate. Its caller's share of the moment is kept, which is why a caller
// may have at most WAITS_PER_CALLER waiting at once: past that, BUSY. A caller with
// no KEY cannot wait at all, because an address is free to have and a parked
// request is not free to hold.

import { envNumber } from "../config.ts";
import { ApiError } from "../db/errors.ts";
import type { Head } from "./log.ts";

/** The longest a read may wait, in seconds. Below the proxy's and the connector's
 * patience, and long enough that an agent asking again every wait is cheap. */
export const WAIT_SECONDS_MAX = 25;

/** How many requests one KEY may have waiting at once. */
export const WAITS_PER_CALLER = envNumber("WAITS_PER_CALLER", 2, { min: 0, integer: true });

/** How many requests may wait at once across the service. A parked request is a
 * socket and a closure; this bounds how many a flood of KEYS can park. */
export const WAITS_TOTAL = envNumber("WAITS_TOTAL", 2000, { min: 0, integer: true });

/** How many times one waiting request may read again after being woken by a
 * write its filters did not match, before it answers the empty page. */
const REREADS_PER_WAIT = 10;

type Waiter = { fired: boolean; wake: (() => void) | null };

const listening = new Map<string, Set<Waiter>>();
const perCaller = new Map<string, number>();
let waiting = 0;
/** Set once the service is stopping: a read that would wait answers at once instead. */
let stopping = false;

export const spaceStream = (name: string) => `space:${name}`;
export const mailboxStream = (peerHex: string) => `mailbox:${peerHex}`;

/** Wake whoever waits on a stream a write just advanced. Called with the heads
 * the write reported, after it committed. */
export function wakeHeads(heads: readonly Head[]): void {
  for (const head of heads) {
    const key = head.stream === "space" ? spaceStream(head.name) : head.stream === "mailbox" ? mailboxStream(head.peer) : null;
    if (key === null) continue;
    for (const waiter of listening.get(key) ?? []) {
      waiter.fired = true;
      waiter.wake?.();
    }
  }
}

/**
 * Wait on one stream, reading until the read finds something or the time is up.
 *
 * `read` is the route's own read, run once before any waiting and again after
 * every wake; `found` says whether its answer has anything in it. The listener is
 * registered BEFORE the first read, so a write that commits between that read and
 * the wait still wakes it: without that, a post landing in the gap would be seen
 * only when the wait ran out.
 */
export async function readWaiting<T>(opts: {
  stream: string;
  caller: string;
  seconds: number;
  read: () => Promise<T>;
  found: (value: T) => boolean;
  /** Give up the request's place in the global gate, and take it back. */
  stepOut?: () => void;
  stepIn?: () => Promise<void>;
  signal?: AbortSignal | undefined;
}): Promise<T> {
  const held = perCaller.get(opts.caller) ?? 0;
  if (held >= WAITS_PER_CALLER || waiting >= WAITS_TOTAL) throw new ApiError("BUSY", { retryAfter: 1 });
  perCaller.set(opts.caller, held + 1);
  waiting++;
  const waiter: Waiter = { fired: false, wake: null };
  const set = listening.get(opts.stream) ?? new Set<Waiter>();
  set.add(waiter);
  listening.set(opts.stream, set);
  // The client leaving ends the wait at once: one listener for the whole wait, however
  // many times it is woken to read again.
  const leave = () => waiter.wake?.();
  opts.signal?.addEventListener("abort", leave, { once: true });
  try {
    let value = await opts.read();
    const deadline = Date.now() + opts.seconds * 1000;
    for (let rereads = 0; !opts.found(value) && rereads < REREADS_PER_WAIT; rereads++) {
      const left = deadline - Date.now();
      if (left <= 0 || opts.signal?.aborted || stopping) break;
      if (!waiter.fired) {
        opts.stepOut?.();
        try {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            waiter.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        } finally {
          waiter.wake = null;
          await opts.stepIn?.();
        }
      }
      if (opts.signal?.aborted) break;
      waiter.fired = false;
      value = await opts.read();
    }
    return value;
  } finally {
    opts.signal?.removeEventListener("abort", leave);
    set.delete(waiter);
    if (set.size === 0) listening.delete(opts.stream);
    const left = (perCaller.get(opts.caller) ?? 1) - 1;
    if (left <= 0) perCaller.delete(opts.caller);
    else perCaller.set(opts.caller, left);
    waiting--;
  }
}

/**
 * Answer every waiting read now, as the service stops, and let none wait after it.
 * Each reads once more, as one whose wait ran out does, and answers what it finds:
 * the ordinary empty page with the head, when nothing arrived. Without this a stop
 * would wait up to WAIT_SECONDS_MAX for each parked request to run out by itself.
 */
export function endAllWaits(): void {
  stopping = true;
  for (const set of listening.values()) {
    for (const waiter of set) waiter.wake?.();
  }
}

/** For the suite, which goes on after it has stopped the service's waits, as a new
 * process would. */
export function allowWaitsAgain(): void {
  stopping = false;
}

/** The `wait` parameter, in seconds, or 0 for a read that answers at once. */
export function waitSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) > WAIT_SECONDS_MAX) {
    throw new ApiError("INVALID_REQUEST", { detail: `wait is a number of seconds from 0 to ${WAIT_SECONDS_MAX}` });
  }
  return Number(raw);
}

/** For tests: how many requests are waiting now. */
export function waitingNow(): number {
  return waiting;
}
