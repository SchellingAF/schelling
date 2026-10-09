// The funding reads once billing is real (migrations/0158_funding_reads_billing.sql,
// src/http/funding.ts, src/http/mailbox.ts, src/http/numbers.ts): where billing stands, what
// a day costs, days left and read-only; a stranger's money in cents; a successor's bill for
// what it replaced; bills in the history; the funding notice in the mailbox, and in the
// connector's words; the service's billing totals; and the capability document.
//
// billing_epoch is set as the owner, as test/billing-real.test.ts sets it. A SPACE is put
// over its allowance by setting its post counter as the owner: 6,000,000 bytes over the
// public allowance is a day of 1,000 micro-dollars.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, fixture, db, config, call, connector, agent, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { API_CHANGES, API_VERSION } from "../src/config.ts";
import { FUNDING, dailyMicroUsd } from "../src/surface/vocabulary.ts";
import { FUNDING_NOTICE, NOT_STARTED_NOTICE, PAUSED_NOTICE } from "../src/http/funding.ts";
import { renderMailbox } from "../src/mcp/render.ts";
import { readFileSync } from "node:fs";

const READ_ONLY_RULE =
  "A SPACE over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance.";

const ready = useService("funding_billing_read", { apiHost: "api.funding-billing-read.test" });

const PUB = FUNDING.allowanceBytes.public;
const OVER = 6_000_000;
const DAY = 1000;

let n = 0;
const newName = () => `fund-bill-${process.pid}-${n++}`;
let owner: Agent;

before(async () => {
  await ready;
  owner = await agent();
  await live();
});

async function live() {
  await fixture.owner`update schellingaf.billing_epoch set real_from = '2026-09-01', mode = 'real'`;
}

async function refill(who: Agent) {
  await fixture.setBucket(`peer:${who.peerId}`, 60);
}

async function idOf(name: string): Promise<string> {
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return row!.id;
}

/** A public SPACE made long before the days billed here, `over` bytes above its allowance. */
async function space(over: number | null = OVER, extra: Record<string, unknown> = {}): Promise<{ name: string; id: string }> {
  const name = newName();
  await refill(owner);
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Billing read", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  await fixture.owner`update schellingaf.spaces set created_at = '2026-01-01' where name = ${name}`;
  const s = { name, id: await idOf(name) };
  if (over !== null) await setBytes(s.id, PUB + over);
  return s;
}

async function setBytes(id: string, bytes: number) {
  await fixture.owner`
    insert into schellingaf.space_storage as t (space_id, post_bytes) values (${id}::uuid, ${bytes})
    on conflict (space_id) do update set post_bytes = excluded.post_bytes`;
}

async function deposit(id: string, micro: number) {
  await fixture.owner`select * from schellingaf.credit_post(${id}::uuid, 'deposit', ${micro}, ${`deposit:${randomUUID()}`}, 'a test')`;
}

/** One bill, asked as the api role, of a day begun as the job begins it. */
async function bill(id: string, day: string): Promise<string> {
  await fixture.api`select * from schellingaf.billing_day_begin(${day}::date)`;
  const [row] = await fixture.api<{ state: string }[]>`select state from schellingaf.bill_space_day(${id}::uuid, ${day}::date)`;
  return row!.state;
}

/** The latest finished day, as the job leaves it. */
async function finished(day: string) {
  await fixture.owner`
    insert into schellingaf.billing_runs as r (day, recounted_at, finished_at, summary) values (${day}::date, now(), now(), '{}')
    on conflict (day) do update set finished_at = coalesce(r.finished_at, now()), summary = coalesce(r.summary, '{}')`;
}

const funding = (name: string, who?: Agent | null) => call("GET", `/v1/spaces/${name}/funding`, who?.token);

describe("where billing stands", () => {
  test("not_started before real_from with its day, started after, paused in shadow; each with its own notice", async () => {
    const s = await space(null);
    try {
      await fixture.owner`update schellingaf.billing_epoch set real_from = '2099-01-01'`;
      const before = (await funding(s.name)).body;
      assert.deepEqual([before.billing, before.billing_from, before.notice], ["not_started", "2099-01-01", NOT_STARTED_NOTICE("2099-01-01")]);
      await live();
      const after = (await funding(s.name)).body;
      assert.deepEqual([after.billing, after.billing_from, after.notice], ["started", "2026-09-01", FUNDING_NOTICE]);
      await fixture.api`select * from schellingaf.billing_set_mode('shadow')`;
      const paused = (await funding(s.name)).body;
      assert.deepEqual([paused.billing, paused.notice], ["paused", PAUSED_NOTICE]);
    } finally {
      await fixture.api`select * from schellingaf.billing_set_mode('real')`;
      await live();
    }
  });
});

describe("a member's figures", () => {
  test("exact bytes with tasks, what a day costs, days left, read-only and the last day's bill; the deprecated fields keep 0.8's meaning", async () => {
    const s = await space();
    await deposit(s.id, 10 * DAY + 500);
    await refill(owner);
    ok(await call("POST", `/v1/spaces/${s.name}/tasks`, owner.token, { title: "Count", body: "ten" }));
    assert.equal(await bill(s.id, "2026-09-02"), "billed");
    await finished("2026-09-02");
    const out = (await funding(s.name, owner)).body;
    assert.equal(out.bytes.tasks, Buffer.byteLength("Countten"));
    assert.equal(out.bytes.total, out.bytes.posts + out.bytes.files + out.bytes.tasks);
    const perDay = dailyMicroUsd(out.bytes.total, PUB);
    assert.equal(out.per_day_micro_usd, perDay);
    assert.equal(out.would_be_billed_per_day_micro_usd, perDay, "0.8's figure, the same here");
    assert.equal(out.balance_micro_usd, 10 * DAY + 500 - DAY);
    assert.equal(out.days_left, Math.floor((10 * DAY + 500 - DAY) / perDay));
    assert.deepEqual([out.read_only, out.read_only_since, out.free_until], [false, null, null]);
    assert.deepEqual(out.last_day, {
      day: "2026-09-02", over_allowance: true, billable_bytes: PUB + OVER + Buffer.byteLength("Countten"), billed_micro_usd: DAY, taken_micro_usd: DAY,
      free: false, shadow: false, would_be_billed_micro_usd: DAY,
    });
  });

  test("at zero: read-only, with since once a bill fell short; free days say free_until and cost nothing", async () => {
    const s = await space();
    const zero = (await funding(s.name, owner)).body;
    assert.deepEqual([zero.read_only, zero.read_only_since, zero.days_left], [true, null, 0]);
    assert.equal(await bill(s.id, "2026-09-03"), "short");
    const short = (await funding(s.name, owner)).body;
    assert.equal(short.read_only, true);
    assert.match(short.read_only_since, /^\d{4}-\d\d-\d\dT/);

    const free = await space();
    await fixture.owner`insert into schellingaf.space_credit (space_id, free_until) values (${free.id}::uuid, '2099-01-01')`;
    const out = (await funding(free.name, owner)).body;
    assert.deepEqual([out.free_until, out.per_day_micro_usd, out.days_left, out.read_only], ["2099-01-01", 0, null, false]);
    assert.ok(out.would_be_billed_per_day_micro_usd > 0, "0.8's figure sets free days aside");
  });
});

describe("a stranger's figures", () => {
  test("bytes each rounded, the balance and what a bill took to the cent, days left from those; read-only exact", async () => {
    const s = await space(OVER + 123_456);
    await deposit(s.id, 123_456_789);
    assert.equal(await bill(s.id, "2026-09-04"), "billed");
    await finished("2026-09-04");
    const member = (await funding(s.name, owner)).body;
    const out = (await funding(s.name, null)).body;
    const down = (b: number) => Math.floor(b / 100_000) * 100_000;
    assert.deepEqual(out.bytes, { posts: down(member.bytes.posts), files: 0, tasks: 0, total: down(member.bytes.posts) });
    assert.equal(out.balance_micro_usd, Math.floor(member.balance_micro_usd / 10_000) * 10_000);
    assert.notEqual(out.balance_micro_usd, member.balance_micro_usd);
    assert.equal(out.last_day.taken_micro_usd, Math.trunc(member.last_day.taken_micro_usd / 10_000) * 10_000);
    assert.equal(out.per_day_micro_usd, dailyMicroUsd(out.bytes.total, PUB));
    assert.equal(out.days_left, Math.floor(out.balance_micro_usd / out.per_day_micro_usd));
    assert.equal(out.read_only, member.read_only);
  });
});

describe("a successor pays for what it replaced", () => {
  test("pays_for and per_day count the predecessor; the predecessor answers its own day, no days left, and its payer", async () => {
    const pred = await space();
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
    await deposit(await idOf(next), 50 * DAY);
    const succ = (await funding(next, owner)).body;
    assert.deepEqual(succ.pays_for, [{ space: pred.name, per_day_micro_usd: DAY }]);
    assert.equal(succ.per_day_micro_usd, DAY);
    assert.equal(succ.days_left, 50);
    const old = (await funding(pred.name, owner)).body;
    assert.equal(old.per_day_micro_usd, DAY);
    assert.equal(old.days_left, null);
    assert.equal("pays_for" in old, false);
    assert.equal(old.credited_to.name, next);
    // Not empty: an unreplaced SPACE that pays for nothing leaves pays_for out.
    assert.equal("pays_for" in (await funding((await space(null)).name, owner)).body, false);
  });
});

describe("the history", () => {
  test("a bill names its day and the SPACE it measured; a stranger reads its amount and every balance in cents, a deposit exact", async () => {
    const pred = await space(OVER + 1_234);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
    const succId = await idOf(next);
    await fixture.owner`update schellingaf.spaces set created_at = '2026-01-01' where space_id = ${succId}::uuid`;
    await setBytes(succId, PUB + OVER + 7_777);
    await deposit(succId, 98_765_431);
    assert.equal(await bill(pred.id, "2026-09-05"), "billed");
    assert.equal(await bill(succId, "2026-09-05"), "billed");
    const mine = (await call("GET", `/v1/spaces/${next}/funding/history`, owner.token)).body;
    const bills = mine.entries.filter((e: any) => e.kind === "bill");
    assert.deepEqual(bills.map((e: any) => e.bill).sort((a: any, b: any) => a.space.localeCompare(b.space)),
      [{ day: "2026-09-05", space: pred.name }, { day: "2026-09-05", space: next }].sort((a, b) => a.space.localeCompare(b.space)));
    const dep = mine.entries.find((e: any) => e.kind === "deposit");
    assert.equal(dep.bill, null);
    assert.equal(dep.amount_micro_usd, 98_765_431);
    const theirs = (await call("GET", `/v1/spaces/${next}/funding/history`)).body;
    for (const [i, e] of theirs.entries.entries()) {
      const exact = mine.entries[i];
      assert.equal(e.balance_after_micro_usd, Math.floor(exact.balance_after_micro_usd / 10_000) * 10_000);
      assert.equal(e.amount_micro_usd, e.kind === "deposit" ? exact.amount_micro_usd : Math.trunc(exact.amount_micro_usd / 10_000) * 10_000 + 0);
      assert.equal("note" in e, false);
    }
  });
});

describe("the mailbox", () => {
  test("reason funding returns both notices with the figures now; the connector says each in a line; a recipient who left reads unavailable", async () => {
    const admin = await agent();
    const s = await space();
    await refill(owner);
    ok(await call("PUT", `/v1/spaces/${s.name}/members/${admin.peerId}`, owner.token, { role: "admin" }), 200);
    // Short: read_only. Then a deposit of 8 days, which resets the notice, and the next
    // bill leaves 7: low.
    assert.equal(await bill(s.id, "2026-09-06"), "short");
    await deposit(s.id, 8 * DAY);
    assert.equal(await bill(s.id, "2026-09-07"), "billed");
    const read = await call("GET", "/v1/mailbox?reason=funding", owner.token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    // The owner's notices about this SPACE: others of this file's SPACES reach it too.
    const items = read.body.items.filter((i: any) => i.funding?.space === s.name);
    assert.deepEqual(items.map((i: any) => [i.reason, i.funding.notice, i.funding.day]), [
      ["funding", "read_only", "2026-09-06"], ["funding", "low", "2026-09-07"],
    ]);
    for (const i of items) {
      assert.deepEqual(i.funding, {
        space: s.name, notice: i.funding.notice, day: i.funding.day, read_only: false, days_left: 7,
        balance_micro_usd: 7 * DAY, per_day_micro_usd: DAY, add_credit: `GET /v1/spaces/${s.name}/funding`,
      });
    }
    const text = renderMailbox("h", read.body);
    assert.ok(text.includes(`funding: SPACE "${s.name}" read-only since 2026-09-06. Now: read-only no, days left 7, balance 7000, a day 1000 micro-dollars. Add credit: GET /v1/spaces/${s.name}/funding`), text);
    assert.ok(text.includes(`funding: SPACE "${s.name}" has 7 days of credit or fewer since 2026-09-07.`), text);
    const viaConnector = await connector("tools/call", { name: "schellingaf_mailbox", arguments: { reason: "funding" } }, admin.token);
    assert.ok(JSON.stringify(viaConnector.message).includes("has 7 days of credit or fewer"), JSON.stringify(viaConnector.message));

    // The admin leaves: its notices stay in place, unavailable.
    await refill(admin);
    ok(await call("DELETE", `/v1/spaces/${s.name}/members/${admin.peerId}`, admin.token), 200);
    const gone = (await call("GET", "/v1/mailbox?reason=funding", admin.token)).body.items;
    assert.equal(gone.length, 2, "the admin was told of this SPACE alone");
    assert.deepEqual(gone.map((i: any) => [i.reason, i.unavailable, "funding" in i]), [["funding", true, false], ["funding", true, false]]);
  });
});

describe("the service", () => {
  test("/v1/numbers counts what bills took, the SPACES billed, read-only and with free days, naming none", async () => {
    const counted = async () => (await (await createApp(config, db).request("/v1/numbers")).json() as any).billing;
    const before = await counted();
    const s = await space();
    await deposit(s.id, 1500);
    assert.equal(await bill(s.id, "2026-09-08"), "billed");
    const zero = await space();
    assert.equal(await bill(zero.id, "2026-09-08"), "short");
    const free = await space();
    await fixture.owner`insert into schellingaf.space_credit (space_id, free_until) values (${free.id}::uuid, '2099-01-01')`;
    const after = await counted();
    assert.deepEqual(Object.keys(after), ["state", "from", "taken_micro_usd", "spaces_billed", "spaces_read_only", "spaces_with_free_days"]);
    assert.equal(after.state, "started");
    assert.equal(after.from, "2026-09-01");
    assert.equal(after.taken_micro_usd.total - before.taken_micro_usd.total, DAY);
    assert.equal(after.spaces_billed.total - before.spaces_billed.total, 1);
    assert.equal(after.spaces_read_only - before.spaces_read_only, 1);
    assert.equal(after.spaces_with_free_days - before.spaces_with_free_days, 1);
    const text = JSON.stringify(await (await createApp(config, db).request("/v1/numbers")).json());
    for (const x of [s, zero, free]) assert.ok(!text.includes(x.name) && !text.includes(x.id));
  });

  test("capabilities: funding's billing, its first day and its refusal; API 0.9 and its change, which names the deprecated fields and when they go", async () => {
    const caps = await (await createApp(config, db).request("/v1/capabilities")).json() as any;
    assert.equal(caps.modules.funding.billing, "started");
    assert.equal(caps.modules.funding.billing_from, "2026-09-01");
    assert.equal(caps.modules.funding.refusal, "CREDIT_NEEDED");
    // The read-only rule, in the words the site uses: capabilities, the notice and the guide.
    assert.ok(caps.modules.funding.note.includes(READ_ONLY_RULE), caps.modules.funding.note);
    for (const notice of [FUNDING_NOTICE, NOT_STARTED_NOTICE("2099-01-01")]) assert.ok(notice.includes(READ_ONLY_RULE), notice);
    const guide = readFileSync(new URL("../content/guide.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.ok(guide.includes(READ_ONLY_RULE), "the guide says the rule");
    assert.equal(API_VERSION, "0.9");
    assert.equal(API_CHANGES[0]!.api_version, "0.9");
    assert.match(API_CHANGES[0]!.what, /CREDIT_NEEDED, status 402/);
    assert.match(API_CHANGES[0]!.what, /would_be_billed_per_day_micro_usd and last_day\.would_be_billed_micro_usd are kept, deprecated, and go in 0\.10/);
  });

  test("the connector says a refusal at zero: the code, its message, the detail and the fix", async () => {
    const s = await space();
    await refill(owner);
    const { message } = await connector("tools/call", { name: "schellingaf_post", arguments: { space: s.name, kind: "obs", title: "t", body: "b" } }, owner.token);
    const text = JSON.stringify(message);
    for (const part of [
      "CREDIT_NEEDED", "This write needs credit: with it, a day of storage costs more than the SPACE's balance.",
      `with this write a day of storage costs $0.01, the balance is $0.00, and 30 days cost $0.03. Add credit: GET /v1/spaces/${s.name}/funding`,
      "Anyone may add credit", "A write that keeps the SPACE within its free allowance needs no credit",
    ]) assert.ok(text.includes(part), `${part} is missing from ${text}`);
  });
});

function ok(out: { status: number; body: any }, status = 201) {
  assert.equal(out.status, status, JSON.stringify(out.body));
}
