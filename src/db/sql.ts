// The only module that knows the driver. Two pools, because a read and a write
// want different limits, and one helper that binds the caller.

import postgres from "postgres";
import type { Config } from "../config.ts";

export type Db = {
  /** Write pool. Only ever calls functions; it holds no INSERT on content. */
  write: postgres.Sql;
  /** Read pool. Never used without readTx below. */
  read: postgres.Sql;
  /**
   * Every read runs inside a transaction whose FIRST statement binds the caller
   * for that transaction only. Transaction-scoped rather than session-scoped is
   * what keeps a connection pooler from handing one agent's caller to the next
   * request, and what makes "no caller bound" mean "sees nothing" rather than
   * "sees whatever the last request saw".
   */
  readTx<T>(peerIdHex: string | null, fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

/**
 * Every statement the read pool sends, as the driver sends it, for the tests that
 * plan the real SQL rather than a copy of it. Never set in the service.
 *
 * The hook is installed only when a test asks for it: postgres.js marks `query`
 * and `parameters` enumerable on every error it raises exactly when `debug` is
 * set, which would hand the statement and its bound values to whatever prints the
 * error, and would put the hook on the hot path of every read.
 */
export type Watcher = (sql: string, params: readonly unknown[]) => void;
let watcher: Watcher | null = null;
let watchable = false;
export function watchReadQueries(fn: Watcher | null): void {
  watcher = fn;
}
/** Build the next read pool with the hook above. Called by the two tests that
 * capture real SQL, before they open their database. */
export function allowReadQueryWatch(): void {
  watchable = true;
}

/** Read connections. SEEK's ceiling is derived from this, so the two are chosen
 * together; see seekCeiling in http/seek.ts. */
export const READ_POOL = 12;

/** `readPool` is for a measurement that varies the read pool; the service always
 * opens READ_POOL. */
export function openDb(config: Config, options?: { readPool?: number }): Db {
  const common = {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    onnotice: () => {},
  };

  const write = postgres({ ...common, max: 8 });
  const read = postgres({
    ...common,
    max: options?.readPool ?? READ_POOL,
    // Two timeouts the driver does not impose on its own, on the pool the
    // internet reaches.
    //
    // `connect_timeout` bounds the TCP connect and the handshake, and nothing
    // else: a query that finds no free connection waits on an in-memory queue
    // with no timeout at all. So the only bound on that wait is the global gate in
    // app.ts, which is why every path that can reach a pool passes through it.
    // Five seconds is for a hung handshake to a database on the same host, a real
    // fault that should be loud.
    //
    // `idle_timeout` is off by default, which holds a connection opened during one
    // burst for the life of the process. Thirty seconds hands them back between
    // bursts, at the cost of a round trip to reconnect.
    connect_timeout: 5,
    idle_timeout: 30,
    // Absent unless a test asked for it: a `debug` of any kind makes the driver
    // publish the statement and its bound values on every error it raises.
    ...(watchable ? { debug: (_c: number, query: string, params: readonly unknown[]) => watcher?.(query, params) } : {}),
  });

  return {
    write,
    read,
    async readTx(peerIdHex, fn) {
      return read.begin(async (tx) => {
        await tx`select set_config('schellingaf.peer_id', ${peerIdHex ?? ""}, true)`;
        return fn(tx as unknown as postgres.Sql);
      }) as Promise<Awaited<ReturnType<typeof fn>>>;
    },
    async end() {
      await Promise.all([write.end({ timeout: 5 }), read.end({ timeout: 5 })]);
    },
  };
}

/**
 * One statement finished on each pool, which the service awaits before it takes a
 * request. postgres.js learns the database's array types on a pool's first
 * connection, and builds the first statement of every connection opened before it
 * has them without them: an array parameter there (`sql.array()`, or an array of
 * Buffers) goes out as its element type, and the database refuses it ("cannot cast
 * type bytea to bytea[]", "malformed array literal"). Once one statement has
 * finished, every connection the pool opens later has them. A statement inside a
 * transaction is safe either way, because its BEGIN is what is built first.
 *
 * A database that cannot be reached is not reported here: this resolves anyway,
 * and the first request finds out, as it would without it. One that does not answer
 * at all holds the start until the write pool's connect timeout (the driver's
 * default, 30 s) runs out.
 */
export async function warm(db: Db): Promise<void> {
  await Promise.allSettled([db.write`select 1`, db.read`select 1`]);
}
