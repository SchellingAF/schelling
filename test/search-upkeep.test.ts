// The service empties the search index's pending lists itself, on a timer, so a SEEK
// never reads a full one (src/db/search-upkeep.ts). What holds: the first pass runs
// at start and the next ones keep coming, a pass never overlaps the one before, a
// stopped upkeep runs nothing more and waits for the pass in progress, a pass gives
// its connection back after a second, an interval longer than a timer can hold still
// waits, a database that is away is reported once and retried, a pass the statement
// timeout ends is not reported, and SEARCH_INDEX_UPKEEP_SECONDS is read the way an
// operator writes it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { cleanSearchIndex, startSearchUpkeep } from "../src/db/search-upkeep.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import { loadConfig } from "../src/config.ts";
import { cloneDatabase, type Fixture } from "./helpers.ts";
import { API_PASSWORD, PORT, SUPERUSER } from "./bootstrap.ts";
import { withEnv } from "./lib/env.ts";
import { fillPending, pendingPages } from "./lib/pending.ts";

/** Until `check` holds or `ms` pass; whether it held. */
async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await delay(10);
  }
  return check();
}

/**
 * A database whose one transaction, a pass, takes `ms` and is answered by `answer`,
 * which may throw. Counts the passes, and the most that were ever in progress at once.
 */
function stand(ms: number, answer: (n: number) => void = () => {}) {
  const seen = { calls: 0, active: 0, most: 0 };
  const statement = async () => [{ pages: 0 }];
  const begin = async (fn: (tx: typeof statement) => Promise<unknown>) => {
    const n = ++seen.calls;
    seen.active++;
    seen.most = Math.max(seen.most, seen.active);
    try {
      await delay(ms);
      answer(n);
      return await fn(statement);
    } finally {
      seen.active--;
    }
  };
  return { db: { write: { begin } } as unknown as Db, seen };
}

describe("the upkeep on a real database", () => {
  let fixture: Fixture;
  let db: Db;

  before(async () => {
    fixture = await cloneDatabase("search_upkeep");
    db = openDb({
      apiHost: "upkeep.invalid",
      publicOrigin: "https://upkeep.invalid",
      challengeKey: Buffer.from("a-challenge-key-that-is-long-enough", "utf8"),
      readOnly: false,
      logDir: null,
      welcomeSpace: null,
      db: { host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_api", password: API_PASSWORD },
    });
  });
  after(async () => {
    await db.end();
    await fixture.end();
  });

  const empty = async () => {
    const pages = await pendingPages(fixture.name);
    return pages.post_search_gin === 0 && pages.post_search_seekable_gin === 0;
  };

  test("empties the lists at start and again after each interval, and nothing once stopped", async () => {
    await fillPending(fixture.name, 300);
    assert.equal(await empty(), false, "the lists were not filled");
    const upkeep = startSearchUpkeep(db, 50);
    try {
      assert.ok(await until(empty), "the first pass did not empty the lists");
      await fillPending(fixture.name, 300);
      assert.ok(await until(empty), "a later pass did not empty the lists again");
    } finally {
      await upkeep.stop();
    }
    await fillPending(fixture.name, 300);
    await delay(250);
    assert.equal(await empty(), false, "a stopped upkeep went on emptying the lists");
  });

  test("a pass that cannot finish gives its connection back after a second", async () => {
    // A REINDEX left open holds the index, so the flush waits until its bound ends
    // it: one second, not the api role's five.
    const su = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
    const holder = await su.reserve();
    try {
      await holder`begin`;
      await holder`reindex index schellingaf.post_search_gin`;
      const started = performance.now();
      await assert.rejects(cleanSearchIndex(db), { code: "57014" });
      const took = performance.now() - started;
      assert.ok(took < 3_000, `the pass held its connection for ${Math.round(took)} ms`);
    } finally {
      await holder`rollback`;
      holder.release();
      await su.end({ timeout: 5 });
    }
  });
});

describe("the upkeep's loop", () => {
  test("the first pass runs at start, not an interval later", async () => {
    const { db, seen } = stand(1);
    const upkeep = startSearchUpkeep(db, 60_000);
    const ran = await until(() => seen.calls === 1, 1_000);
    await upkeep.stop();
    assert.ok(ran, "nothing ran in the upkeep's first second");
  });

  test("a pass never starts while the one before is still running", async () => {
    const { db, seen } = stand(30);
    const upkeep = startSearchUpkeep(db, 1);
    await until(() => seen.calls >= 4);
    await upkeep.stop();
    assert.ok(seen.calls >= 4, `only ${seen.calls} passes ran`);
    assert.equal(seen.most, 1, "two passes ran at once");
  });

  test("stop waits for the pass in progress, and nothing runs after it", async () => {
    const { db, seen } = stand(100);
    const upkeep = startSearchUpkeep(db, 1);
    await until(() => seen.active === 1);
    let stopped = false;
    const stopping = upkeep.stop().then(() => (stopped = true));
    await delay(20);
    assert.equal(stopped, false, "stop returned while a pass was still talking to the database");
    await stopping;
    assert.equal(seen.active, 0);
    const calls = seen.calls;
    await delay(150);
    assert.equal(seen.calls, calls, "a pass ran after stop");
  });

  test("an interval longer than a timer can hold still waits", async () => {
    const { db, seen } = stand(1);
    const upkeep = startSearchUpkeep(db, 3_000_000_000);
    await delay(150);
    await upkeep.stop();
    assert.equal(seen.calls, 1, "the upkeep ran again at once");
  });

  test("a database that is away is reported once, retried, and its return is reported", async () => {
    const lines: string[] = [];
    const { db, seen } = stand(1, (n) => {
      if (n <= 5) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });
    const upkeep = startSearchUpkeep(db, 1, (line) => lines.push(line));
    await until(() => seen.calls >= 8);
    await upkeep.stop();
    assert.ok(seen.calls >= 8, "the upkeep stopped retrying");
    assert.deepEqual(lines, [
      "search index upkeep failed, and is retried: connect ECONNREFUSED 127.0.0.1:5432\n",
      "search index upkeep: running again\n",
    ]);
  });

  test("a pass that runs into the statement timeout is no failure, and the next one comes", async () => {
    // Writers filling the lists faster than a pass flushes them keep it going until the
    // api role's statement timeout cancels it; what it flushed stays flushed.
    const lines: string[] = [];
    const { db, seen } = stand(1, (n) => {
      if (n <= 3) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    });
    const upkeep = startSearchUpkeep(db, 1, (line) => lines.push(line));
    await until(() => seen.calls >= 6);
    await upkeep.stop();
    assert.ok(seen.calls >= 6, "the upkeep stopped after a pass that timed out");
    assert.deepEqual(lines, []);
  });
});

describe("SEARCH_INDEX_UPKEEP_SECONDS", () => {
  const required = {
    API_HOST: "upkeep.invalid",
    PUBLIC_ORIGIN: "https://upkeep.invalid",
    CHALLENGE_KEY: "a-challenge-key-that-is-long-enough",
    DB_PASSWORD: "a-db-password-that-is-long-enough",
  };
  const read = (value: string | undefined) =>
    withEnv({ ...required, SEARCH_INDEX_UPKEEP_SECONDS: value }, () => loadConfig().searchUpkeepSeconds);

  test("is a second unless set, 0 switches it off, and what cannot be read is the default", async () => {
    assert.equal(await read(undefined), 1);
    assert.equal(await read("0"), 0);
    assert.equal(await read("5"), 5);
    assert.equal(await read("0.5"), 0.5);
    for (const value of ["", "lots", "-1", "NaN"]) assert.equal(await read(value), 1, JSON.stringify(value));
  });
});
