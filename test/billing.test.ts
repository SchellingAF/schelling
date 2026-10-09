// The billing job (migrations/0150_billing.sql, 0155_billing_real.sql, src/db/billing.ts):
// once a UTC day, every SPACE over the free allowance of its visibility gets one bill row,
// and the day logs one line with no SPACE's name or id in it. Every day billed here is
// before billing_epoch.real_from, so each row is shadow and takes nothing; the real bill is
// test/billing-real.test.ts. The allowances are SQL's, so a SPACE is put over one by
// setting its counter as the owner, on a day whose recount is recorded so the counter
// stands; the database is touched as the owner to set other scenes too (a SPACE's age, a
// day already finished, a balance tampered with) and to read what was written.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { useService, fixture, db, config, call, agent, type Agent } from "./lib/service.ts";
import { API_PASSWORD } from "./bootstrap.ts";
import { addDays, billOnce, utcDate, type DayLine } from "../src/db/billing.ts";
import { FUNDING } from "../src/surface/vocabulary.ts";

useService("billing");

let n = 0;
/** Every SPACE this file makes, by name and id: none may reach a day's line. */
const made: { name: string; id: string }[] = [];
let owner: Agent;

/**
 * A SPACE with one post of about 8,000 bytes, made long before the days billed here, and
 * its counter set `over` bytes above its allowance; null leaves it as the post made it.
 */
async function space(visibility: "public" | "private" = "public", createdAt = "2026-01-01T00:00:00Z", over: number | null = 10_000): Promise<{ name: string; id: string }> {
  owner ??= await agent();
  const name = `billing-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Billing", visibility });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const posted = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: `${"x".repeat(8000)} ${randomUUID()}` });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const [row] = await fixture.owner<{ id: string }[]>`
    update schellingaf.spaces set created_at = ${createdAt}::timestamptz where name = ${name} returning space_id::text as id`;
  const s = { name, id: row!.id };
  made.push(s);
  if (over !== null) await setBytes(s.id, FUNDING.allowanceBytes[visibility] + over);
  return s;
}

/** Sets a SPACE's post counter, as the owner: what the day measures, when its recount is recorded. */
async function setBytes(id: string, bytes: number) {
  await fixture.owner`update schellingaf.space_storage set post_bytes = ${bytes} where space_id = ${id}::uuid`;
}

/** Every counter back to its true value, so no SPACE is over. */
async function trueAll() {
  await fixture.owner`update schellingaf.space_storage set post_bytes = schellingaf.space_post_bytes_true(space_id)`;
}

/** What the counters hold for a SPACE. */
async function bytesOf(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`
    select (coalesce((select post_bytes from schellingaf.space_storage where space_id = ${id}::uuid), 0)
          + coalesce((select attached_bytes from schellingaf.space_file_totals where space_id = ${id}::uuid), 0))::text as b`;
  return Number(row!.b);
}

/** No day begun: the next run bills yesterday alone. */
async function fresh() {
  await fixture.owner`delete from schellingaf.billing_runs`;
}

/**
 * One tick at `now`. Unless `recount` is asked for, the tick's first open day is begun with
 * its recount recorded, so the counters set here stand.
 */
async function run(now: Date, lines: string[] = [], options: { recount?: boolean } = {}) {
  if (options.recount !== true) await noRecount(now);
  return billOnce(db, { now, log: (line) => lines.push(line) });
}

/** The first day a tick at `now` would bill, if any, begun with its recount recorded. */
async function noRecount(now: Date) {
  const yesterday = addDays(utcDate(now), -1);
  const [next] = await fixture.owner<{ day: string | null }[]>`select schellingaf.billing_next_day()::text as day`;
  const first = next?.day ?? yesterday;
  if (first > yesterday) return;
  await fixture.owner`
    insert into schellingaf.billing_runs as r (day, recounted_at) values (${first}::date, now())
    on conflict (day) do update set recounted_at = coalesce(r.recounted_at, now())`;
}

const dayLines = (lines: string[]): DayLine[] => lines.map((l) => JSON.parse(l)).filter((l) => l.event === "billing.day");

type Bill = { day: string; post_bytes: string; file_bytes: string; allowance_bytes: string; micro_usd_per_gb_month: string;
              days_per_month: number; bytes_per_gb: string; due_micro: string; taken_micro: string; shadow: boolean };

async function bills(id: string): Promise<Bill[]> {
  return [...await fixture.owner<Bill[]>`
    select day::text, post_bytes::text, file_bytes::text, allowance_bytes::text, micro_usd_per_gb_month::text,
           days_per_month, bytes_per_gb::text, due_micro::text, taken_micro::text, shadow
      from schellingaf.space_bills where space_id = ${id}::uuid order by day`];
}

describe("the days", () => {
  test("the first run bills yesterday alone, though the SPACES are older", async () => {
    await fresh();
    const s = await space();
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-10T12:00:00Z"), lines), { state: "billed", days: ["2026-09-09"] });
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-09"]);
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-09"]);
  });

  test("a day is the UTC date, whatever the process's time zone", async () => {
    const now = new Date("2026-10-09T00:30:00+02:00");
    assert.equal(utcDate(now), "2026-10-08");
    assert.equal(addDays("2026-10-08", -1), "2026-10-07");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    await fresh();
    assert.deepEqual(await run(now), { state: "billed", days: ["2026-10-07"] });
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      // Fourteen hours ahead, the same instant is already the 9th where the process is.
      assert.equal(now.getDate(), 9, "the time zone took effect");
      await fresh();
      assert.deepEqual(await run(now), { state: "billed", days: ["2026-10-07"] });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test("a second run the same day bills and logs nothing; a day set back is begun again and no bill doubles", async () => {
    await fresh();
    const s = await space();
    const now = new Date("2026-09-11T08:00:00Z");
    const first: string[] = [];
    assert.deepEqual(await run(now, first), { state: "billed", days: ["2026-09-10"] });
    assert.equal(dayLines(first).length, 1);
    const again: string[] = [];
    assert.deepEqual(await run(now, again), { state: "idle" });
    assert.deepEqual(dayLines(again), []);
    // The operator sets the day back: it is done again, and the bill stays one row.
    await fixture.owner`delete from schellingaf.billing_runs where day = '2026-09-10'`;
    const redo: string[] = [];
    assert.deepEqual(await run(now, redo), { state: "billed", days: ["2026-09-10"] });
    assert.equal(dayLines(redo).length, 1);
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-09-10").length, 1);
    // The api role bills only a day the job has begun and not finished: this one is finished.
    await assert.rejects(
      fixture.api`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-09-10')`,
      (e: any) => e.message === "INVALID_REQUEST" && e.detail === "the day is not being billed",
    );
    // Nor a day never begun.
    await assert.rejects(
      fixture.api`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-08-10')`,
      (e: any) => e.message === "INVALID_REQUEST" && e.detail === "the day is not being billed",
    );
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-08-10").length, 0);
    // Begun and open, it is billed once and answers already after.
    await fixture.api`select * from schellingaf.billing_day_begin('2026-08-10')`;
    const [begun] = await fixture.api<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-08-10')`;
    assert.equal(begun!.state, "shadow");
    const [answer] = await fixture.api<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-08-10')`;
    assert.equal(answer!.state, "already");
    await fixture.owner`delete from schellingaf.billing_runs where day = '2026-08-10'`;
  });

  test("a day with a failed bill stays open, logs no line, and the next tick bills the rest and finishes it", async () => {
    await fresh();
    const s = await space();
    const t = await space();
    // One SPACE's bill fails: its row cannot be written.
    await fixture.owner`
      create function schellingaf.test_fail_bill() returns trigger language plpgsql as $$
      begin raise exception 'a test fails this bill'; end $$`;
    await fixture.owner.unsafe(`create trigger test_fail_bill before insert on schellingaf.space_bills
      for each row when (new.space_id = '${s.id}'::uuid) execute function schellingaf.test_fail_bill()`);
    const now = new Date("2026-09-11T02:00:00Z");
    const lines: string[] = [];
    try {
      assert.deepEqual(await run(now, lines), { state: "billed", days: ["2026-09-10"], open: ["2026-09-10"] });
      assert.deepEqual(dayLines(lines), [], "a day with a failed bill logged its line");
      const [open] = await fixture.owner<{ finished: boolean }[]>`
        select finished_at is not null as finished from schellingaf.billing_runs where day = '2026-09-10'`;
      assert.equal(open!.finished, false);
      assert.equal((await bills(t.id)).filter((b) => b.day === "2026-09-10").length, 1, "the other SPACE was billed");
    } finally {
      await fixture.owner`drop trigger if exists test_fail_bill on schellingaf.space_bills`;
      await fixture.owner`drop function if exists schellingaf.test_fail_bill()`;
    }
    const later: string[] = [];
    assert.deepEqual(await billOnce(db, { now, log: (line) => later.push(line) }), { state: "billed", days: ["2026-09-10"] });
    const [line] = dayLines(later);
    assert.equal(line!.day, "2026-09-10");
    assert.equal(line!.skipped.failed, 0);
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-09-10").length, 1);
  });

  test("without a now, yesterday is the database's: billing_today() less one", async () => {
    await fresh();
    await space();
    await fixture.owner`
      create or replace function schellingaf.billing_today() returns date
        language sql stable set search_path = pg_catalog, schellingaf, pg_temp
      as $$ select '2026-09-20'::date $$`;
    try {
      await noRecount(new Date("2026-09-20T05:00:00Z"));
      const lines: string[] = [];
      assert.deepEqual(await billOnce(db, { log: (line) => lines.push(line) }), { state: "billed", days: ["2026-09-19"] });
      assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-19"]);
    } finally {
      await fixture.owner`
        create or replace function schellingaf.billing_today() returns date
          language sql stable set search_path = pg_catalog, schellingaf, pg_temp
        as $$ select (now() at time zone 'UTC')::date $$`;
    }
  });

  test("days missed since the last finished one are billed in order, one line each", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`insert into schellingaf.billing_runs (day, finished_at, summary) values ('2026-09-12', now(), '{}')`;
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-15T01:00:00Z"), lines), { state: "billed", days: ["2026-09-13", "2026-09-14"] });
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-13", "2026-09-14"]);
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-13", "2026-09-14"]);
  });

  test("a day begun and not finished is the next run's first; a finished day after it is not billed again", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`insert into schellingaf.billing_runs (day, finished_at, summary) values ('2026-09-28', now(), '{}')`;
    await fixture.owner`insert into schellingaf.billing_runs (day) values ('2026-09-27')`;
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-29T01:00:00Z"), lines), { state: "billed", days: ["2026-09-27"] });
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-27"]);
    // The SPACE is over a small allowance: billed for the open day, and no row for the finished one.
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-27"]);
    const [rows] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_bills where day = '2026-09-28'`;
    assert.equal(rows!.n, 0, "the finished day gains no row");
  });

  test("a day's recount is recorded: a day begun without one gets it on the next tick, a day with one is not recounted again", async () => {
    await fresh();
    const s = await space("public", undefined, null);
    // A day a tick began and died in before its recount ran.
    await fixture.owner`insert into schellingaf.billing_runs (day) values ('2026-09-24')`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 111 where space_id = ${s.id}::uuid`;
    const wrong = await bytesOf(s.id);
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-25T03:00:00Z"), lines, { recount: true }), { state: "billed", days: ["2026-09-24"] });
    assert.equal(await bytesOf(s.id), wrong - 111, "recounted");
    const [line] = dayLines(lines);
    assert.ok(line!.recount !== null && line!.recount.corrected >= 1, JSON.stringify(line!.recount));
    assert.equal(typeof line!.faults_held, "number");
    const [recorded] = await fixture.owner<{ at: Date | null }[]>`select recounted_at as at from schellingaf.billing_runs where day = '2026-09-24'`;
    assert.ok(recorded!.at instanceof Date, "the recount is recorded");

    // A day whose recount is recorded and that was not finished, one that keeps failing.
    await fixture.owner`insert into schellingaf.billing_runs (day, recounted_at) values ('2026-09-25', now())`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 222 where space_id = ${s.id}::uuid`;
    const again = await bytesOf(s.id);
    const next: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-26T03:00:00Z"), next, { recount: true }), { state: "billed", days: ["2026-09-25"] });
    assert.equal(await bytesOf(s.id), again, "no recount");
    assert.deepEqual(next.filter((l) => JSON.parse(l).event === "storage.recount"), []);
    const [quiet] = dayLines(next);
    assert.deepEqual({ recount: quiet!.recount, faults_held: quiet!.faults_held }, { recount: null, faults_held: null });
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes - 222 where space_id = ${s.id}::uuid`;
  });

  test("the line counts the SPACES of each visibility over each size FUNDING names, and names none of them", async () => {
    await fresh();
    const big = await space("public");
    const mid = await space("private");
    // Set as the owner, on a day begun with its recount recorded, so the counters stand.
    await fixture.owner`insert into schellingaf.billing_runs (day, recounted_at) values ('2026-10-01', now())`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = 30000000 where space_id = ${big.id}::uuid`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = 7000000 where space_id = ${mid.id}::uuid`;
    const sized = await fixture.owner<{ visibility: string; b: string }[]>`
      select s.visibility, (coalesce(t.post_bytes, 0) + coalesce(f.attached_bytes, 0))::text as b
        from schellingaf.spaces s
        left join schellingaf.space_storage t on t.space_id = s.space_id
        left join schellingaf.space_file_totals f on f.space_id = s.space_id`;
    const expected = (v: string, sizes: readonly number[]) =>
      Object.fromEntries(sizes.map((z) => [String(z), sized.filter((r) => r.visibility === v && Number(r.b) > z).length]));
    try {
      const lines: string[] = [];
      await run(new Date("2026-10-02T03:00:00Z"), lines);
      const [line] = dayLines(lines);
      assert.deepEqual(Object.keys(line!.visibility.public.spaces_over), ["1000000", "5000000", "10000000", "25000000", "100000000"]);
      for (const v of ["public", "private", "sealed"] as const) {
        assert.deepEqual(line!.visibility[v].spaces_over, expected(v, FUNDING.spacesOverBytes), v);
      }
      assert.ok(line!.visibility.public.spaces_over["25000000"]! >= 1 && line!.visibility.private.spaces_over["5000000"]! >= 1);
      assert.equal(line!.visibility.private.spaces_over["10000000"], expected("private", [10_000_000])["10000000"]);
      for (const s of [big, mid]) assert.ok(!lines[lines.length - 1]!.includes(s.id) && !lines[lines.length - 1]!.includes(s.name));
    } finally {
      await fixture.owner`update schellingaf.space_storage set post_bytes = schellingaf.space_post_bytes_true(space_id) where space_id in (${big.id}::uuid, ${mid.id}::uuid)`;
    }
  });

  test("a day with no SPACE over is finished with one line of zeros, and the next tick does not redo it", async () => {
    await fresh();
    await trueAll();
    await space("public", undefined, null);
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-17T00:10:00Z"), lines, { recount: true }), { state: "billed", days: ["2026-09-16"] });
    const line: DayLine | undefined = dayLines(lines)[0];
    assert.ok(line);
    assert.deepEqual(Object.keys(line), ["event", "day", "mode", "measured_at", "rate", "visibility", "skipped", "notices", "faults_held", "recount"]);
    assert.deepEqual(line.skipped, { fault: 0, closed: 0, no_payer: 0, failed: 0 });
    assert.deepEqual(line.notices, { low: 0, read_only: 0 });
    assert.deepEqual({ event: line.event, mode: line.mode }, { event: "billing.day", mode: "shadow" });
    assert.deepEqual(line.rate, { micro_usd_per_gb_month: 5_000_000, days_per_month: 30, bytes_per_gb: 1_000_000_000 });
    assert.deepEqual(Object.keys(line.visibility), ["public", "private", "sealed"]);
    for (const v of ["public", "private", "sealed"] as const) {
      const f: DayLine["visibility"]["public"] = line.visibility[v];
      assert.deepEqual(Object.keys(f), [
        "allowance_bytes", "spaces", "over", "billable_bytes", "max_billable_bytes", "spaces_over", "over_bytes", "due_micro_usd",
        "taken_micro_usd", "free", "short", "read_only",
      ]);
      assert.deepEqual({ allowance: f.allowance_bytes, over: f.over, over_bytes: f.over_bytes, due: f.due_micro_usd, taken: f.taken_micro_usd },
        { allowance: FUNDING.allowanceBytes[v], over: 0, over_bytes: 0, due: 0, taken: 0 }, v);
    }
    assert.ok(line.visibility.public.spaces >= 1 && line.visibility.public.billable_bytes > 8000);
    assert.deepEqual(Object.keys(line.recount ?? {}), ["spaces", "corrected", "failed", "post_bytes_delta", "file_bytes_delta", "task_bytes_delta"]);
    const [kept] = await fixture.owner<{ summary: DayLine }[]>`select summary from schellingaf.billing_runs where day = '2026-09-16'`;
    assert.deepEqual(kept!.summary, line, "the day keeps its line");
    const next: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-17T05:00:00Z"), next, { recount: true }), { state: "idle" });
    assert.deepEqual(next, []);
  });

  test("two runs at once: one is busy, one line, one bill a SPACE", async () => {
    await fresh();
    const s = await space();
    const lines: string[] = [];
    const now = new Date("2026-09-19T00:30:00Z");
    await noRecount(now);
    const results = await Promise.all([run(now, lines, { recount: true }), run(now, lines, { recount: true })]);
    assert.deepEqual(results.map((r) => r.state).sort(), ["billed", "busy"]);
    assert.equal(dayLines(lines).length, 1);
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-09-18").length, 1);
  });
});

describe("the bills", () => {
  test("a day's bill rounds down: 6,000 bytes over is 1 micro-dollar, 5,999 a row of 0, none over no row; each visibility its own allowance", async () => {
    const pub = FUNDING.allowanceBytes.public;
    const priv = FUNDING.allowanceBytes.private;
    const s = await space("public", undefined, 6000);
    const p = await space("private", undefined, null);
    const day = async (d: string, publicBytes: number, privateBytes: number) => {
      await fresh();
      await setBytes(s.id, publicBytes);
      await setBytes(p.id, privateBytes);
      await run(new Date(`${addDays(d, 1)}T12:00:00Z`));
    };
    await day("2026-09-01", pub + 6000, priv);
    await day("2026-09-02", pub + 5999, priv);
    await day("2026-09-03", pub, priv);
    const rows = await bills(s.id);
    assert.deepEqual(rows.map((b) => ({ day: b.day, due: b.due_micro, allowance: b.allowance_bytes })), [
      { day: "2026-09-01", due: "1", allowance: String(pub) },
      { day: "2026-09-02", due: "0", allowance: String(pub) },
    ]);
    assert.deepEqual({ ...rows[0]! }, {
      day: "2026-09-01", post_bytes: String(pub + 6000), file_bytes: "0", allowance_bytes: String(pub), micro_usd_per_gb_month: "5000000",
      days_per_month: 30, bytes_per_gb: "1000000000", due_micro: "1", taken_micro: "0", shadow: true,
    });
    assert.deepEqual(await bills(p.id), [], "a private SPACE at its allowance has no row");
    // A private SPACE under the public allowance is still held to the private one.
    await day("2026-09-04", pub, priv + 6000);
    assert.deepEqual((await bills(p.id)).map((b) => ({ day: b.day, due: b.due_micro, allowance: b.allowance_bytes })), [
      { day: "2026-09-04", due: "1", allowance: String(priv) },
    ]);
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-01", "2026-09-02"]);
    await setBytes(p.id, priv - 1);
  });

  test("a shadow bill takes nothing: the balance stays, no bill is in the ledger, and a day not ended is refused", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', 1000000, ${`deposit:${randomUUID()}`}, 'a test')`;
    await run(new Date("2026-09-21T03:00:00Z"));
    const [row] = await bills(s.id);
    assert.deepEqual({ day: row!.day, shadow: row!.shadow, taken: row!.taken_micro }, { day: "2026-09-20", shadow: true, taken: "0" });
    const [credit] = await fixture.owner<{ balance: string; bills: number }[]>`
      select (select balance_micro::text from schellingaf.space_credit where space_id = ${s.id}::uuid) as balance,
             (select count(*)::int from schellingaf.credit_ledger where space_id = ${s.id}::uuid and kind = 'bill') as bills`;
    assert.deepEqual({ ...credit! }, { balance: "1000000", bills: 0 });
    await assert.rejects(
      fixture.api`select state from schellingaf.bill_space_day(${s.id}::uuid, (now() at time zone 'UTC')::date)`,
      (e: any) => e.message === "INVALID_REQUEST" && e.detail === "the day has not ended",
    );
    assert.equal((await bills(s.id)).length, 1);
  });

  test("a SPACE whose balance disagrees with its ledger gets no bill and is counted skipped; the others are billed", async () => {
    await fresh();
    const s = await space();
    const t = await space();
    await fixture.owner`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', 10, ${`deposit:${randomUUID()}`})`;
    await fixture.owner`update schellingaf.space_credit set balance_micro = balance_micro + 1 where space_id = ${s.id}::uuid`;
    // The reconciliation a tick runs with its recount, run here so the counters set stand.
    const [held] = await fixture.owner<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
    assert.ok(held!.n >= 1);
    const lines: string[] = [];
    await run(new Date("2026-09-23T03:00:00Z"), lines);
    assert.deepEqual(await bills(s.id), []);
    assert.deepEqual((await bills(t.id)).map((b) => b.day), ["2026-09-22"]);
    const [line] = dayLines(lines);
    assert.deepEqual(line!.skipped, { fault: 1, closed: 0, no_payer: 0, failed: 0 });
  });

  test("a SPACE made after the day ended is not billed for it", async () => {
    await fresh();
    const before = await space("public", "2026-09-24T23:59:59Z");
    const after = await space("public", "2026-09-25T00:00:00Z");
    await run(new Date("2026-09-25T12:00:00Z"));
    assert.deepEqual((await bills(before.id)).map((b) => b.day), ["2026-09-24"]);
    assert.deepEqual(await bills(after.id), []);
  });

  test("a day's line names no SPACE: none of this file's names or ids is in it", async () => {
    await fresh();
    await space();
    const lines: string[] = [];
    await run(new Date("2026-09-30T03:00:00Z"), lines);
    const [line] = lines.filter((l) => JSON.parse(l).event === "billing.day");
    assert.ok(line);
    assert.ok(JSON.parse(line).visibility.public.over >= 1, line);
    for (const s of made) {
      assert.ok(!line.includes(s.name), `${s.name} is in the line`);
      assert.ok(!line.includes(s.id), `${s.id} is in the line`);
    }
    // The recount's own line names the SPACE it corrected, by id, for the operator.
    await fresh();
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 5 where space_id = ${made[0]!.id}::uuid`;
    const recounted: string[] = [];
    await run(new Date("2026-09-30T03:00:00Z"), recounted, { recount: true });
    assert.ok(recounted.some((l) => JSON.parse(l).event === "storage.recount" && JSON.parse(l).space_id === made[0]!.id));
  });
});

describe("the migrations", () => {
  test("0149, 0150 and 0155 wait 1.5 s at most for a lock, set right after the search path", () => {
    for (const file of ["0149_space_credit.sql", "0150_billing.sql", "0155_billing_real.sql"]) {
      const lines = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8").split("\n").filter((l) => !l.startsWith("--"));
      const at = lines.indexOf("SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;");
      assert.ok(at >= 0, file);
      assert.equal(lines[at + 1], "SET LOCAL lock_timeout = '1500ms';", file);
    }
  });
});

describe("the service starts the job", () => {
  test("at boot, after writing a set BILLING to the database; unset leaves its mode; never under READ_ONLY=1; and BILLING other than real or shadow refuses the start", async () => {
    await fresh();
    const mode = async () => (await fixture.owner<{ m: string }[]>`select mode as m from schellingaf.billing_epoch`)[0]!.m;
    const [epoch] = await fixture.owner<{ real_from: string }[]>`select real_from::text from schellingaf.billing_epoch`;
    const logDir = mkdtempSync(path.join(tmpdir(), "billing-"));
    const start = async (extra: Record<string, string>, until: (stdout: string) => boolean, waitMs: number) => {
      const child = spawn(process.execPath, ["src/server.ts"], {
        cwd: path.join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PORT: "0",
          API_HOST: config.apiHost,
          PUBLIC_ORIGIN: config.publicOrigin,
          CHALLENGE_KEY: config.challengeKey.toString("utf8"),
          DB_HOST: config.db.host,
          DB_PORT: String(config.db.port),
          DB_NAME: config.db.database,
          DB_USER: config.db.username,
          DB_PASSWORD: API_PASSWORD,
          LOG_DIR: logDir,
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
      try {
        const began = Date.now();
        while (Date.now() - began < 20_000 && !/listening on \d+/.test(stdout)) await new Promise((r) => setTimeout(r, 50));
        assert.match(stdout, /listening on \d+/, `the service did not start: ${stderr}`);
        const listening = Date.now();
        while (Date.now() - listening < waitMs && !until(stdout)) await new Promise((r) => setTimeout(r, 50));
        return stdout;
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
    };
    const runs = async () => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.billing_runs`)[0]!.n;
    try {
      // Read-only: nothing is billed, though a day is due, and the mode is not written.
      await fixture.owner`update schellingaf.billing_epoch set mode = 'shadow'`;
      const readOnly = await start({ READ_ONLY: "1", BILLING: "real" }, () => false, 3000);
      assert.doesNotMatch(readOnly, /"event":"billing\.(day|config)"/);
      assert.equal(await runs(), 0, "a read-only service began a billing day");
      assert.equal(await mode(), "shadow", "a read-only service wrote the mode");
      // Otherwise BILLING, unset here, leaves the database's mode, shadow, and says it; the
      // first tick, at boot, bills yesterday and logs it.
      const unset = await start({}, (out) => out.includes('"event":"billing.day"'), 15_000);
      assert.match(unset, /"event":"billing\.day"/);
      assert.equal(await runs(), 1);
      assert.equal(await mode(), "shadow", "BILLING unset wrote the mode");
      const configLine = unset.split("\n").find((l) => l.includes('"event":"billing.config"'));
      assert.deepEqual(JSON.parse(configLine!), { event: "billing.config", mode: "shadow", real_from: epoch!.real_from });
      // BILLING=real is written at boot.
      const real = await start({ BILLING: "real" }, (out) => out.includes('"event":"billing.config"'), 15_000);
      assert.match(real, /"event":"billing\.config","mode":"real"/);
      assert.equal(await mode(), "real");
      // BILLING=shadow is written at boot.
      const shadow = await start({ BILLING: "shadow" }, (out) => out.includes('"event":"billing.config"'), 15_000);
      assert.match(shadow, /"event":"billing\.config","mode":"shadow"/);
      assert.equal(await mode(), "shadow");
      await fixture.owner`update schellingaf.billing_epoch set mode = 'real'`;
      // Anything else refuses to start, and writes nothing.
      const refused = spawn(process.execPath, ["src/server.ts"], {
        cwd: path.join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0", API_HOST: config.apiHost, PUBLIC_ORIGIN: config.publicOrigin,
          CHALLENGE_KEY: config.challengeKey.toString("utf8"), DB_HOST: config.db.host, DB_PORT: String(config.db.port),
          DB_NAME: config.db.database, DB_USER: config.db.username, DB_PASSWORD: API_PASSWORD, LOG_DIR: logDir, BILLING: "nonsense",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      refused.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const code = await new Promise<number | null>((resolve) => refused.on("exit", (c) => resolve(c)));
      assert.notEqual(code, 0);
      assert.match(stderr, /BILLING is "nonsense"/);
      assert.equal(await mode(), "real");
    } finally {
      await fixture.owner`update schellingaf.billing_epoch set mode = 'real'`;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a set BILLING that cannot be written stops the service with exit code 1, and a tick that cannot write it bills nothing", async () => {
    await fresh();
    await space();
    const mode = async () => (await fixture.owner<{ m: string }[]>`select mode as m from schellingaf.billing_epoch`)[0]!.m;
    const runs = async () => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.billing_runs`)[0]!.n;
    const logDir = mkdtempSync(path.join(tmpdir(), "billing-"));
    await fixture.owner`update schellingaf.billing_epoch set mode = 'real'`;
    await fixture.owner`revoke execute on function schellingaf.billing_set_mode(text) from schellingaf_api`;
    try {
      const child = spawn(process.execPath, ["src/server.ts"], {
        cwd: path.join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0", API_HOST: config.apiHost, PUBLIC_ORIGIN: config.publicOrigin,
          CHALLENGE_KEY: config.challengeKey.toString("utf8"), DB_HOST: config.db.host, DB_PORT: String(config.db.port),
          DB_NAME: config.db.database, DB_USER: config.db.username, DB_PASSWORD: API_PASSWORD, LOG_DIR: logDir, BILLING: "shadow",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.stdout.resume();
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
      clearTimeout(timer);
      assert.equal(code, 1, `the service kept running: ${stderr}`);
      assert.match(stderr, /BILLING=shadow could not be written to the database, so the service stops/);
      assert.equal(await mode(), "real");
      assert.equal(await runs(), 0, "a service that could not write the mode began a day");
      // A tick re-asserts a set mode first, and bills nothing when it cannot.
      await assert.rejects(billOnce(db, { now: new Date("2026-09-11T02:00:00Z"), mode: "shadow", log: () => {} }), /BILLING=shadow could not be written, so nothing was billed/);
      assert.equal(await runs(), 0, "a tick that could not write the mode began a day");
    } finally {
      await fixture.owner`grant execute on function schellingaf.billing_set_mode(text) to schellingaf_api`;
      rmSync(logDir, { recursive: true, force: true });
    }
    // Granted again, the tick writes the mode before it bills.
    await fixture.owner`update schellingaf.billing_epoch set mode = 'real'`;
    await noRecount(new Date("2026-09-11T02:00:00Z"));
    const ticked = await billOnce(db, { now: new Date("2026-09-11T02:00:00Z"), mode: "shadow", log: () => {} });
    assert.deepEqual(ticked, { state: "billed", days: ["2026-09-10"] });
    assert.equal(await mode(), "shadow");
    await fixture.owner`update schellingaf.billing_epoch set mode = 'real'`;
  });
});
