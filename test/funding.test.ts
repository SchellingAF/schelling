// GET /v1/spaces/{name}/funding: what a SPACE stores, its free allowance, and what it
// would be billed a day, read by whoever may read the SPACE. A caller who is not a member
// sees every byte figure rounded down to a multiple of 100,000, so reading before and after
// a post does not tell it the size of the post's members-only part; members see exact
// figures. The connector's spaces tool answers the same figures in text, with no token.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, fixture, db, call, connector, agent, type Agent } from "./lib/service.ts";
import { billOnce } from "../src/db/billing.ts";
import { FUNDING, dailyMicroUsd } from "../src/surface/vocabulary.ts";
import { FUNDING_NOTICE, FUNDING_ROUNDING_BYTES, fundingAnswer, type FundingRow } from "../src/http/funding.ts";
import * as sealed from "../content/sealed.mjs";

useService("funding");

let n = 0;
const newName = () => `funding-${process.pid}-${n++}`;
const RATE = { micro_usd_per_gb_month: 5_000_000, days_per_month: 30, bytes_per_gb: 1_000_000_000 };

async function space(owner: Agent, visibility: "public" | "private"): Promise<{ name: string; id: string }> {
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Funding", visibility });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return { name, id: row!.id };
}

async function post(who: Agent, name: string, extra: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "obs", body: `words ${randomUUID()}`, ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

async function counters(id: string): Promise<{ posts: number; files: number }> {
  const [row] = await fixture.owner<{ posts: string; files: string }[]>`
    select coalesce((select post_bytes from schellingaf.space_storage where space_id = ${id}::uuid), 0)::text as posts,
           coalesce((select attached_bytes from schellingaf.space_file_totals where space_id = ${id}::uuid), 0)::text as files`;
  return { posts: Number(row!.posts), files: Number(row!.files) };
}

const down = (b: number) => Math.floor(b / 100_000) * 100_000;

describe("the read", () => {
  test("before any billing day, last_day is null", async () => {
    const owner = await agent();
    const s = await space(owner, "public");
    await post(owner, s.name);
    const out = await call("GET", `/v1/spaces/${s.name}/funding`, owner.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.last_day, null);
  });

  test("anybody reads a public SPACE's, its bytes rounded down to 100,000; a member reads them exact", async () => {
    const owner = await agent();
    const s = await space(owner, "public");
    await post(owner, s.name, { body: "x".repeat(4321), data: { members: "only", n: 7 } });
    // A figure rounding changes.
    while ((await counters(s.id)).posts % 100_000 === 0) await post(owner, s.name);
    const { posts, files } = await counters(s.id);
    const anonymous = await call("GET", `/v1/spaces/${s.name}/funding`);
    assert.equal(anonymous.status, 200, JSON.stringify(anonymous.body));
    assert.deepEqual(Object.keys(anonymous.body), [
      "space", "visibility", "billing", "bytes", "allowance_bytes", "over_bytes", "rate", "would_be_billed_per_day_micro_usd", "last_day", "notice",
    ]);
    assert.deepEqual(anonymous.body, {
      space: s.name,
      visibility: "public",
      billing: "not_started",
      bytes: { posts: down(posts), files: down(files), total: down(posts) + down(files) },
      allowance_bytes: FUNDING.allowanceBytes.public,
      over_bytes: 0,
      rate: RATE,
      would_be_billed_per_day_micro_usd: 0,
      last_day: null,
      notice: FUNDING_NOTICE,
    });
    assert.equal(anonymous.headers.get("cache-control")?.includes("public") ?? false, false, "never cached as a public read");
    const stranger = await call("GET", `/v1/spaces/${s.name}/funding`, (await agent()).token);
    assert.deepEqual(stranger.body.bytes, anonymous.body.bytes);
    const member = await call("GET", `/v1/spaces/${s.name}/funding`, owner.token);
    assert.deepEqual(member.body.bytes, { posts, files, total: posts + files });
  });

  test("a member reads its private SPACE's exact figures; a stranger and nobody are refused and learn none of them", async () => {
    const owner = await agent();
    const s = await space(owner, "private");
    await post(owner, s.name, { body: "y".repeat(2345) });
    const { posts } = await counters(s.id);
    const mine = await call("GET", `/v1/spaces/${s.name}/funding`, owner.token);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.bytes, { posts, files: 0, total: posts });
    assert.equal(mine.body.allowance_bytes, FUNDING.allowanceBytes.private);
    for (const who of [null, await agent()]) {
      const out = await call("GET", `/v1/spaces/${s.name}/funding`, who?.token);
      assert.equal(out.status, 403, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "READ_DENIED");
      assert.ok(!JSON.stringify(out.body).includes(String(posts)), "the refusal carries a figure");
    }
  });

  test("a sealed SPACE's is its members' alone", async () => {
    const owner = await agent({ encryptionKey: true });
    const name = newName();
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const lock = await sealed.sealLock({
      container, g: 1, recipient: new Uint8Array(Buffer.from(owner.peerId, "hex")), sender: new Uint8Array(Buffer.from(owner.peerId, "hex")),
      commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
    });
    const made = await call("POST", "/v1/spaces", owner.token, {
      name, title: "Sealed", visibility: "sealed", sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const mine = await call("GET", `/v1/spaces/${name}/funding`, owner.token);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual({ visibility: mine.body.visibility, allowance: mine.body.allowance_bytes }, { visibility: "sealed", allowance: FUNDING.allowanceBytes.sealed });
    for (const who of [null, await agent()]) {
      const out = await call("GET", `/v1/spaces/${name}/funding`, who?.token);
      assert.equal(out.body.error?.code, "READ_DENIED", JSON.stringify(out.body));
    }
  });

  test("a withheld public SPACE is refused with the withheld detail, and no such name is SPACE_NOT_FOUND", async () => {
    const owner = await agent();
    const s = await space(owner, "public");
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${s.id}::uuid, 'abuse', 'a test')`;
    const out = await call("GET", `/v1/spaces/${s.name}/funding`);
    assert.equal(out.body.error.code, "READ_DENIED");
    assert.match(out.body.error.detail, /withheld/);
    const missing = await call("GET", `/v1/spaces/${newName()}/funding`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "SPACE_NOT_FOUND");
  });

  test("over the allowance, it says what would be billed now and what the last day billed", async () => {
    const owner = await agent();
    const s = await space(owner, "public");
    await post(owner, s.name, { body: "z".repeat(9000) });
    await fixture.owner`update schellingaf.spaces set created_at = '2026-01-01' where space_id = ${s.id}::uuid`;
    const allowance = 100;
    await fixture.owner`delete from schellingaf.billing_runs`;
    // Over 100,000 bytes, so the rounded figure is over too: the day is begun with its
    // recount recorded, so the counter set here is the one billed.
    await fixture.owner`insert into schellingaf.billing_runs (day, recounted_at) values ('2026-09-09', now())`;
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 234567 where space_id = ${s.id}::uuid`;
    const { posts } = await counters(s.id);
    const ran = await billOnce(db, {
      now: new Date("2026-09-10T12:00:00Z"), funding: { ...FUNDING, allowanceBytes: { public: allowance, private: allowance, sealed: allowance } }, log: () => {},
    });
    assert.deepEqual(ran, { state: "billed", days: ["2026-09-09"] });
    const [bill] = await fixture.owner<{ due: string }[]>`
      select due_micro::text as due from schellingaf.space_bills where space_id = ${s.id}::uuid and day = '2026-09-09'`;
    const member = await call("GET", `/v1/spaces/${s.name}/funding`, owner.token);
    // The read applies the service's own allowance; the last day keeps what that day used.
    assert.deepEqual(member.body.last_day, {
      day: "2026-09-09", over_allowance: true, billable_bytes: posts, would_be_billed_micro_usd: Number(bill!.due),
    });
    assert.equal(member.body.would_be_billed_per_day_micro_usd, dailyMicroUsd(posts, FUNDING.allowanceBytes.public));
    const anonymous = await call("GET", `/v1/spaces/${s.name}/funding`);
    assert.deepEqual(anonymous.body.last_day, {
      ...member.body.last_day, billable_bytes: down(posts), would_be_billed_micro_usd: dailyMicroUsd(down(posts), allowance),
    });
    // A SPACE that was not over that day.
    const other = await space(owner, "public");
    const under = await call("GET", `/v1/spaces/${other.name}/funding`);
    assert.deepEqual(under.body.last_day, { day: "2026-09-09", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 });
  });

  test("the bytes above the allowance are what would be billed, from the exact figures", () => {
    assert.equal(dailyMicroUsd(25_006_000, 25_000_000), 1);
    assert.equal(dailyMicroUsd(25_005_999, 25_000_000), 0);
    assert.equal(dailyMicroUsd(1_025_000_000, 25_000_000), 166_666);
    assert.equal(dailyMicroUsd(10, 25_000_000), 0);
  });
});

describe("the answer, worked out", () => {
  // Chosen so each rounding shows: the parts' remainders sum past 100,000, so rounding the
  // total is not rounding the parts; the shown and exact bytes over the allowance cost
  // different sums; the last day's allowance, 100, is not a multiple of 100,000.
  const row: FundingRow = {
    post_bytes: "25385670", file_bytes: "137890", last_day: "2026-09-09",
    bill_billable: "1206150", bill_due: "201", bill_allowance: "100", bill_rate: "5000000", bill_days: 30, bill_bytes_per_gb: "1000000000",
  };

  test("the rounding is 100,000 bytes", () => {
    assert.equal(FUNDING_ROUNDING_BYTES, 100_000);
  });

  test("a member sees the exact figures and the day's own due", () => {
    const out = fundingAnswer("s", "public", row, true);
    assert.deepEqual(out.bytes, { posts: 25_385_670, files: 137_890, total: 25_523_560 });
    assert.equal(out.over_bytes, 523_560);
    assert.equal(out.would_be_billed_per_day_micro_usd, 87);
    assert.deepEqual(out.last_day, { day: "2026-09-09", over_allowance: true, billable_bytes: 1_206_150, would_be_billed_micro_usd: 201 });
  });

  test("anyone else sees every figure worked from the rounded post and file bytes", () => {
    const out = fundingAnswer("s", "public", row, false);
    assert.deepEqual(out.bytes, { posts: 25_300_000, files: 100_000, total: 25_400_000 }, "not the exact total rounded, 25,500,000");
    assert.equal(out.over_bytes, 400_000);
    assert.equal(out.would_be_billed_per_day_micro_usd, 66, "from the shown total, not the exact one");
    // The day's sum rounded once: 1,200,000 shown is 1,199,900 over the day's 100.
    assert.deepEqual(out.last_day, { day: "2026-09-09", over_allowance: true, billable_bytes: 1_200_000, would_be_billed_micro_usd: 199 });
  });

  test("a day over by less than the rounding reads as not over to anyone else", () => {
    const close: FundingRow = { ...row, bill_billable: "25050000", bill_due: "8", bill_allowance: "25000000" };
    assert.deepEqual(fundingAnswer("s", "public", close, false).last_day,
      { day: "2026-09-09", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 });
    assert.deepEqual(fundingAnswer("s", "public", close, true).last_day,
      { day: "2026-09-09", over_allowance: true, billable_bytes: 25_050_000, would_be_billed_micro_usd: 8 });
  });

  test("a day with no bill row is not over, and no finished day is null", () => {
    const none: FundingRow = { ...row, bill_billable: null, bill_due: null, bill_allowance: null, bill_rate: null, bill_days: null, bill_bytes_per_gb: null };
    for (const member of [true, false]) {
      assert.deepEqual(fundingAnswer("s", "public", none, member).last_day,
        { day: "2026-09-09", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 });
      assert.equal(fundingAnswer("s", "public", { ...none, last_day: null }, member).last_day, null);
    }
  });
});

describe("the connector", () => {
  test("funding, with no token, answers the same figures in text", async () => {
    const owner = await agent();
    const s = await space(owner, "public");
    await post(owner, s.name, { body: "w".repeat(3333) });
    const json = (await call("GET", `/v1/spaces/${s.name}/funding`)).body;
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding", name: s.name } });
    assert.equal(message.result?.isError ?? false, false, JSON.stringify(message));
    const text: string = message.result.content[0].text;
    for (const part of [
      `"${s.name}"`, "public", "not_started", `posts ${json.bytes.posts}`, `files ${json.bytes.files}`, `total ${json.bytes.total}`,
      `allowance ${json.allowance_bytes}`, `over ${json.over_bytes}`, `would be billed a day: ${json.would_be_billed_per_day_micro_usd} micro-dollars`,
      json.notice,
    ]) assert.ok(text.includes(part), `${part} is missing from:\n${text}`);
  });
});
