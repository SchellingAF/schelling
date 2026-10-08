// A SPACE's credit (migrations/0149_space_credit.sql): one balance a SPACE and the keyed
// ledger every change writes. Only the owner role posts an entry in this release, so every
// posting here is the owner's; the api role is held to reading nothing and posting nothing,
// and to the one thing it may run, the reconciliation.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { MIGRATE_PASSWORD, PORT, SUPERUSER } from "./bootstrap.ts";

let fixture: Fixture;
let ownerKey: Buffer;

const opened = setUp(async () => {
  fixture = await cloneDatabase("credit_ledger");
  ownerKey = publicKey("credit-ledger-owner");
  await fixture.owner`select schellingaf.register_peer(${ownerKey})`;
});
after(async () => {
  await opened;
  await fixture.end();
});

let n = 0;

/** A new SPACE's id. */
async function space(): Promise<string> {
  await opened;
  const name = `credit-${process.pid}-${n++}`;
  await fixture.owner`
    select schellingaf.create_space(p_owner => decode(${peerIdOf(ownerKey)}, 'hex'), p_name => ${name}, p_title => 'Credit',
                                    p_visibility => 'public')`;
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return row!.id;
}

type Posted = { entry_id: string; balance_after_micro: string; replayed: boolean };

function credit(id: string, kind: string, amount: number, key: string, note = "", sql: postgres.Sql = fixture.owner): Promise<Posted> {
  return sql<Posted[]>`
    select entry_id::text, balance_after_micro::text, replayed
      from schellingaf.credit_post(${id}::uuid, ${kind}, ${amount}::bigint, ${key}, ${note})`.then((rows) => rows[0]!);
}

async function balance(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`select balance_micro::text as b from schellingaf.space_credit where space_id = ${id}::uuid`;
  return Number(row?.b ?? 0);
}

async function entries(id: string): Promise<{ kind: string; amount: number; after: number }[]> {
  const rows = await fixture.owner<{ kind: string; amount: string; after: string }[]>`
    select kind, amount_micro::text as amount, balance_after_micro::text as after
      from schellingaf.credit_ledger where space_id = ${id}::uuid order by entry_id`;
  return rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), after: Number(r.after) }));
}

describe("posting", () => {
  test("a deposit then a bill move the balance and write the balance each leaves", async () => {
    const id = await space();
    const d = await credit(id, "deposit", 1_000_000, `deposit:${randomUUID()}`, "a test deposit");
    assert.deepEqual({ after: d.balance_after_micro, replayed: d.replayed }, { after: "1000000", replayed: false });
    const b = await credit(id, "bill", -250, `bill:${id}:2026-10-08`);
    assert.equal(b.balance_after_micro, "999750");
    assert.equal(await balance(id), 999_750);
    assert.deepEqual(await entries(id), [
      { kind: "deposit", amount: 1_000_000, after: 1_000_000 },
      { kind: "bill", amount: -250, after: 999_750 },
    ]);
  });

  test("the same key replays its entry and writes nothing; with another amount it is IDEMPOTENCY_CONFLICT", async () => {
    const id = await space();
    const key = `deposit:${randomUUID()}`;
    const first = await credit(id, "deposit", 500, key);
    const again = await credit(id, "deposit", 500, key);
    assert.deepEqual(again, { ...first, replayed: true });
    assert.equal((await entries(id)).length, 1);
    assert.equal(await balance(id), 500);
    await assert.rejects(credit(id, "deposit", 501, key), /IDEMPOTENCY_CONFLICT/);
    const other = await space();
    await assert.rejects(credit(other, "deposit", 500, key), /IDEMPOTENCY_CONFLICT/, "the same key for another SPACE");
    assert.equal(await balance(id), 500);
  });

  test("a bill past the balance is refused and changes nothing; no such SPACE is SPACE_NOT_FOUND", async () => {
    const id = await space();
    await credit(id, "deposit", 100, `deposit:${randomUUID()}`);
    await assert.rejects(credit(id, "bill", -101, `bill:${id}:2026-10-07`), (e: any) => {
      assert.equal(e.message, "INVALID_REQUEST");
      assert.equal(e.detail, "the balance would fall below zero");
      return true;
    });
    assert.equal(await balance(id), 100);
    assert.equal((await entries(id)).length, 1);
    await assert.rejects(credit(randomUUID(), "deposit", 1, `deposit:${randomUUID()}`), /SPACE_NOT_FOUND/);
  });

  test("fifty postings at once to one SPACE leave the balance the sum of its ledger, each entry after the last", async () => {
    const id = await space();
    await credit(id, "deposit", 1_000_000, `deposit:${randomUUID()}`);
    const many = postgres({
      host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD,
      max: 20, onnotice: () => {},
    });
    try {
      await Promise.all(Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0
          ? credit(id, "deposit", 1000, `deposit:${randomUUID()}`, "", many)
          : credit(id, "adjustment", -500, `adjustment:concurrent-${i}-${randomUUID()}`, "", many)));
    } finally {
      await many.end({ timeout: 5 });
    }
    const rows = await entries(id);
    assert.equal(rows.length, 51);
    assert.equal(await balance(id), 1_000_000 + 25 * 1000 - 25 * 500);
    assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), await balance(id));
    let running = 0;
    for (const r of rows) {
      running += r.amount;
      assert.equal(r.after, running, "each entry's balance follows the one before it");
    }
  });

  test("the CHECKs refuse a positive bill and a bill's key on a deposit, and an entry is never changed or deleted", async () => {
    const id = await space();
    await credit(id, "deposit", 1000, `deposit:${randomUUID()}`);
    await assert.rejects(credit(id, "bill", 5, `bill:${id}:2026-10-06`), /credit_ledger_sign/);
    await assert.rejects(credit(id, "deposit", 5, `bill:${id}:2026-10-06`), /credit_ledger_key_kind/);
    await assert.rejects(fixture.owner`update schellingaf.credit_ledger set note = 'changed' where space_id = ${id}::uuid`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`delete from schellingaf.credit_ledger where space_id = ${id}::uuid`, /IMMUTABLE_RECORD/);
    assert.equal((await entries(id)).length, 1);
    assert.equal(await balance(id), 1000);
  });
});

/** A connection of its own as the owner role, for a posting held open beside another. */
function ownConnection(): postgres.Sql {
  return postgres({
    host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD,
    max: 1, onnotice: () => {},
  });
}

/** Posts in a transaction held open until `go`, on its own connection. */
function heldPosting(sql: postgres.Sql, id: string, kind: string, amount: number, key: string) {
  const posted = Promise.withResolvers<Posted>();
  const go = Promise.withResolvers<void>();
  const done = sql.begin(async (tx) => {
    posted.resolve(await credit(id, kind, amount, key, "", tx as unknown as postgres.Sql));
    await go.promise;
  });
  done.catch((e) => posted.reject(e));
  return { posted: posted.promise, commit: () => { go.resolve(); return done; } };
}

/** Waits until a posting waits on a lock. */
async function someoneWaits() {
  // As the superuser, which sees every session's statement.
  const su = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
  try {
    for (let i = 0; i < 500; i++) {
      const [row] = await su<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and query like '%credit_post%'
           and pid <> pg_backend_pid()`;
      if (row!.n >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no posting waited");
  } finally {
    await su.end({ timeout: 5 });
  }
}

describe("postings at the same moment", () => {
  test("a second posting with the key waits for the first and replays it, though the balance has moved", async () => {
    const id = await space();
    await credit(id, "deposit", 100, `deposit:${randomUUID()}`);
    const key = `adjustment:same-${randomUUID()}`;
    const one = ownConnection();
    const two = ownConnection();
    try {
      const first = heldPosting(one, id, "adjustment", -100, key);
      const firstPosted = await first.posted;
      // The same posting again: it waits on the balance's lock, then finds the key.
      const second = credit(id, "adjustment", -100, key, "", two);
      second.catch(() => {});
      await someoneWaits();
      await first.commit();
      const again = await second;
      assert.deepEqual(again, { ...firstPosted, replayed: true }, "a replay, not a refusal for the balance it would leave");
    } finally {
      await one.end({ timeout: 5 });
      await two.end({ timeout: 5 });
    }
    assert.equal(await balance(id), 0);
    assert.equal((await entries(id)).length, 2);
  });

  test("the same key for two SPACES at once is IDEMPOTENCY_CONFLICT for the second", async () => {
    const a = await space();
    const b = await space();
    const key = `deposit:${randomUUID()}`;
    const one = ownConnection();
    const two = ownConnection();
    try {
      const first = heldPosting(one, a, "deposit", 700, key);
      await first.posted;
      const second = credit(b, "deposit", 700, key, "", two);
      second.catch(() => {});
      await someoneWaits();
      await first.commit();
      await assert.rejects(second, (e: any) => {
        assert.equal(e.message, "IDEMPOTENCY_CONFLICT");
        assert.notEqual(e.code, "23505");
        return true;
      });
    } finally {
      await one.end({ timeout: 5 });
      await two.end({ timeout: 5 });
    }
    assert.equal(await balance(a), 700);
    assert.equal(await balance(b), 0);
    assert.deepEqual(await entries(b), []);
  });
});

describe("the ledger's rules", () => {
  test("an amount of 0 is an adjustment's alone", async () => {
    const id = await space();
    await credit(id, "deposit", 50, `deposit:${randomUUID()}`);
    const zero = await credit(id, "adjustment", 0, `adjustment:zero-${randomUUID()}`);
    assert.equal(zero.balance_after_micro, "50");
    await assert.rejects(credit(id, "deposit", 0, `deposit:${randomUUID()}`), /credit_ledger_nonzero/);
    await assert.rejects(credit(id, "bill", 0, `bill:${id}:2026-10-05`), /credit_ledger_nonzero/);
    assert.deepEqual(await entries(id), [{ kind: "deposit", amount: 50, after: 50 }, { kind: "adjustment", amount: 0, after: 50 }]);
  });

  test("TRUNCATE of the ledger or the bills is refused", async () => {
    // Refused by its trigger, and since 0152 first by the deposits that reference it.
    await assert.rejects(fixture.owner`truncate schellingaf.credit_ledger`, /IMMUTABLE_RECORD|referenced in a foreign key constraint/);
    await assert.rejects(fixture.owner`truncate schellingaf.space_bills`, /IMMUTABLE_RECORD/);
  });
});

/** The runbook's SQL between `-- <name> begin` and `-- <name> end`, one statement a string,
 *  its placeholders filled, its begin and commit left to the test's transaction. */
function runbookBlock(name: string, values: Record<string, string>): string[] {
  const lines = readFileSync(new URL("../runbooks/credit.md", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  const from = lines.indexOf(`-- ${name} begin`);
  const to = lines.indexOf(`-- ${name} end`);
  assert.ok(from >= 0 && to > from, `the runbook marks ${name}`);
  let text = lines.slice(from + 1, to).filter((l) => l !== "begin;" && l !== "commit;").join("\n");
  for (const [k, v] of Object.entries(values)) text = text.replaceAll(k, v);
  assert.doesNotMatch(text, /<[a-z][^>]*>/, "every placeholder filled");
  return text.split(/;\n?/).map((t) => t.trim()).filter((t) => t !== "");
}

/** Runs the runbook's fault-clearing steps as written, in one transaction. */
async function clearFault(id: string, d: number): Promise<void> {
  const values = { "<space_id>": id, "<d>": String(d), "<a label used once>": `runbook-${randomUUID()}`, "<why, in a sentence>": "a test of the runbook" };
  await fixture.owner.begin(async (tx) => {
    let last: unknown[] = [];
    for (const statement of runbookBlock("fault fix", values)) last = [...await tx.unsafe(statement)];
    assert.deepEqual(last, [], "the comparison answers no row");
    for (const statement of runbookBlock("fault clear", values)) await tx.unsafe(statement);
  });
}

async function faulted(id: string): Promise<boolean> {
  await fixture.api`select schellingaf.credit_reconcile()`;
  const [row] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.credit_faults where space_id = ${id}::uuid`;
  return row!.n === 1;
}

describe("the runbook clears a fault", () => {
  test("a ledger short of a deposit: the adjustment writes it, and the balance is the true one", async () => {
    const id = await space();
    await credit(id, "deposit", 1000, `deposit:${randomUUID()}`);
    // 500 arrived and the balance was moved by hand, with no entry.
    await fixture.owner`update schellingaf.space_credit set balance_micro = balance_micro + 500 where space_id = ${id}::uuid`;
    assert.equal(await faulted(id), true);
    await clearFault(id, 500);
    assert.equal(await faulted(id), false, "reconciliation finds nothing");
    assert.equal(await balance(id), 1500, "the true balance, no more");
    assert.deepEqual((await entries(id)).at(-1), { kind: "adjustment", amount: 500, after: 1500 });
  });

  test("a balance changed by hand, then a posting: the hand change is undone and no credit is made", async () => {
    const id = await space();
    await credit(id, "deposit", 1000, `deposit:${randomUUID()}`);
    await fixture.owner`update schellingaf.space_credit set balance_micro = 1300 where space_id = ${id}::uuid`;
    // The posting carries the wrong balance into its balance_after.
    assert.equal((await credit(id, "deposit", 200, `deposit:${randomUUID()}`)).balance_after_micro, "1500");
    assert.equal(await faulted(id), true);
    await clearFault(id, 0);
    assert.equal(await faulted(id), false, "reconciliation finds nothing");
    assert.equal(await balance(id), 1200, "the ledger's sum: the 300 made by hand is gone");
    assert.deepEqual((await entries(id)).at(-1), { kind: "adjustment", amount: 0, after: 1200 });
  });
});

describe("the api role", () => {
  test("cannot post an entry and reads no row of the three tables", async () => {
    const id = await space();
    await credit(id, "deposit", 1000, `deposit:${randomUUID()}`);
    await assert.rejects(credit(id, "deposit", 1000, `deposit:${randomUUID()}`, "", fixture.api), /permission denied/);
    for (const table of ["space_credit", "credit_ledger", "credit_faults"]) {
      await assert.rejects(fixture.asCaller(null, (sql) => sql.unsafe(`select space_id from schellingaf.${table}`)), /permission denied/, table);
    }
    assert.equal(await balance(id), 1000);
  });

  test("credit_reconcile finds nothing on true rows, and records exactly the SPACE whose balance was changed by hand", async () => {
    const a = await space();
    const b = await space();
    await credit(a, "deposit", 300, `deposit:${randomUUID()}`);
    await credit(b, "deposit", 300, `deposit:${randomUUID()}`);
    await credit(b, "adjustment", -100, `adjustment:reconcile-${randomUUID()}`);
    const [none] = await fixture.api<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
    assert.equal(none!.n, 0);
    await fixture.owner`update schellingaf.space_credit set balance_micro = balance_micro + 1 where space_id = ${b}::uuid`;
    const [one] = await fixture.api<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
    assert.equal(one!.n, 1);
    const faults = await fixture.owner<{ id: string; balance: string; ledger: string; last: string }[]>`
      select space_id::text as id, balance_micro::text as balance, ledger_micro::text as ledger, last_after::text as last
        from schellingaf.credit_faults`;
    assert.deepEqual(faults.map((f) => ({ ...f })), [{ id: b, balance: "201", ledger: "200", last: "200" }]);
    // Again: the fault is held once, and a posting is still taken.
    const [still] = await fixture.api<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
    assert.equal(still!.n, 1);
    const posted = await credit(b, "deposit", 10, `deposit:${randomUUID()}`);
    assert.equal(posted.balance_after_micro, "211");
  });
});

describe("reconciliation's second comparison", () => {
  test("a balance equal to its ledger's sum but not to its newest balance_after is a fault", async () => {
    const id = await space();
    await credit(id, "deposit", 300, `deposit:${randomUUID()}`);
    // An entry written past credit_post, its sum right and its balance_after wrong.
    await fixture.owner`
      insert into schellingaf.credit_ledger (space_id, kind, amount_micro, balance_after_micro, idempotency_key)
      values (${id}::uuid, 'adjustment', 50, 999, ${`adjustment:by-hand-${randomUUID()}`})`;
    await fixture.owner`update schellingaf.space_credit set balance_micro = 350 where space_id = ${id}::uuid`;
    assert.equal(await faulted(id), true);
    const [fault] = await fixture.owner<{ balance: string; ledger: string; last: string }[]>`
      select balance_micro::text as balance, ledger_micro::text as ledger, last_after::text as last
        from schellingaf.credit_faults where space_id = ${id}::uuid`;
    assert.deepEqual({ ...fault }, { balance: "350", ledger: "350", last: "999" });
  });
});
