// The real bill (migrations/0155_billing_real.sql, src/db/billing.ts): from
// billing_epoch.real_from each SPACE over its allowance is billed once a UTC day from its
// payer's balance, in one transaction with its ledger entry; free days write a row and take
// nothing; a bill that falls short freezes the payer, and a deposit or the sweep clears it;
// the operator's switch makes every later day shadow; and the payer's owner and first admins
// get a funding notice once a crossing.
//
// billing_epoch.real_from is set in the past here, as the owner, so the September days billed
// are real. A SPACE is put over its allowance by setting its counter as the owner: 6,000,000
// bytes over the public allowance is a day of 1,000 micro-dollars. Bills are asked of
// bill_space_day() as the api role, as the job asks them; billOnce() runs on days whose
// recount is recorded, so the counters set here stand.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { useService, fixture, db, call, agent, type Agent } from "./lib/service.ts";
import { addDays, billOnce, utcDate, type DayLine } from "../src/db/billing.ts";
import { FUNDING, dailyMicroUsd } from "../src/surface/vocabulary.ts";
import { waitingNow } from "../src/http/wait.ts";
import { PORT } from "./bootstrap.ts";
import { DRILL_MARK, dryRun, loopback, refusal } from "../scripts/billing-dry-run.ts";
import postgres from "postgres";
import { spawn } from "node:child_process";
import path from "node:path";
import * as sealed from "../content/sealed.mjs";

const ready = useService("billing_real", { apiHost: "api.billing-real.test" });

const PUB = FUNDING.allowanceBytes.public;
/** Bytes over the public allowance that cost 1,000 micro-dollars a day. */
const OVER = 6_000_000;
const DAY = 1000;

let n = 0;
/** Every SPACE this file makes: none may reach a day's line. */
const made: { name: string; id: string }[] = [];
let owner: Agent;

before(async () => {
  await ready;
  owner = await agent();
  await live();
});

/** Billing live from 1 September, the switch on real. */
async function live() {
  await fixture.owner`update schellingaf.billing_epoch set real_from = '2026-09-01', mode = 'real'`;
}

const newName = () => `billing-real-${process.pid}-${n++}`;

async function idOf(name: string): Promise<string> {
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return row!.id;
}

/** A public SPACE made long before the days billed here, `over` bytes above its allowance. */
async function space(over: number | null = OVER, who: Agent = owner): Promise<{ name: string; id: string }> {
  const name = newName();
  await refill(who);
  const out = await call("POST", "/v1/spaces", who.token, { name, title: "Billing", visibility: "public" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  await fixture.owner`update schellingaf.spaces set created_at = '2026-01-01' where name = ${name}`;
  const s = { name, id: await idOf(name) };
  made.push(s);
  if (over !== null) await setBytes(s.id, PUB + over);
  return s;
}

/** A SPACE's post counter, set as the owner. */
async function setBytes(id: string, bytes: number) {
  await fixture.owner`
    insert into schellingaf.space_storage as t (space_id, post_bytes) values (${id}::uuid, ${bytes})
    on conflict (space_id) do update set post_bytes = excluded.post_bytes`;
}

async function deposit(id: string, micro: number) {
  await fixture.owner`select * from schellingaf.credit_post(${id}::uuid, 'deposit', ${micro}, ${`deposit:${randomUUID()}`}, 'a test')`;
}

type Delivered = { recipient: string; mailbox_seq: string }[];

/**
 * Opens a day as the job holds it while it bills, begun and not finished, and answers how
 * to put its run back as it was: a tick here may have finished the day already.
 */
async function openDay(day: string): Promise<() => Promise<void>> {
  const [was] = await fixture.owner<{ finished_at: Date | null; summary: unknown }[]>`
    select finished_at, summary from schellingaf.billing_runs where day = ${day}::date`;
  await fixture.owner`
    insert into schellingaf.billing_runs (day) values (${day}::date)
    on conflict (day) do update set finished_at = null, summary = null`;
  return async () => {
    if (was === undefined) await fixture.owner`delete from schellingaf.billing_runs where day = ${day}::date`;
    else await fixture.owner`
      update schellingaf.billing_runs set finished_at = ${was.finished_at}, summary = ${was.summary === null ? null : fixture.owner.json(was.summary as never)}
       where day = ${day}::date`;
  };
}

/** One bill, asked as the api role, as the job asks it: of a day it is billing. */
async function bill(id: string, day: string): Promise<{ state: string; delivered: Delivered }> {
  const restore = await openDay(day);
  try {
    const [row] = await fixture.api<{ state: string; delivered: Delivered }[]>`
      select state, delivered from schellingaf.bill_space_day(${id}::uuid, ${day}::date)`;
    return row!;
  } finally {
    await restore();
  }
}

type Credit = { balance: number; frozen: boolean; since: Date | null; free_until: string | null; notice: string };

async function credit(id: string): Promise<Credit> {
  const [row] = await fixture.owner<{ balance: string; frozen: boolean; since: Date | null; free_until: string | null; notice: string }[]>`
    select balance_micro::text as balance, frozen, frozen_since as since, free_until::text, notice
      from schellingaf.space_credit where space_id = ${id}::uuid`;
  return row ? { ...row, balance: Number(row.balance) } : { balance: 0, frozen: false, since: null, free_until: null, notice: "none" };
}

type Row = { day: string; due: number; taken: number; shadow: boolean; free: boolean; payer: string | null; task_bytes: number };

async function rows(id: string): Promise<Row[]> {
  const out = await fixture.owner<{ day: string; due: string; taken: string; shadow: boolean; free: boolean; payer: string | null; task_bytes: string }[]>`
    select day::text, due_micro::text as due, taken_micro::text as taken, shadow, free, payer_id::text as payer, task_bytes::text
      from schellingaf.space_bills where space_id = ${id}::uuid order by day`;
  return out.map((r) => ({ ...r, due: Number(r.due), taken: Number(r.taken), task_bytes: Number(r.task_bytes) }));
}

type Entry = { id: number; kind: string; amount: number; key: string };

async function ledger(id: string): Promise<Entry[]> {
  const out = await fixture.owner<{ id: string; kind: string; amount: string; key: string }[]>`
    select entry_id::text as id, kind, amount_micro::text as amount, idempotency_key as key
      from schellingaf.credit_ledger where space_id = ${id}::uuid order by entry_id`;
  return out.map((e) => ({ id: Number(e.id), kind: e.kind, amount: Number(e.amount), key: e.key }));
}

/** The funding notices delivered about a SPACE: recipient, credit_notice and credit_day. */
async function notices(id: string) {
  return [...await fixture.owner<{ recipient: string; notice: string; day: string }[]>`
    select encode(recipient_id, 'hex') as recipient, credit_notice as notice, credit_day::text as day
      from schellingaf.mailbox_deliveries where space_id = ${id}::uuid and reason = 'funding'
     order by mailbox_seq, recipient_id`];
}

/** A KEY's write allowance full again: this file writes more than a KEY may in a few seconds. */
async function refill(who: Agent) {
  await fixture.setBucket(`peer:${who.peerId}`, 60);
}

async function grant(name: string, who: Agent, role: string) {
  await refill(owner);
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/**
 * Recovers a SPACE into `next`, made, as the successor is here, long before the days billed:
 * a predecessor's day is billed only to a payer that existed on it.
 */
async function recover(name: string, next: string) {
  await fixture.owner`select schellingaf.recover_space(${name}, ${next}, 'a test')`;
  await fixture.owner`update schellingaf.spaces set created_at = '2026-01-02' where name = ${next}`;
}

/** No day begun: the next tick bills yesterday alone. */
async function fresh() {
  await fixture.owner`delete from schellingaf.billing_runs`;
}

/** One tick at `now`, its first day begun with its recount recorded. */
async function tick(now: Date, lines: string[] = []) {
  const yesterday = addDays(utcDate(now), -1);
  const [next] = await fixture.owner<{ day: string | null }[]>`select schellingaf.billing_next_day()::text as day`;
  const first = next?.day ?? yesterday;
  if (first <= yesterday) {
    await fixture.owner`
      insert into schellingaf.billing_runs as r (day, recounted_at) values (${first}::date, now())
      on conflict (day) do update set recounted_at = coalesce(r.recounted_at, now())`;
  }
  return billOnce(db, { now, log: (line) => lines.push(line) });
}

describe("the constants", () => {
  test("billing_rates() equals FUNDING, and day_due_micro() makes dailyMicroUsd()'s sum", async () => {
    const [r] = await fixture.api<{ rate: string; days: number; gb: string; pub: string; priv: string; seal: string }[]>`
      select micro_usd_per_gb_month::text as rate, days_per_month as days, bytes_per_gb::text as gb,
             public_bytes::text as pub, private_bytes::text as priv, sealed_bytes::text as seal from schellingaf.billing_rates()`;
    assert.deepEqual(
      { rate: Number(r!.rate), days: r!.days, gb: Number(r!.gb), public: Number(r!.pub), private: Number(r!.priv), sealed: Number(r!.seal) },
      { rate: FUNDING.microUsdPerGbMonth, days: FUNDING.daysPerMonth, gb: FUNDING.bytesPerGb, ...FUNDING.allowanceBytes },
    );
    for (const bytes of [0, 1, PUB, PUB + 1, PUB + 6000, PUB + 6001, PUB + 1_000_000_000_000]) {
      const [d] = await fixture.owner<{ due: string }[]>`select schellingaf.day_due_micro(${bytes}, ${PUB})::text as due`;
      assert.equal(Number(d!.due), dailyMicroUsd(bytes, PUB), `${bytes} bytes`);
    }
    const [one] = await fixture.owner<{ due: string }[]>`select schellingaf.day_due_micro(${PUB + OVER}, ${PUB})::text as due`;
    assert.equal(Number(one!.due), DAY);
  });

  test("real_from is the UTC date six hours on, plus one: a deploy near midnight never bills minutes later", async () => {
    const first = async (at: string) => (await fixture.owner<{ d: string }[]>`select schellingaf.billing_first_day(${at}::timestamptz)::text as d`)[0]!.d;
    assert.equal(await first("2026-10-09T00:00:00Z"), "2026-10-10");
    assert.equal(await first("2026-10-09T17:59:59Z"), "2026-10-10");
    assert.equal(await first("2026-10-09T18:00:00Z"), "2026-10-11");
    assert.equal(await first("2026-10-09T23:59:00Z"), "2026-10-11");
    assert.equal(await first("2026-10-10T01:00:00+02:00"), "2026-10-11", "the UTC date, not the zone's");
    const code = readFileSync(new URL("../migrations/0155_billing_real.sql", import.meta.url), "utf8");
    assert.match(code, /INSERT INTO schellingaf\.billing_epoch \(real_from\) VALUES \(schellingaf\.billing_first_day\(now\(\)\)\);/);
  });
});

describe("the bill", () => {
  test("a day before real_from is a shadow row: nothing taken, no ledger entry, no payer", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    await fixture.owner`update schellingaf.billing_epoch set real_from = '2026-09-10'`;
    try {
      assert.equal((await bill(s.id, "2026-09-09")).state, "shadow");
    } finally {
      await live();
    }
    assert.deepEqual(await rows(s.id), [{ day: "2026-09-09", due: DAY, taken: 0, shadow: true, free: false, payer: null, task_bytes: 0 }]);
    assert.deepEqual((await ledger(s.id)).map((e) => e.kind), ["deposit"]);
    assert.equal((await credit(s.id)).balance, 50_000);
  });

  test("a real day takes the due: one row, the ledger entry bill:<id>:<day>, the balance down, the ledger reconciled", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    const out = await bill(s.id, "2026-09-02");
    assert.deepEqual(out, { state: "billed", delivered: [] });
    assert.deepEqual(await rows(s.id), [{ day: "2026-09-02", due: DAY, taken: DAY, shadow: false, free: false, payer: s.id, task_bytes: 0 }]);
    const bills = (await ledger(s.id)).filter((e) => e.kind === "bill");
    assert.deepEqual(bills.map((e) => ({ amount: e.amount, key: e.key })), [{ amount: -DAY, key: `bill:${s.id}:2026-09-02` }]);
    assert.equal((await credit(s.id)).balance, 50_000 - DAY);
    await fixture.owner`select schellingaf.credit_reconcile()`;
    const [fault] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.credit_faults where space_id = ${s.id}::uuid`;
    assert.equal(fault!.n, 0);
  });

  test("task text is billed: the row keeps the task bytes, and they count toward the due", async () => {
    const s = await space(OVER - 6000);
    const body = "t".repeat(6000);
    // Credit first: at zero, a SPACE over its allowance is read-only (0157).
    await deposit(s.id, 50_000);
    const added = await call("POST", `/v1/spaces/${s.name}/tasks`, owner.token, { title: "Task", body });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await bill(s.id, "2026-09-02")).state, "billed");
    const [row] = await rows(s.id);
    assert.equal(row!.task_bytes, 6000 + 4);
    assert.equal(row!.due, dailyMicroUsd(PUB + OVER + 4, PUB));
  });

  test("a rerun writes nothing: bill_space_day twice, and billOnce twice and with its day set back", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    assert.equal((await bill(s.id, "2026-09-03")).state, "billed");
    assert.equal((await bill(s.id, "2026-09-03")).state, "already");
    await fresh();
    const now = new Date("2026-09-05T02:00:00Z");
    assert.deepEqual(await tick(now), { state: "billed", days: ["2026-09-04"] });
    assert.deepEqual(await tick(now), { state: "idle" });
    await fixture.owner`delete from schellingaf.billing_runs where day = '2026-09-04'`;
    assert.deepEqual(await tick(now), { state: "billed", days: ["2026-09-04"] });
    assert.deepEqual((await rows(s.id)).map((r) => r.day), ["2026-09-03", "2026-09-04"]);
    assert.equal((await ledger(s.id)).filter((e) => e.kind === "bill").length, 2);
    assert.equal((await credit(s.id)).balance, 50_000 - 2 * DAY);
  });

  test("a bill and a deposit started together, 20 rounds: the bill takes what the balance held when it locked, and frozen follows the final balance", async () => {
    for (let i = 0; i < 20; i++) {
      const s = await space();
      await deposit(s.id, 400);
      const amount = i % 2 === 0 ? 5000 : 300;
      const key = `deposit:${randomUUID()}`;
      const a = await fixture.api.reserve();
      const b = await fixture.owner.reserve();
      const restore = await openDay("2026-09-06");
      try {
        const gate = Promise.withResolvers<void>();
        const billing = (async () => {
          await gate.promise;
          return a<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-09-06')`;
        })();
        const depositing = (async () => {
          await gate.promise;
          return b`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', ${amount}, ${key}, 'a test')`;
        })();
        gate.resolve();
        await Promise.all([billing, depositing]);
      } finally {
        a.release();
        b.release();
        await restore();
      }
      const entries = await ledger(s.id);
      const billEntry = entries.find((e) => e.kind === "bill");
      const second = entries.find((e) => e.key === key)!;
      const billFirst = billEntry !== undefined && billEntry.id < second.id;
      const taken = billFirst ? Math.min(DAY, 400) : Math.min(DAY, 400 + amount);
      const [row] = await rows(s.id);
      assert.equal(row!.taken, taken, `round ${i}, bill first: ${billFirst}`);
      assert.equal(billEntry?.amount, -taken);
      const c = await credit(s.id);
      assert.equal(c.balance, entries.reduce((sum, e) => sum + e.amount, 0), "the balance is the ledger's sum");
      assert.equal(c.balance, 400 + amount - taken);
      assert.equal(c.frozen, c.balance < DAY, `round ${i}: frozen ${c.frozen}, balance ${c.balance}`);
      assert.equal(c.since !== null, c.frozen);
    }
  });

  test("two bills of one SPACE and day at once: one writes, the other answers already", async () => {
    const s = await space();
    const a = await fixture.api.reserve();
    const b = await fixture.api.reserve();
    const restore = await openDay("2026-09-07");
    try {
      const gate = Promise.withResolvers<void>();
      const one = (async () => { await gate.promise; return a<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-09-07')`; })();
      const two = (async () => { await gate.promise; return b<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-09-07')`; })();
      gate.resolve();
      const states = (await Promise.all([one, two])).map((r) => r[0]!.state).sort();
      assert.deepEqual(states, ["already", "short"]);
    } finally {
      a.release();
      b.release();
      await restore();
    }
    assert.equal((await rows(s.id)).length, 1);
    assert.equal((await notices(s.id)).length, 1, "one notice, from the bill that wrote");
  });

  test("balance 0: a row taking 0, no ledger entry, frozen with its time, short", async () => {
    const s = await space();
    const out = await bill(s.id, "2026-09-02");
    assert.equal(out.state, "short");
    assert.deepEqual(await rows(s.id), [{ day: "2026-09-02", due: DAY, taken: 0, shadow: false, free: false, payer: s.id, task_bytes: 0 }]);
    assert.deepEqual(await ledger(s.id), []);
    const c = await credit(s.id);
    assert.deepEqual({ frozen: c.frozen, notice: c.notice, balance: c.balance }, { frozen: true, notice: "read_only", balance: 0 });
    assert.ok(c.since instanceof Date);
    // A second short day keeps the time it was first frozen.
    assert.equal((await bill(s.id, "2026-09-03")).state, "short");
    assert.deepEqual((await credit(s.id)).since, c.since);
  });

  test("a balance below the due: it takes the balance, freezes, and leaves 0", async () => {
    const s = await space();
    await deposit(s.id, 250);
    assert.equal((await bill(s.id, "2026-09-02")).state, "short");
    assert.equal((await rows(s.id))[0]!.taken, 250);
    assert.deepEqual((await ledger(s.id)).map((e) => e.amount), [250, -250]);
    const c = await credit(s.id);
    assert.deepEqual({ frozen: c.frozen, balance: c.balance }, { frozen: true, balance: 0 });
  });

  test("a day that has not ended is refused", async () => {
    const s = await space();
    const today = utcDate(new Date());
    for (const day of [today, addDays(today, 1)]) {
      await assert.rejects(bill(s.id, day), (e: any) => e.message === "INVALID_REQUEST" && e.detail === "the day has not ended");
    }
    assert.deepEqual(await rows(s.id), []);
  });

  test("free days: a row with its due and nothing taken, no ledger entry; the day free_until names is billed", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    await fixture.owner`update schellingaf.space_credit set free_until = '2026-09-10' where space_id = ${s.id}::uuid`;
    assert.deepEqual(await bill(s.id, "2026-09-09"), { state: "free", delivered: [] });
    assert.equal((await bill(s.id, "2026-09-10")).state, "billed");
    assert.deepEqual(await rows(s.id), [
      { day: "2026-09-09", due: DAY, taken: 0, shadow: false, free: true, payer: s.id, task_bytes: 0 },
      { day: "2026-09-10", due: DAY, taken: DAY, shadow: false, free: false, payer: s.id, task_bytes: 0 },
    ]);
    assert.deepEqual((await ledger(s.id)).map((e) => e.key), [(await ledger(s.id))[0]!.key, `bill:${s.id}:2026-09-10`]);
  });

  test("a SPACE with a fault row is not billed", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    await fixture.owner`insert into schellingaf.credit_faults (space_id, balance_micro, ledger_micro) values (${s.id}::uuid, 1, 0)`;
    assert.equal((await bill(s.id, "2026-09-02")).state, "fault");
    assert.deepEqual(await rows(s.id), []);
  });

  test("a SPACE made after the day ended answers young", async () => {
    const s = await space();
    await fixture.owner`update schellingaf.spaces set created_at = '2026-09-03T00:00:00Z' where space_id = ${s.id}::uuid`;
    assert.equal((await bill(s.id, "2026-09-02")).state, "young");
    assert.equal((await bill(s.id, "2026-09-03")).state, "short");
  });
});

describe("who pays, and who is not billed", () => {
  test("a replaced SPACE's bill falls on its successor: its own row and key, the successor's ledger, and the successor's daily due counts it", async () => {
    const pred = await space();
    const next = newName();
    await recover(pred.name, next);
    const succ = { name: next, id: await idOf(next) };
    made.push(succ);
    await deposit(succ.id, 50_000);
    const out = await bill(pred.id, "2026-09-02");
    assert.equal(out.state, "billed");
    assert.deepEqual(await rows(pred.id), [{ day: "2026-09-02", due: DAY, taken: DAY, shadow: false, free: false, payer: succ.id, task_bytes: 0 }]);
    assert.deepEqual((await ledger(succ.id)).filter((e) => e.kind === "bill").map((e) => ({ amount: e.amount, key: e.key })), [
      { amount: -DAY, key: `bill:${pred.id}:2026-09-02` },
    ]);
    assert.deepEqual(await ledger(pred.id), [], "nothing on the replaced SPACE's own credit");
    assert.equal((await credit(succ.id)).balance, 50_000 - DAY);
    const [due] = await fixture.owner<{ own: string; all: string }[]>`
      select schellingaf.space_day_due(${succ.id}::uuid, 0, current_date)::text as own,
             schellingaf.space_daily_due(${succ.id}::uuid, 0, current_date)::text as all`;
    assert.deepEqual({ own: Number(due!.own), all: Number(due!.all) }, { own: 0, all: DAY });
  });

  test("a replaced SPACE's short bill freezes the successor, and its notice reaches the successor's owner and admins, about the successor", async () => {
    const pred = await space();
    const admin = await agent();
    const next = newName();
    await recover(pred.name, next);
    const succ = { name: next, id: await idOf(next) };
    made.push(succ);
    await grant(succ.name, admin, "admin");
    const out = await bill(pred.id, "2026-09-02");
    assert.equal(out.state, "short");
    assert.deepEqual(out.delivered.map((d) => d.recipient).sort(), [owner.peerId, admin.peerId].sort());
    assert.deepEqual((await notices(succ.id)).map((d) => d.recipient).sort(), [owner.peerId, admin.peerId].sort());
    assert.deepEqual(await notices(pred.id), [], "never about the replaced SPACE");
    assert.equal((await credit(succ.id)).frozen, true);
    assert.equal((await credit(pred.id)).frozen, false);
  });

  test("a SPACE the operator closed is not billed, nor one whose successor the operator closed", async () => {
    // Set by hand: the operator's own close; the service has no operation for it.
    const s = await space();
    await fixture.owner`update schellingaf.spaces set status = 'closed' where space_id = ${s.id}::uuid`;
    assert.deepEqual(await bill(s.id, "2026-09-02"), { state: "closed", delivered: [] });
    assert.deepEqual(await rows(s.id), []);

    const pred = await space();
    const next = newName();
    await recover(pred.name, next);
    const succ = await idOf(next);
    made.push({ name: next, id: succ });
    await fixture.owner`update schellingaf.spaces set status = 'closed' where space_id = ${succ}::uuid`;
    assert.equal((await bill(pred.id, "2026-09-02")).state, "closed");
    assert.deepEqual(await rows(pred.id), []);
  });

  test("a withheld SPACE is not billed; released, it is", async () => {
    const s = await space();
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${s.id}::uuid, 'abuse', 'a test')`;
    assert.equal((await bill(s.id, "2026-09-02")).state, "closed");
    await fixture.owner`update schellingaf.withheld_spaces set released_at = now() where space_id = ${s.id}::uuid and released_at is null`;
    assert.equal((await bill(s.id, "2026-09-03")).state, "short");
    assert.deepEqual((await rows(s.id)).map((r) => r.day), ["2026-09-03"]);
  });

  test("a predecessor's day that ended before its successor was made is billed to nobody: no_payer, no row, no entry", async () => {
    const pred = await space();
    await deposit(pred.id, 50_000);
    const next = newName();
    // Recovered now: the successor did not exist on 4 September.
    await fixture.owner`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
    const succ = { name: next, id: await idOf(next) };
    made.push(succ);
    assert.deepEqual(await bill(pred.id, "2026-09-04"), { state: "no_payer", delivered: [] });
    assert.deepEqual(await rows(pred.id), []);
    assert.deepEqual((await ledger(succ.id)).filter((e) => e.kind === "bill"), []);
    assert.equal((await credit(succ.id)).balance, 50_000);
    // The tick counts it in the day's line.
    await fresh();
    const lines: string[] = [];
    await tick(new Date("2026-09-05T03:00:00Z"), lines);
    const line = lines.map((l) => JSON.parse(l) as DayLine).find((l) => l.event === "billing.day")!;
    assert.ok(line.skipped.no_payer >= 1, JSON.stringify(line.skipped));
  });
});

describe("a recovery moves the credit", () => {
  test("the whole balance to the successor, by two keyed adjustments in the recovery's transaction, and a frozen flag and its notice with it", async () => {
    const pred = await space();
    await deposit(pred.id, 500);
    // Frozen below a day, as a short bill leaves it.
    await fixture.owner`update schellingaf.space_credit set frozen = true, frozen_since = '2026-09-03T00:00:00Z', notice = 'read_only' where space_id = ${pred.id}::uuid`;
    const next = newName();
    await recover(pred.name, next);
    const succ = { name: next, id: await idOf(next) };
    made.push(succ);
    assert.deepEqual(await credit(pred.id), { balance: 0, frozen: false, since: null, free_until: null, notice: "none" });
    const moved = await credit(succ.id);
    assert.deepEqual({ balance: moved.balance, frozen: moved.frozen, since: moved.since?.toISOString(), notice: moved.notice },
      { balance: 500, frozen: true, since: new Date("2026-09-03T00:00:00Z").toISOString(), notice: "read_only" });
    assert.deepEqual((await ledger(pred.id)).filter((e) => e.kind === "adjustment").map((e) => ({ amount: e.amount, key: e.key })),
      [{ amount: -500, key: `adjustment:recovery:${pred.id}:out` }]);
    assert.deepEqual((await ledger(succ.id)).map((e) => ({ kind: e.kind, amount: e.amount, key: e.key })),
      [{ kind: "adjustment", amount: 500, key: `adjustment:recovery:${pred.id}:in` }]);
    // The successor is read-only as its predecessor was, and a deposit covering a day opens it.
    const [refusal] = await fixture.api<{ r: string | null }[]>`select schellingaf.credit_refusal(${succ.id}::uuid, 0) as r`;
    assert.match(refusal!.r ?? "", /^with this write a day of storage costs /);
    await deposit(succ.id, DAY);
    assert.equal((await credit(succ.id)).frozen, false);
  });

  test("a recovery that commits while a bill waits for the credit row: the bill reads the payer again and bills the successor", async () => {
    const pred = await space();
    await deposit(pred.id, 50_000);
    const next = newName();
    const r = await fixture.owner.reserve();
    const restore = await openDay("2026-09-09");
    let billing: Promise<{ state: string }[]> | undefined;
    try {
      await r`begin`;
      await r`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
      await r`update schellingaf.spaces set created_at = '2026-01-02' where name = ${next}`;
      // The bill reads its payer, the predecessor, and waits for the recovery's lock on its credit.
      billing = (async () => await fixture.api<{ state: string }[]>`select state from schellingaf.bill_space_day(${pred.id}::uuid, '2026-09-09')`)();
      for (let i = 0; ; i++) {
        const [w] = await fixture.owner<{ n: number }[]>`
          select count(*)::int as n from pg_locks l
           where not l.granted and l.pid in (select a.pid from pg_stat_activity a where a.datname = current_database())`;
        if (w!.n > 0) break;
        assert.ok(i < 200, "the bill never waited for the recovery");
        await new Promise((done) => setTimeout(done, 10));
      }
      await r`commit`;
      const [out] = await billing;
      assert.equal(out!.state, "billed");
    } finally {
      // After a commit this rolls back nothing; after a failure it lets the bill go.
      await r`rollback`;
      r.release();
      await billing?.catch(() => undefined);
      await restore();
    }
    const succ = { name: next, id: await idOf(next) };
    made.push(succ);
    assert.deepEqual((await rows(pred.id)).map((x) => ({ taken: x.taken, payer: x.payer })), [{ taken: DAY, payer: succ.id }]);
    assert.equal((await credit(succ.id)).balance, 50_000 - DAY);
    const before = await credit(pred.id);
    assert.deepEqual({ balance: before.balance, frozen: before.frozen, notice: before.notice }, { balance: 0, frozen: false, notice: "none" });
    assert.deepEqual(await notices(pred.id), []);
  });

  test("a balance that pays a day moves and leaves the successor open", async () => {
    const pred = await space();
    await deposit(pred.id, 50_000);
    const next = newName();
    await recover(pred.name, next);
    const succ = await idOf(next);
    made.push({ name: next, id: succ });
    assert.equal((await credit(pred.id)).balance, 0);
    assert.deepEqual({ ...(await credit(succ)), since: null }, { balance: 50_000, frozen: false, since: null, free_until: null, notice: "none" });
    const [refusal] = await fixture.api<{ r: string | null }[]>`select schellingaf.credit_refusal(${succ}::uuid, 0) as r`;
    assert.equal(refusal!.r, null);
  });

  test("the migration moves the balances of SPACES replaced before it, along the chain to the payer, once", async () => {
    // Replaced before 0159: no trigger moved anything.
    const a = await space();
    await deposit(a.id, 700);
    await fixture.owner`update schellingaf.space_credit set frozen = true, frozen_since = '2026-09-03T00:00:00Z', notice = 'read_only' where space_id = ${a.id}::uuid`;
    const b = newName();
    const c = newName();
    await fixture.owner`alter table schellingaf.spaces disable trigger spaces_replaced_credit`;
    let bId: string, cId: string;
    try {
      await recover(a.name, b);
      bId = await idOf(b);
      await deposit(bId, 200);
      await recover(b, c);
      cId = await idOf(c);
    } finally {
      await fixture.owner`alter table schellingaf.spaces enable trigger spaces_replaced_credit`;
    }
    made.push({ name: b, id: bId }, { name: c, id: cId });
    assert.equal((await credit(a.id)).balance, 700, "the scene: the balance stayed behind");
    const file = readFileSync(new URL("../migrations/0159_billing_fixes.sql", import.meta.url), "utf8");
    const statement = file.slice(file.indexOf("SELECT schellingaf.move_replaced_credit("));
    for (let i = 0; i < 2; i++) await fixture.owner.unsafe(statement);
    assert.equal((await credit(a.id)).balance, 0);
    assert.equal((await credit(a.id)).frozen, false);
    assert.equal((await credit(bId)).balance, 0);
    const payer = await credit(cId);
    assert.deepEqual({ balance: payer.balance, frozen: payer.frozen, notice: payer.notice }, { balance: 900, frozen: true, notice: "read_only" });
    assert.deepEqual((await ledger(cId)).map((e) => e.key).sort(),
      [`adjustment:recovery:${a.id}:in`, `adjustment:recovery:${bId}:in`].sort());
  });

  test("a replaced SPACE owes nothing a day itself: the sweep unfreezes its old row, and it is not read-only", async () => {
    const pred = await space();
    const next = newName();
    await recover(pred.name, next);
    made.push({ name: next, id: await idOf(next) });
    // A row frozen before the recovery moved anything: as 0155 left a replaced payer's.
    await fixture.owner`
      insert into schellingaf.space_credit as c (space_id, frozen, frozen_since, notice) values (${pred.id}::uuid, true, now(), 'read_only')
      on conflict (space_id) do update set frozen = true, frozen_since = now(), notice = 'read_only'`;
    const [due] = await fixture.owner<{ d: string }[]>`select schellingaf.space_daily_due(${pred.id}::uuid, 0, current_date)::text as d`;
    assert.equal(Number(due!.d), 0);
    await fixture.owner`select schellingaf.credit_sweep()`;
    const after = await credit(pred.id);
    assert.deepEqual({ frozen: after.frozen, notice: after.notice }, { frozen: false, notice: "none" });
    const [refusal] = await fixture.api<{ r: string | null }[]>`select schellingaf.credit_refusal(${pred.id}::uuid, 0) as r`;
    assert.equal(refusal!.r, null);
  });
});

describe("frozen, and how it clears", () => {
  test("a deposit below a day leaves it frozen; one covering a day clears it in the deposit's own transaction", async () => {
    const s = await space();
    assert.equal((await bill(s.id, "2026-09-02")).state, "short");
    await deposit(s.id, DAY - 1);
    assert.deepEqual({ frozen: (await credit(s.id)).frozen, notice: (await credit(s.id)).notice }, { frozen: true, notice: "read_only" });
    await fixture.owner.begin(async (tx) => {
      await tx`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', 1, ${`deposit:${randomUUID()}`}, 'a test')`;
      const [c] = await tx<{ frozen: boolean; since: Date | null; notice: string }[]>`
        select frozen, frozen_since as since, notice from schellingaf.space_credit where space_id = ${s.id}::uuid`;
      assert.deepEqual({ ...c! }, { frozen: false, since: null, notice: "low" }, "a day paid, 7 or fewer: low, without a delivery");
    });
    // More than 7 days paid: the notice is reset.
    await deposit(s.id, 10 * DAY);
    assert.equal((await credit(s.id)).notice, "none");
    assert.equal((await notices(s.id)).length, 1, "only the read-only notice was delivered");
  });

  test("the sweep clears a SPACE whose posts were hidden below its allowance, and the tick logs it", async () => {
    const swept = async () => {
      const s = await space(null);
      // A writer's post, which the owner may hide.
      const w = await agent();
      await grant(s.name, w, "writer");
      const p = await call("POST", `/v1/spaces/${s.name}/posts`, w.token, { kind: "obs", body: `${"x".repeat(8000)} ${randomUUID()}` });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      const [b] = await fixture.owner<{ b: string }[]>`select post_bytes::text as b from schellingaf.space_storage where space_id = ${s.id}::uuid`;
      // Just over the allowance by this one post's bytes, less one.
      await setBytes(s.id, PUB - 1 + Number(b!.b));
      assert.equal((await bill(s.id, "2026-09-02")).state, "short");
      assert.equal((await credit(s.id)).frozen, true);
      await refill(owner);
      const hidden = await call("PUT", `/v1/posts/${p.body.post_id}/hidden`, owner.token);
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
      return s;
    };
    const one = await swept();
    const [first] = await fixture.api<{ s: { unfrozen: number; notices_reset: number } }[]>`select schellingaf.credit_sweep() as s`;
    assert.ok(first!.s.unfrozen >= 1 && first!.s.notices_reset >= 1, JSON.stringify(first!.s));
    const c = await credit(one.id);
    assert.deepEqual({ frozen: c.frozen, since: c.since, notice: c.notice }, { frozen: false, since: null, notice: "none" });
    const [again] = await fixture.api<{ s: { unfrozen: number; notices_reset: number } }[]>`select schellingaf.credit_sweep() as s`;
    assert.equal(again!.s.unfrozen, 0, "a second sweep finds nothing of these");

    const two = await swept();
    const lines: string[] = [];
    await billOnce(db, { now: new Date("2026-09-02T00:30:00Z"), log: (line) => lines.push(line) });
    const sweep = lines.map((l) => JSON.parse(l)).find((l) => l.event === "billing.sweep");
    assert.ok(sweep && sweep.unfrozen >= 1, lines.join("\n"));
    assert.deepEqual(Object.keys(sweep), ["event", "unfrozen", "notices_reset"]);
    assert.equal((await credit(two.id)).frozen, false);
  });
});

describe("notices", () => {
  test("a short bill tells the owner and each admin once, never a writer; a bill leaving 7 days or fewer tells once, and again after a deposit and a later crossing", async () => {
    const a1 = await agent();
    const a2 = await agent();
    const w = await agent();
    const s = await space();
    await grant(s.name, a1, "admin");
    await grant(s.name, a2, "admin");
    await grant(s.name, w, "writer");
    const out = await bill(s.id, "2026-09-02");
    assert.equal(out.state, "short");
    const everyone = [owner.peerId, a1.peerId, a2.peerId].sort();
    assert.deepEqual(out.delivered.map((d) => d.recipient), everyone, "ascending peer id");
    const read = await notices(s.id);
    assert.deepEqual(read.map((d) => d.recipient).sort(), everyone);
    assert.ok(read.every((d) => d.notice === "read_only" && d.day === "2026-09-02"));
    assert.deepEqual((await bill(s.id, "2026-09-03")).delivered, [], "frozen already: nothing more");
    assert.equal((await notices(s.id)).length, 3);
    // The mailbox reason is listed, so a reader may ask for it.
    const mine = await call("GET", "/v1/mailbox?reason=funding", a1.token);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.items.map((i: any) => i.reason), ["funding"]);

    const t = await space();
    await deposit(t.id, 5 * DAY);
    const low = await bill(t.id, "2026-09-02");
    assert.deepEqual({ state: low.state, to: low.delivered.map((d) => d.recipient) }, { state: "billed", to: [owner.peerId] });
    assert.deepEqual(await notices(t.id), [{ recipient: owner.peerId, notice: "low", day: "2026-09-02" }]);
    assert.deepEqual((await bill(t.id, "2026-09-03")).delivered, []);
    await deposit(t.id, 10 * DAY);
    assert.equal((await credit(t.id)).notice, "none", "more than 7 days: reset");
    // 13 days left; each day takes one, and the crossing to 7 tells again.
    const told: string[] = [];
    for (let d = 4; d <= 10; d++) {
      const day = `2026-09-${String(d).padStart(2, "0")}`;
      if ((await bill(t.id, day)).delivered.length > 0) told.push(day);
    }
    assert.deepEqual(told, ["2026-09-09"]);
    assert.deepEqual((await notices(t.id)).map((d) => d.notice), ["low", "low"]);
  });

  test("the admins past request_notices get no notice", async () => {
    const [cap] = await fixture.owner<{ n: number }[]>`select schellingaf.cap('request_notices')::int as n`;
    const s = await space();
    const admins: Agent[] = [];
    for (let i = 0; i <= cap!.n; i++) {
      const a = await agent();
      await grant(s.name, a, "admin");
      admins.push(a);
    }
    const out = await bill(s.id, "2026-09-02");
    assert.equal(out.delivered.length, cap!.n + 1, "the owner and the first admins");
    const last = admins[admins.length - 1]!;
    assert.ok(!out.delivered.some((d) => d.recipient === last.peerId), "the last admin granted");
    assert.ok(out.delivered.some((d) => d.recipient === owner.peerId));
  });

  test("a waiting mailbox read wakes when the job delivers", async () => {
    const reader = await agent();
    const s = await space(OVER, reader);
    const [head] = await fixture.owner<{ seq: string }[]>`
      select last_seq::text as seq from schellingaf.mailboxes where peer_id = ${Buffer.from(reader.peerId, "hex")}`;
    const began = Date.now();
    const waiting = call("GET", `/v1/mailbox?after=${head!.seq}&wait=20`, reader.token);
    for (let i = 0; i < 200 && waitingNow() < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(waitingNow() >= 1, "the read is waiting");
    await fresh();
    await tick(new Date("2026-09-12T01:00:00Z"));
    const out = await waiting;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.items.map((i: any) => i.reason), ["funding"]);
    assert.ok(Date.now() - began < 10_000, `woken after ${Date.now() - began} ms`);
    assert.equal((await rows(s.id))[0]!.day, "2026-09-11");
  });
});

describe("the switch", () => {
  test("billing_set_mode('shadow') makes the next day shadow; real again bills; anything else is refused; mode_at moves only on a change", async () => {
    const s = await space();
    await deposit(s.id, 50_000);
    const at = async () => (await fixture.owner<{ t: Date }[]>`select mode_at as t from schellingaf.billing_epoch`)[0]!.t;
    try {
      const [set] = await fixture.api<{ mode: string; real_from: string }[]>`select mode, real_from::text from schellingaf.billing_set_mode('shadow')`;
      assert.deepEqual({ ...set! }, { mode: "shadow", real_from: "2026-09-01" });
      const first = await at();
      await fixture.api`select * from schellingaf.billing_set_mode('shadow')`;
      assert.deepEqual(await at(), first, "no change, no new time");
      assert.equal((await bill(s.id, "2026-09-20")).state, "shadow");
      const [liveNow] = await fixture.api<{ l: boolean }[]>`select schellingaf.billing_live() as l`;
      assert.equal(liveNow!.l, false);
    } finally {
      await fixture.api`select * from schellingaf.billing_set_mode('real')`;
    }
    assert.equal((await bill(s.id, "2026-09-21")).state, "billed");
    assert.deepEqual((await rows(s.id)).map((r) => [r.day, r.shadow, r.taken]), [["2026-09-20", true, 0], ["2026-09-21", false, DAY]]);
    await assert.rejects(fixture.api`select * from schellingaf.billing_set_mode('off')`, (e: any) => e.message === "INVALID_REQUEST");
    const [liveAgain] = await fixture.api<{ l: boolean }[]>`select schellingaf.billing_live() as l`;
    assert.equal(liveAgain!.l, true);
  });
});

describe("the day's line", () => {
  test("mode real, what was taken, free and short days, notices and closed SPACES, and no SPACE's name or id", async () => {
    const paid = await space();
    await deposit(paid.id, 100 * DAY);
    const short = await space();
    const free = await space();
    await fixture.owner`insert into schellingaf.space_credit (space_id, free_until) values (${free.id}::uuid, '2026-10-01') on conflict (space_id) do update set free_until = excluded.free_until`;
    const closed = await space();
    await fixture.owner`update schellingaf.spaces set status = 'closed' where space_id = ${closed.id}::uuid`;
    await fresh();
    const lines: string[] = [];
    assert.deepEqual(await tick(new Date("2026-09-29T01:00:00Z"), lines), { state: "billed", days: ["2026-09-28"] });
    const [line] = lines.map((l) => JSON.parse(l) as DayLine).filter((l) => l.event === "billing.day");
    assert.ok(line);
    assert.equal(line.mode, "real");
    assert.ok(line.visibility.public.taken_micro_usd >= DAY, JSON.stringify(line.visibility.public));
    assert.ok(line.visibility.public.short >= 1 && line.visibility.public.free >= 1 && line.visibility.public.read_only >= 1);
    assert.ok(line.skipped.closed >= 1, JSON.stringify(line.skipped));
    assert.ok(line.notices.read_only >= 1, JSON.stringify(line.notices));
    assert.deepEqual(line.rate, { micro_usd_per_gb_month: 5_000_000, days_per_month: 30, bytes_per_gb: 1_000_000_000 });
    const text = lines.find((l) => l.includes('"billing.day"'))!;
    for (const s of made) {
      assert.ok(!text.includes(s.name) && !text.includes(s.id), `${s.name} is in the line`);
    }
    assert.equal((await rows(paid.id)).find((r) => r.day === "2026-09-28")!.taken, DAY);
    assert.equal((await rows(short.id)).find((r) => r.day === "2026-09-28")!.taken, 0);
    assert.equal((await rows(free.id)).find((r) => r.day === "2026-09-28")!.free, true);
  });
});

describe("free days at release", () => {
  test("the release statement gives real_from + 90 to sealed SPACES and those over their allowance, not one under it nor one made after", async () => {
    const enc = await agent({ encryptionKey: true });
    const sealedOne = await sealedSpace(enc);
    const over = await space();
    const under = await space(-1);
    const [epoch] = await fixture.owner<{ until: string }[]>`select (real_from + 90)::text as until from schellingaf.billing_epoch`;
    const migration = readFileSync(new URL("../migrations/0155_billing_real.sql", import.meta.url), "utf8").split("\n");
    const from = migration.indexOf("-- free days begin");
    const to = migration.indexOf("-- free days end");
    assert.ok(from >= 0 && to > from + 1, "the migration marks its statement");
    const statement = migration.slice(from + 1, to).join("\n");
    assert.ok(statement.startsWith("INSERT INTO schellingaf.space_credit"), statement);
    try {
      await fixture.owner.unsafe(statement);
      assert.equal((await credit(sealedOne)).free_until, epoch!.until);
      assert.equal((await credit(over.id)).free_until, epoch!.until);
      assert.equal((await credit(under.id)).free_until, null);
      const later = await space();
      assert.equal((await credit(later.id)).free_until, null);
    } finally {
      // Every other SPACE of this file had its free days set too: taken back.
      await fixture.owner`update schellingaf.space_credit set free_until = null`;
    }
  });
});

describe("privacy", () => {
  test("the api role runs only the job's functions: never credit_post(), the notice, the measures, nor a change to the rates or the epoch", async () => {
    await assert.rejects(
      fixture.api`select * from schellingaf.credit_post(${made[0]!.id}::uuid, 'deposit', 1, ${`deposit:${randomUUID()}`}, '')`,
      /permission denied/,
    );
    await assert.rejects(
      fixture.api.unsafe(`CREATE OR REPLACE FUNCTION schellingaf.billing_rates()
        RETURNS TABLE (micro_usd_per_gb_month bigint, days_per_month integer, bytes_per_gb bigint,
                       public_bytes bigint, private_bytes bigint, sealed_bytes bigint)
        LANGUAGE sql IMMUTABLE AS $$ SELECT 1::bigint, 1, 1::bigint, 0::bigint, 0::bigint, 0::bigint $$`),
      /must be owner|permission denied/,
    );
    await assert.rejects(fixture.api`update schellingaf.billing_epoch set real_from = '2030-01-01'`, /permission denied/);
    await assert.rejects(fixture.api`select real_from from schellingaf.billing_epoch`, /permission denied/);
    const fns = await fixture.owner<{ name: string; api: boolean; public: boolean }[]>`
      select p.oid::regprocedure::text as name, has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
             has_function_privilege('public', p.oid, 'execute') as public
        from pg_proc p
       where p.pronamespace = 'schellingaf'::regnamespace
         and p.proname in ('billing_first_day', 'billing_rates', 'space_allowance', 'day_due_micro', 'space_billable_bytes',
                           'billing_today', 'billing_day_mode', 'billing_live', 'space_billed', 'space_day_due', 'space_daily_due',
                           'billing_set_mode', 'deliver_funding_notice', 'bill_candidates', 'bill_space_day', 'billing_summary',
                           'credit_sweep', 'credit_post')
       order by 1`;
    assert.equal(fns.length, 18, fns.map((f) => f.name).join(", "));
    assert.deepEqual(fns.filter((f) => f.public).map((f) => f.name), []);
    assert.deepEqual(fns.filter((f) => f.api).map((f) => f.name), [
      "bill_candidates(date,uuid,integer)",
      "bill_space_day(uuid,date)",
      "billing_day_mode(date)",
      "billing_live()",
      "billing_rates()",
      "billing_set_mode(text)",
      "billing_summary(date,bigint[])",
      "billing_today()",
      "credit_sweep()",
    ]);
  });
});

describe("the dry run (scripts/billing-dry-run.ts)", () => {
  test("bills from two days ago on this copy, twice, writing nothing the second time, and prints counts only", async () => {
    // The fault row an earlier test set by hand would fail the check; the dry run is of a copy without one.
    await fixture.owner`delete from schellingaf.credit_faults`;
    const pool = postgres({
      host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_migrate",
      password: "test_migrate_password_not_a_secret", max: 4, onnotice: () => {},
      connection: { role: "schellingaf_owner" } as unknown as Record<string, string>,
    });
    try {
      // Unmarked, it bills nothing.
      const [before] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.billing_runs`;
      const unmarked = await dryRun(pool);
      assert.equal(unmarked.ok, false);
      assert.match(unmarked.failures.join(" "), /no restore drill mark/);
      const [still] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.billing_runs`;
      assert.equal(still!.n, before!.n, "an unmarked database was billed");
      // Marked as the drill marks the copy it restored.
      await fixture.owner.unsafe(`comment on database "${fixture.name}" is '${DRILL_MARK}'`);
      const out = await dryRun(pool);
      assert.deepEqual(out.failures, []);
      assert.equal(out.ok, true);
      const ticks = out.report.ticks as { state: string }[];
      assert.deepEqual(ticks.map((t) => t.state), ["billed", "idle"]);
      const [epoch] = await fixture.owner<{ from: string; today: string }[]>`
        select real_from::text as from, (schellingaf.billing_today() - 2)::text as today from schellingaf.billing_epoch`;
      assert.equal(epoch!.from, epoch!.today, "real_from is two days before the database's today");
      const lines = out.report.lines as DayLine[];
      assert.equal(lines.at(-1)!.mode, "real", "yesterday is after real_from");
      const text = JSON.stringify(out.report);
      for (const s of made) assert.ok(!text.includes(s.name) && !text.includes(s.id), `${s.name} is in the report`);
    } finally {
      await fixture.owner.unsafe(`comment on database "${fixture.name}" is null`);
      await pool.end({ timeout: 5 });
      await live();
    }
  });

  test("refuses DB_PORT or DB_NAME not given and the service's port 5439; the drill writes the mark it asks for", async () => {
    assert.match(refusal({ DB_HOST: "127.0.0.1", DB_NAME: "copy" }) ?? "", /no default/);
    assert.match(refusal({ DB_HOST: "127.0.0.1", DB_PORT: "5500" }) ?? "", /no default/);
    assert.match(refusal({ DB_PORT: "5439", DB_NAME: "copy" }) ?? "", /5439, the service's own/);
    assert.equal(refusal({ DB_PORT: "5500", DB_NAME: "copy" }), null);
    const child = spawn(process.execPath, ["scripts/billing-dry-run.ts"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH ?? "", DB_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 1);
    assert.match(stderr, /no default/);
    const drill = readFileSync(new URL("../scripts/restore-drill.sh", import.meta.url), "utf8");
    assert.ok(drill.includes(`COMMENT ON DATABASE schellingaf IS '${DRILL_MARK}'`), "the drill does not write the mark");
  });

  test("refuses a database host that is not this machine", async () => {
    assert.equal(loopback("127.0.0.1"), true);
    assert.equal(loopback("localhost"), true);
    assert.equal(loopback("db.internal"), false);
    const child = spawn(process.execPath, ["scripts/billing-dry-run.ts"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH ?? "", DB_HOST: "10.0.0.1", DB_PORT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 1);
    assert.match(stderr, /this machine only/);
  });
});

// ── A sealed SPACE as the owner's software makes one (test/sealed-spaces.test.ts) ──

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function sealedSpace(maker: Agent): Promise<string> {
  const name = newName();
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: new Uint8Array(Buffer.from(maker.peerId, "hex")), sender: new Uint8Array(Buffer.from(maker.peerId, "hex")),
    commitment: g1.commitment, secret: g1.secret, pkR: maker.enc!.pk, skS: maker.enc!.sk,
  });
  const out = await call("POST", "/v1/spaces", maker.token, {
    name, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.push({ name, id: spaceId });
  return spaceId;
}
