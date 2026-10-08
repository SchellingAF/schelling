// The shadow bill (migrations/0150_billing.sql, src/db/billing.ts): once a UTC day, every
// SPACE over the free allowance of its visibility gets one bill row that takes nothing,
// and the day logs one line with no SPACE's name or id in it. The allowances are passed
// small through funding; the database is touched as the owner to set a scene (a SPACE's
// age, a day already finished, a balance tampered with) and to read what was written.

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
import { FUNDING, type Funding } from "../src/surface/vocabulary.ts";

useService("billing");

const HUGE = 1_000_000_000_000;
let n = 0;
/** Every SPACE this file makes, by name and id: none may reach a day's line. */
const made: { name: string; id: string }[] = [];
let owner: Agent;

/** A SPACE with one post of about 8,000 bytes, made long before the days billed here. */
async function space(visibility: "public" | "private" = "public", createdAt = "2026-01-01T00:00:00Z"): Promise<{ name: string; id: string }> {
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
  return s;
}

/** What the counters hold for a SPACE. */
async function bytesOf(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`
    select (coalesce((select post_bytes from schellingaf.space_storage where space_id = ${id}::uuid), 0)
          + coalesce((select attached_bytes from schellingaf.space_file_totals where space_id = ${id}::uuid), 0))::text as b`;
  return Number(row!.b);
}

function funding(pub: number, priv = HUGE, sealed = HUGE): Funding {
  return { ...FUNDING, allowanceBytes: { public: pub, private: priv, sealed } };
}

/** No day begun: the next run bills yesterday alone. */
async function fresh() {
  await fixture.owner`delete from schellingaf.billing_runs`;
}

async function run(now: Date, f: Funding, lines: string[] = []) {
  return billOnce(db, { now, funding: f, log: (line) => lines.push(line) });
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
    assert.deepEqual(await run(new Date("2026-09-10T12:00:00Z"), funding(100), lines), { state: "billed", days: ["2026-09-09"] });
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-09"]);
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-09"]);
  });

  test("a day is the UTC date, whatever the process's time zone", async () => {
    const now = new Date("2026-10-09T00:30:00+02:00");
    assert.equal(utcDate(now), "2026-10-08");
    assert.equal(addDays("2026-10-08", -1), "2026-10-07");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    await fresh();
    assert.deepEqual(await run(now, funding(100)), { state: "billed", days: ["2026-10-07"] });
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      // Fourteen hours ahead, the same instant is already the 9th where the process is.
      assert.equal(now.getDate(), 9, "the time zone took effect");
      await fresh();
      assert.deepEqual(await run(now, funding(100)), { state: "billed", days: ["2026-10-07"] });
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
    assert.deepEqual(await run(now, funding(100), first), { state: "billed", days: ["2026-09-10"] });
    assert.equal(dayLines(first).length, 1);
    const again: string[] = [];
    assert.deepEqual(await run(now, funding(100), again), { state: "idle" });
    assert.deepEqual(dayLines(again), []);
    // The operator sets the day back: it is done again, and the bill stays one row.
    await fixture.owner`delete from schellingaf.billing_runs where day = '2026-09-10'`;
    const redo: string[] = [];
    assert.deepEqual(await run(now, funding(100), redo), { state: "billed", days: ["2026-09-10"] });
    assert.equal(dayLines(redo).length, 1);
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-09-10").length, 1);
    const [answer] = await fixture.api<{ state: string }[]>`
      select schellingaf.bill_space_day(${s.id}::uuid, '2026-09-10', 100, ${HUGE}, ${HUGE}, 5000000, 30, 1000000000, true) as state`;
    assert.equal(answer!.state, "already");
  });

  test("days missed since the last finished one are billed in order, one line each", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`insert into schellingaf.billing_runs (day, finished_at, summary) values ('2026-09-12', now(), '{}')`;
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-15T01:00:00Z"), funding(100), lines), { state: "billed", days: ["2026-09-13", "2026-09-14"] });
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-13", "2026-09-14"]);
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-13", "2026-09-14"]);
  });

  test("a day begun and not finished is the next run's first; a finished day after it is not billed again", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`insert into schellingaf.billing_runs (day, finished_at, summary) values ('2026-09-28', now(), '{}')`;
    await fixture.owner`insert into schellingaf.billing_runs (day) values ('2026-09-27')`;
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-29T01:00:00Z"), funding(100), lines), { state: "billed", days: ["2026-09-27"] });
    assert.deepEqual(dayLines(lines).map((l) => l.day), ["2026-09-27"]);
    // The SPACE is over a small allowance: billed for the open day, and no row for the finished one.
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-27"]);
    const [rows] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_bills where day = '2026-09-28'`;
    assert.equal(rows!.n, 0, "the finished day gains no row");
  });

  test("a day's recount is recorded: a day begun without one gets it on the next tick, a day with one is not recounted again", async () => {
    await fresh();
    const s = await space();
    // A day a tick began and died in before its recount ran.
    await fixture.owner`insert into schellingaf.billing_runs (day) values ('2026-09-24')`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 111 where space_id = ${s.id}::uuid`;
    const wrong = await bytesOf(s.id);
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-25T03:00:00Z"), funding(HUGE, HUGE), lines), { state: "billed", days: ["2026-09-24"] });
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
    assert.deepEqual(await run(new Date("2026-09-26T03:00:00Z"), funding(HUGE, HUGE), next), { state: "billed", days: ["2026-09-25"] });
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
      await run(new Date("2026-10-02T03:00:00Z"), funding(HUGE, HUGE), lines);
      const [line] = dayLines(lines);
      assert.deepEqual(Object.keys(line!.visibility.public.spaces_over), ["1000000", "5000000", "10000000", "25000000", "100000000"]);
      for (const v of ["public", "private", "sealed"] as const) {
        assert.deepEqual(line!.visibility[v].spaces_over, expected(v, FUNDING.spacesOverBytes), v);
      }
      assert.ok(line!.visibility.public.spaces_over["25000000"]! >= 1 && line!.visibility.private.spaces_over["5000000"]! >= 1);
      assert.equal(line!.visibility.private.spaces_over["10000000"], expected("private", [10_000_000])["10000000"]);
      for (const s of [big, mid]) assert.ok(!lines[lines.length - 1]!.includes(s.id) && !lines[lines.length - 1]!.includes(s.name));

      // The sizes are FUNDING's, passed in: other sizes, other keys.
      await fresh();
      await fixture.owner`insert into schellingaf.billing_runs (day, recounted_at) values ('2026-10-01', now())`;
      const other: string[] = [];
      await run(new Date("2026-10-02T03:00:00Z"), { ...funding(HUGE, HUGE), spacesOverBytes: [6_500_000] }, other);
      const [line2] = dayLines(other);
      assert.deepEqual(line2!.visibility.private.spaces_over, expected("private", [6_500_000]));
      assert.deepEqual(line2!.visibility.sealed.spaces_over, { "6500000": 0 });
    } finally {
      await fixture.owner`update schellingaf.space_storage set post_bytes = schellingaf.space_post_bytes_true(space_id) where space_id in (${big.id}::uuid, ${mid.id}::uuid)`;
    }
  });

  test("a day with no SPACE over is finished with one line of zeros, and the next tick does not redo it", async () => {
    await fresh();
    await space();
    const lines: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-17T00:10:00Z"), funding(HUGE, HUGE, HUGE), lines), { state: "billed", days: ["2026-09-16"] });
    const line: DayLine | undefined = dayLines(lines)[0];
    assert.ok(line);
    assert.deepEqual(Object.keys(line), ["event", "day", "mode", "measured_at", "rate", "visibility", "skipped", "faults_held", "recount"]);
    assert.deepEqual({ event: line.event, mode: line.mode }, { event: "billing.day", mode: "shadow" });
    assert.deepEqual(line.rate, { micro_usd_per_gb_month: 5_000_000, days_per_month: 30, bytes_per_gb: 1_000_000_000 });
    assert.deepEqual(Object.keys(line.visibility), ["public", "private", "sealed"]);
    for (const v of ["public", "private", "sealed"] as const) {
      const f: DayLine["visibility"]["public"] = line.visibility[v];
      assert.deepEqual(Object.keys(f), ["allowance_bytes", "spaces", "over", "billable_bytes", "max_billable_bytes", "spaces_over", "over_bytes", "due_micro_usd"]);
      assert.deepEqual({ allowance: f.allowance_bytes, over: f.over, over_bytes: f.over_bytes, due: f.due_micro_usd }, { allowance: HUGE, over: 0, over_bytes: 0, due: 0 }, v);
    }
    assert.ok(line.visibility.public.spaces >= 1 && line.visibility.public.billable_bytes > 8000);
    assert.deepEqual(Object.keys(line.recount ?? {}), ["spaces", "corrected", "failed", "post_bytes_delta", "file_bytes_delta"]);
    const [kept] = await fixture.owner<{ summary: DayLine }[]>`select summary from schellingaf.billing_runs where day = '2026-09-16'`;
    assert.deepEqual(kept!.summary, line, "the day keeps its line");
    const next: string[] = [];
    assert.deepEqual(await run(new Date("2026-09-17T05:00:00Z"), funding(HUGE, HUGE, HUGE), next), { state: "idle" });
    assert.deepEqual(next, []);
  });

  test("two runs at once: one is busy, one line, one bill a SPACE", async () => {
    await fresh();
    const s = await space();
    const lines: string[] = [];
    const now = new Date("2026-09-19T00:30:00Z");
    const results = await Promise.all([run(now, funding(100), lines), run(now, funding(100), lines)]);
    assert.deepEqual(results.map((r) => r.state).sort(), ["billed", "busy"]);
    assert.equal(dayLines(lines).length, 1);
    assert.equal((await bills(s.id)).filter((b) => b.day === "2026-09-18").length, 1);
  });
});

describe("the bills", () => {
  test("a day's bill rounds down: 6,000 bytes over is 1 micro-dollar, 5,999 a row of 0, none over no row; each visibility its own allowance", async () => {
    const s = await space("public");
    const p = await space("private");
    const bs = await bytesOf(s.id);
    const bp = await bytesOf(p.id);
    assert.ok(bs > 6000 && bp > 6000, `${bs} and ${bp}`);
    const day = async (d: string, f: Funding) => {
      await fresh();
      await run(new Date(`${addDays(d, 1)}T12:00:00Z`), f);
    };
    await day("2026-09-01", funding(bs - 6000));
    await day("2026-09-02", funding(bs - 5999));
    await day("2026-09-03", funding(bs));
    const rows = await bills(s.id);
    assert.deepEqual(rows.map((b) => ({ day: b.day, due: b.due_micro, allowance: b.allowance_bytes })), [
      { day: "2026-09-01", due: "1", allowance: String(bs - 6000) },
      { day: "2026-09-02", due: "0", allowance: String(bs - 5999) },
    ]);
    assert.deepEqual({ ...rows[0]! }, {
      day: "2026-09-01", post_bytes: String(bs), file_bytes: "0", allowance_bytes: String(bs - 6000), micro_usd_per_gb_month: "5000000",
      days_per_month: 30, bytes_per_gb: "1000000000", due_micro: "1", taken_micro: "0", shadow: true,
    });
    assert.deepEqual(await bills(p.id), [], "a private SPACE is held to the private allowance");
    // The private allowance, and the public one far above every public SPACE.
    await day("2026-09-04", funding(HUGE, bp - 6000));
    assert.deepEqual((await bills(p.id)).map((b) => ({ day: b.day, due: b.due_micro, allowance: b.allowance_bytes })), [
      { day: "2026-09-04", due: "1", allowance: String(bp - 6000) },
    ]);
    assert.deepEqual((await bills(s.id)).map((b) => b.day), ["2026-09-01", "2026-09-02"]);
  });

  test("a shadow bill takes nothing: the balance stays, no bill is in the ledger, and a bill that is not shadow is refused", async () => {
    await fresh();
    const s = await space();
    await fixture.owner`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', 1000000, ${`deposit:${randomUUID()}`}, 'a test')`;
    await run(new Date("2026-09-21T03:00:00Z"), funding(100));
    const [row] = await bills(s.id);
    assert.deepEqual({ day: row!.day, shadow: row!.shadow, taken: row!.taken_micro }, { day: "2026-09-20", shadow: true, taken: "0" });
    const [credit] = await fixture.owner<{ balance: string; bills: number }[]>`
      select (select balance_micro::text from schellingaf.space_credit where space_id = ${s.id}::uuid) as balance,
             (select count(*)::int from schellingaf.credit_ledger where space_id = ${s.id}::uuid and kind = 'bill') as bills`;
    assert.deepEqual({ ...credit! }, { balance: "1000000", bills: 0 });
    await assert.rejects(
      fixture.api`select schellingaf.bill_space_day(${s.id}::uuid, '2026-09-25', 100, 100, 100, 5000000, 30, 1000000000, false)`,
      (e: any) => e.message === "INVALID_REQUEST" && e.detail === "billing has not started",
    );
    assert.equal((await bills(s.id)).length, 1);
  });

  test("a SPACE whose balance disagrees with its ledger gets no bill and is counted skipped; the others are billed", async () => {
    await fresh();
    const s = await space();
    const t = await space();
    await fixture.owner`select * from schellingaf.credit_post(${s.id}::uuid, 'deposit', 10, ${`deposit:${randomUUID()}`})`;
    await fixture.owner`update schellingaf.space_credit set balance_micro = balance_micro + 1 where space_id = ${s.id}::uuid`;
    const lines: string[] = [];
    await run(new Date("2026-09-23T03:00:00Z"), funding(100), lines);
    assert.deepEqual(await bills(s.id), []);
    assert.deepEqual((await bills(t.id)).map((b) => b.day), ["2026-09-22"]);
    const [line] = dayLines(lines);
    assert.deepEqual(line!.skipped, { fault: 1, failed: 0 });
    assert.ok((line!.faults_held ?? 0) >= 1);
  });

  test("a SPACE made after the day ended is not billed for it", async () => {
    await fresh();
    const before = await space("public", "2026-09-24T23:59:59Z");
    const after = await space("public", "2026-09-25T00:00:00Z");
    await run(new Date("2026-09-25T12:00:00Z"), funding(100));
    assert.deepEqual((await bills(before.id)).map((b) => b.day), ["2026-09-24"]);
    assert.deepEqual(await bills(after.id), []);
  });

  test("a day's line names no SPACE: none of this file's names or ids is in it", async () => {
    await fresh();
    await space();
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 5 where space_id = ${made[0]!.id}::uuid`;
    const lines: string[] = [];
    await run(new Date("2026-09-30T03:00:00Z"), funding(100), lines);
    const [line] = lines.filter((l) => JSON.parse(l).event === "billing.day");
    assert.ok(line);
    assert.ok(JSON.parse(line).visibility.public.over >= 1, line);
    for (const s of made) {
      assert.ok(!line.includes(s.name), `${s.name} is in the line`);
      assert.ok(!line.includes(s.id), `${s.id} is in the line`);
    }
    // The recount's own line names the SPACE it corrected, by id, for the operator.
    assert.ok(lines.some((l) => JSON.parse(l).event === "storage.recount" && JSON.parse(l).space_id === made[0]!.id));
  });
});

describe("the migrations", () => {
  test("0149 and 0150 wait 1.5 s at most for a lock, set right after the search path", () => {
    for (const file of ["0149_space_credit.sql", "0150_billing.sql"]) {
      const lines = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8").split("\n").filter((l) => !l.startsWith("--"));
      const at = lines.indexOf("SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;");
      assert.ok(at >= 0, file);
      assert.equal(lines[at + 1], "SET LOCAL lock_timeout = '1500ms';", file);
    }
  });
});

describe("the service starts the job", () => {
  test("at boot, and never under READ_ONLY=1", async () => {
    await fresh();
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
      // Read-only: nothing is billed, though a day is due.
      const readOnly = await start({ READ_ONLY: "1" }, () => false, 3000);
      assert.doesNotMatch(readOnly, /"event":"billing\.day"/);
      assert.equal(await runs(), 0, "a read-only service began a billing day");
      // Otherwise the first tick, at boot, bills yesterday and logs it.
      const writing = await start({}, (out) => out.includes('"event":"billing.day"'), 15_000);
      assert.match(writing, /"event":"billing\.day"/);
      assert.equal(await runs(), 1);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
