// What readTx leaves on a connection: nothing of its caller.
//
// Every read runs inside readTx (src/db/sql.ts), whose first statement binds the caller for
// its transaction alone. So the next transaction on that connection, and any statement
// outside one, reads as nobody, whatever the last one did: committed, threw, or failed in
// the database. The service's own pools run here with one read connection, so every step
// below runs on the same one.
//
// Written by the security review of 7 October 2026.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { API_PASSWORD, PORT } from "./bootstrap.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import type { Config } from "../src/config.ts";

let fixture: Fixture;
let db: Db;
let owner: string;
let stranger: string;

const opened = setUp(async () => {
  fixture = await cloneDatabase("sec_db_access_readtx");
  const ownerKey = publicKey("sec-readtx-owner");
  const memberKey = publicKey("sec-readtx-member");
  const strangerKey = publicKey("sec-readtx-stranger");
  for (const key of [ownerKey, memberKey, strangerKey]) await fixture.owner`select schellingaf.register_peer(${key})`;
  owner = peerIdOf(ownerKey);
  stranger = peerIdOf(strangerKey);
  await fixture.owner`select schellingaf.create_space(p_owner => decode(${owner}, 'hex'), p_name => 'sec-readtx', p_title => 'Kept', p_visibility => 'private')`;
  await fixture.owner`select schellingaf.grant_membership('sec-readtx', decode(${owner}, 'hex'), decode(${peerIdOf(memberKey)}, 'hex'), 'writer', null)`;
  const config = { db: { host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_api", password: API_PASSWORD } } as Config;
  db = openDb(config, { readPool: 1 });
});

after(async () => {
  await opened;
  await db.end();
  await fixture.end();
});

type Seen = { bound: string | null; members: number };

/** Who a connection reads as, and how many of the private SPACE's members it reads. */
const seen = async (sql: postgres.Sql): Promise<Seen> => {
  const [row] = await sql<Seen[]>`
    select current_setting('schellingaf.peer_id', true) as bound,
           (select count(*)::int from schellingaf.memberships m
              join schellingaf.spaces s on s.space_id = m.space_id where s.name = 'sec-readtx') as members`;
  return row!;
};

/** What the next readers on a pool read of the caller before them: nothing, or what leaked. */
async function leftBehind(pool: { bare: postgres.Sql; tx: (fn: (sql: postgres.Sql) => Promise<Seen>) => Promise<Seen> }): Promise<string[]> {
  const leaks: string[] = [];
  for (const [who, read] of [["a statement outside a transaction", () => seen(pool.bare)], ["an anonymous readTx", () => pool.tx(seen)]] as const) {
    const s = await read();
    // Nobody: '' once a transaction on the connection bound it, null on one that never did.
    if (s.bound !== "" && s.bound !== null) leaks.push(`${who} reads as ${JSON.stringify(s.bound)}`);
    if (s.members !== 0) leaks.push(`${who} reads ${s.members} members of the private SPACE`);
  }
  return leaks;
}

const service = () => ({ bare: db.read, tx: (fn: (sql: postgres.Sql) => Promise<Seen>) => db.readTx(null, fn) });

describe("readTx binds its caller for its own transaction, and leaves nothing on the connection", () => {
  test("a caller's transaction reads as that caller, and the next reader as nobody", async () => {
    await opened;
    assert.deepEqual(await db.readTx(owner, seen), { bound: owner, members: 1 });
    assert.deepEqual(await db.readTx(stranger, seen), { bound: stranger, members: 0 });
    await db.readTx(owner, seen);
    assert.deepEqual(await leftBehind(service()), []);
  });

  test("so does one that threw after it read, and one whose statement the database refused", async () => {
    await opened;
    await assert.rejects(
      db.readTx(owner, async (sql) => {
        assert.equal((await seen(sql)).members, 1);
        throw new Error("the route refused");
      }),
      /the route refused/,
    );
    assert.deepEqual(await leftBehind(service()), [], "after a throw");
    await assert.rejects(
      db.readTx(owner, async (sql) => {
        assert.equal((await seen(sql)).members, 1);
        await sql`select 1 / 0`;
      }),
      (e: { code?: string }) => e.code === "22012",
    );
    assert.deepEqual(await leftBehind(service()), [], "after a failed statement");
  });

  test("two callers asking at once on the one connection each read as themselves", async () => {
    await opened;
    const slow = async (sql: postgres.Sql) => {
      await sql`select pg_sleep(0.05)`;
      return seen(sql);
    };
    const [a, b, c] = await Promise.all([db.readTx(owner, slow), db.readTx(stranger, slow), db.readTx(null, slow)]);
    assert.deepEqual([a, b, c], [{ bound: owner, members: 1 }, { bound: stranger, members: 0 }, { bound: "", members: 0 }]);
  });

  test("the check above finds a caller bound for the session, which outlives its transaction", async () => {
    await opened;
    const raw = postgres({ host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_api", password: API_PASSWORD, max: 1, onnotice: () => {} });
    try {
      await raw.begin(async (tx) => {
        await tx`select set_config('schellingaf.peer_id', ${owner}, false)`;
      });
      const leaks = await leftBehind({
        bare: raw,
        tx: (fn) => raw.begin(async (tx) => {
          await tx`select set_config('schellingaf.peer_id', '', true)`;
          return fn(tx as unknown as postgres.Sql);
        }) as Promise<Seen>,
      });
      assert.deepEqual(leaks, [`a statement outside a transaction reads as ${JSON.stringify(owner)}`, "a statement outside a transaction reads 1 members of the private SPACE"]);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });
});
