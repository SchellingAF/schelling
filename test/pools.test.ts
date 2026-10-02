// A pool's first statements, which postgres.js builds before it has learned the
// database's array types: an array parameter there goes out as its element type
// and the database refuses it. The service warms both pools before it takes a
// request (warm in src/db/sql.ts, awaited by src/server.ts), and this file holds
// that a warmed pool sends arrays correctly from its very first burst.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cloneDatabase, setUp, type Fixture } from "./helpers.ts";
import { testConfig } from "./lib/service.ts";
import { openDb, warm } from "../src/db/sql.ts";

let fixture: Fixture;

const opened = setUp(async () => {
  fixture = await cloneDatabase("pools");
});
after(async () => {
  await opened;
  await fixture.end();
});

test("a warmed pool's first burst of statements sends every array as an array, on both pools", async () => {
  const bytes = [Buffer.from("ab", "hex"), Buffer.from("cd", "hex")];
  const db = openDb(testConfig(fixture.name));
  try {
    await warm(db);
    // More at once than either pool holds, so connections the warm-up never
    // opened are opened by this burst, each with one of these as its first
    // statement. Outside a transaction, where BEGIN would be built first.
    for (const [name, pool] of [["write", db.write], ["read", db.read]] as const) {
      const sent = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? pool<{ x: Buffer[] }[]>`select ${pool.array(bytes)}::bytea[] as x`
            : pool<{ x: string[] }[]>`select ${pool.array(["a", "b"])}::text[] as x`,
        ),
      );
      const refused = sent.flatMap((s) => (s.status === "rejected" ? [(s.reason as Error).message] : []));
      assert.deepEqual(refused, [], `the ${name} pool mis-sent an array`);
      for (const [i, s] of sent.entries()) {
        const x = (s as PromiseFulfilledResult<{ x: unknown[] }[]>).value[0]!.x;
        assert.deepEqual(x, i % 2 === 0 ? bytes : ["a", "b"], `the ${name} pool's statement ${i}`);
      }
    }
  } finally {
    await db.end();
  }
});
