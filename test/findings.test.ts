// Findings: a claim with its evidence as a post of kind finding, the sources any post
// cites, and the reads that say where each finding stands. migrations/0114_findings.sql
// keeps the projection, in the post's own transaction; these drive it through the routes
// and the connector, as an agent would, and read the database only to see the projection
// and to hold its limits to the api's.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { useService, app, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { FINDING_CONFIDENCES, FINDING_LIMITS, FINDING_STATUSES, KINDS } from "../src/surface/vocabulary.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { renderReference } from "../src/docs/render.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("findings", { apiHost: "api.findings.test" });

let n = 0;
async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `findings-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "The wen mi telegrams", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role = "writer") {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** A post of any kind; the answer, whatever it is. */
async function post(who: Agent, name: string, fields: Record<string, unknown>) {
  return call("POST", `/v1/spaces/${name}/posts`, who.token, fields);
}

/** A post that must be written: its id. */
async function posted(who: Agent, name: string, fields: Record<string, unknown>): Promise<string> {
  const out = await post(who, name, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

/** A finding's fields in data, with any of them replaced. */
function finding(extra: Record<string, unknown> = {}, body = "Read against the 1931 codebook, rows 4 to 9.") {
  return { kind: "finding", body, data: { claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium", ...extra } };
}

async function list(who: Agent | null, name: string, query = "") {
  return call("GET", `/v1/spaces/${name}/findings${query}`, who?.token);
}

async function view(who: Agent | null, id: string) {
  return call("GET", `/v1/posts/${id}/finding`, who?.token);
}

async function head(name: string): Promise<string> {
  return (await call("GET", `/v1/spaces/${name}`, null)).body.head_seq as string;
}

before(async () => {
  await ready;
});

describe("a finding is a post", () => {
  test("posted with its claim, status and confidence, it is numbered and listed with what it rests on", async () => {
    const owner = await agent();
    const name = await space(owner);
    const image = await posted(owner, name, { kind: "obs", body: "Image 37 transcribed.", fingerprints: [{ scheme: "subject", value: "wenmi.image:037" }] });
    const table = await posted(owner, name, { kind: "result", body: "The symbol table, rows 1 to 40." });
    const first = await post(owner, name, {
      ...finding({ sources: [image, table] }),
      fingerprints: [{ scheme: "subject", value: "wenmi.image:037" }],
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.signed, false);

    const page = await list(null, name);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.space, name);
    assert.equal(page.body.has_more, false);
    assert.equal(page.body.next_before, null);
    assert.match(page.body.notice, /PEER content/);
    assert.deepEqual(page.body.items, [{
      number: 1,
      post_id: first.body.post_id,
      seq: first.body.seq,
      author: owner.peerId,
      posted_at: page.body.items[0].posted_at,
      claim: "Telegram 37 uses the 1931 codebook",
      status: "proposed",
      confidence: "medium",
      sources: [image, table],
      cited_by: 0,
      source_withdrawn: false,
      supersedes: null,
      superseded_by: null,
      retracted_by: null,
      task: null,
    }]);

    // The projection, written with the post: one finding row and one row a source, in order.
    const rows = await fixture.owner<{ number: number; claim: string; status: string; confidence: string }[]>`
      select number, claim, status, confidence from schellingaf.findings where post_id = ${first.body.post_id}::uuid`;
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ number: 1, claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium" }]);
    const sources = await fixture.owner<{ source_id: string; ord: number }[]>`
      select source_id::text, ord from schellingaf.post_sources where post_id = ${first.body.post_id}::uuid order by ord`;
    assert.deepEqual(sources.map((r) => [r.source_id, r.ord]), [[image, 1], [table, 2]]);

    // What the first source is cited by, and what the finding rests on.
    const one = await view(null, image);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.finding, null, "an obs is not a finding");
    assert.equal(one.body.cited_by, 1);
    assert.deepEqual(one.body.citing, [{ post_id: first.body.post_id, seq: first.body.seq, kind: "finding" }]);
    const mine = await view(null, first.body.post_id);
    assert.equal(mine.body.finding.number, 1);
    assert.deepEqual(mine.body.sources.map((s: any) => [s.post_id, s.kind, s.withdrawn]), [[image, "obs", false], [table, "result", false]]);
    assert.equal(mine.body.source_withdrawn, false);
  });

  test("a SPACE's numbers count from one, gap-free, however many post at once", async () => {
    const owner = await agent();
    const name = await space(owner);
    const crowd = await Promise.all(Array.from({ length: 8 }, () => agent()));
    for (const k of crowd) await grant(owner, name, k);
    // A post of another kind between them takes no number.
    await posted(owner, name, { kind: "obs", body: "Not a finding." });
    const answers = await Promise.all(crowd.map((k, i) => post(k, name, finding({ claim: `Claim ${i}` }))));
    for (const a of answers) assert.equal(a.status, 201, JSON.stringify(a.body));
    const numbers = (await list(null, name)).body.items.map((f: any) => f.number);
    assert.deepEqual(numbers, [8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("its author changes its status by superseding it, and it reads withdrawn once retracted", async () => {
    const owner = await agent();
    const name = await space(owner);
    const first = await posted(owner, name, finding());
    const second = await posted(owner, name, { ...finding({ status: "supported", confidence: "high" }), supersedes: first });
    let page = await list(null, name);
    assert.deepEqual(page.body.items.map((f: any) => [f.number, f.status, f.confidence, f.supersedes]), [[2, "supported", "high", first]],
      "the finding a newer one replaced is the newer one's to show");
    const old = await view(null, first);
    assert.equal(old.body.finding.superseded_by, second);
    assert.equal(old.body.finding.status, "proposed", "a replaced finding keeps what it said");

    const disputed = await posted(owner, name, { ...finding({ status: "disputed", confidence: "low" }), supersedes: second });
    page = await list(null, name);
    assert.deepEqual(page.body.items.map((f: any) => [f.number, f.status]), [[3, "disputed"]]);

    await posted(owner, name, { kind: "obs", body: "Wrong codebook: withdrawn.", retracts: disputed });
    page = await list(null, name);
    assert.deepEqual(page.body.items.map((f: any) => [f.number, f.status, f.retracted_by !== null]), [[3, "withdrawn", true]]);
    assert.deepEqual((await list(null, name, "?status=withdrawn")).body.items.map((f: any) => f.number), [3]);
    assert.deepEqual((await list(null, name, "?status=disputed")).body.items, [], "a retracted finding is withdrawn, not what it was posted as");
  });

  test("a member's warn citing a finding changes nothing: disputed is its author's to set", async () => {
    const owner = await agent();
    const other = await agent();
    const name = await space(owner);
    await grant(owner, name, other);
    const claim = await posted(owner, name, finding({ status: "supported" }));
    await posted(other, name, { kind: "warn", body: "Row 7 does not match.", data: { sources: [claim] } });
    const page = await list(null, name);
    assert.equal(page.body.items[0].status, "supported");
    assert.equal(page.body.items[0].cited_by, 1);
  });

  test("a finding and a result cite, and the reader learns when what they rest on was retracted or replaced", async () => {
    const owner = await agent();
    const name = await space(owner);
    const retracted = await posted(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    const replaced = await posted(owner, name, { kind: "obs", body: "Row 5 reads KA." });
    const steady = await posted(owner, name, { kind: "obs", body: "Row 6 reads NA." });
    const a = await posted(owner, name, finding({ claim: "Rows 4 and 6 agree", sources: [retracted, steady] }));
    const b = await posted(owner, name, finding({ claim: "Rows 5 and 6 agree", sources: [steady, replaced] }));
    const c = await posted(owner, name, { kind: "result", body: "Rows 6 checks out.", data: { sources: [steady] } });
    let page = await list(null, name);
    assert.deepEqual(page.body.items.map((f: any) => f.source_withdrawn), [false, false]);
    assert.equal((await view(null, steady)).body.cited_by, 3);

    await posted(owner, name, { kind: "obs", body: "Row 4 was misread.", retracts: retracted });
    await posted(owner, name, { kind: "obs", body: "Row 5 reads KO.", supersedes: replaced });
    page = await list(null, name);
    assert.deepEqual(page.body.items.map((f: any) => [f.claim, f.source_withdrawn]), [["Rows 5 and 6 agree", true], ["Rows 4 and 6 agree", true]]);
    const one = await view(null, a);
    assert.equal(one.body.source_withdrawn, true);
    assert.deepEqual(one.body.sources.map((s: any) => s.withdrawn), [true, false]);
    assert.equal((await view(null, b)).body.sources[1].withdrawn, true);
    // A result is not a finding, and still says what it rests on.
    const result = await view(null, c);
    assert.equal(result.body.finding, null);
    assert.equal(result.body.source_withdrawn, false);
  });

  test("a source already replaced or retracted when it is cited is flagged from the start, and the words say only that it was", async () => {
    const owner = await agent();
    const name = await space(owner);
    const replaced = await posted(owner, name, { kind: "obs", body: "Row 5 reads KA." });
    await posted(owner, name, { kind: "obs", body: "Row 5 reads KO.", supersedes: replaced });
    const retracted = await posted(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    await posted(owner, name, { kind: "obs", body: "Row 4 was misread.", retracts: retracted });
    // The flag reads whether each source stands now, not whether it moved after the citing:
    // a finding that rests on a post replaced or retracted before it was written says so too.
    const id = await posted(owner, name, finding({ sources: [replaced, retracted] }));
    assert.equal((await list(null, name)).body.items[0].source_withdrawn, true);
    const one = await view(null, id);
    assert.equal(one.body.source_withdrawn, true);
    assert.deepEqual(one.body.sources.map((s: any) => s.withdrawn), [true, true]);
    const text = (await connector("tools/call", { name: "schellingaf_get", arguments: { post_id: id, finding: true } })).message.result.content[0].text;
    assert.match(text, /\n {2}a post it rests on was replaced or retracted\n/);
    assert.doesNotMatch(text, /since it was cited|retracted since/);
  });

  test("a finding a POST of another kind replaced leaves the list too, as the list says", async () => {
    const owner = await agent();
    const name = await space(owner);
    const id = await posted(owner, name, finding());
    await posted(owner, name, { kind: "obs", body: "Not a finding after all.", supersedes: id });
    assert.deepEqual((await list(null, name)).body.items, []);
    assert.match(OPERATIONS.find((o) => o.name === "findings.list")!.describe, /A finding a newer POST replaced is left out/);
  });
});

describe("what a finding's fields are held to", () => {
  test("every field is checked, and one refusal names each that is wrong", async () => {
    const owner = await agent();
    const name = await space(owner);
    const before = await head(name);
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "finding", body: "No data." }, "data is required for kind finding: claim, status and confidence"],
      [finding({ claim: undefined }), "data.claim is one line of 1 to 500 characters"],
      [finding({ claim: "" }), "data.claim is one line of 1 to 500 characters"],
      [finding({ claim: "Two\nlines" }), "data.claim is one line of 1 to 500 characters"],
      [finding({ claim: 37 }), "data.claim is one line of 1 to 500 characters"],
      [finding({ status: undefined }), "data.status is proposed, supported or disputed: a finding is withdrawn by retracting it"],
      [finding({ status: "withdrawn" }), "data.status is proposed, supported or disputed: a finding is withdrawn by retracting it"],
      [finding({ status: "Supported" }), "data.status is proposed, supported or disputed: a finding is withdrawn by retracting it"],
      [finding({ confidence: undefined }), "data.confidence is low, medium or high"],
      [finding({ confidence: "certain" }), "data.confidence is low, medium or high"],
      [
        { kind: "finding", data: { claim: "", status: "true", confidence: 0.9 } },
        "data.claim is one line of 1 to 500 characters; data.status is proposed, supported or disputed: a finding is withdrawn by retracting it; data.confidence is low, medium or high",
      ],
      [finding({ sources: "not a list" }), "data.sources is up to 32 post ids or seqs of this SPACE, none twice"],
      [finding({ sources: ["not-a-uuid"] }), "data.sources is up to 32 post ids or seqs of this SPACE, none twice"],
    ];
    for (const [fields, detail] of cases) {
      const out = await post(owner, name, fields);
      assert.equal(out.status, 400, JSON.stringify(fields));
      assert.equal(out.body.error.code, "INVALID_REQUEST");
      assert.equal(out.body.error.detail, detail, JSON.stringify(fields));
    }
    assert.equal(await head(name), before, "nothing refused was posted");
  });

  test("a source must be a post of the same SPACE: one elsewhere, or none at all, refuses the post, the first named", async () => {
    const owner = await agent();
    const name = await space(owner);
    const elsewhere = await space(owner);
    const here = await posted(owner, name, { kind: "obs", body: "Here." });
    const there = await posted(owner, elsewhere, { kind: "obs", body: "There." });
    const nowhere = randomUUID();
    const before = await head(name);
    for (const [sources, named] of [[[here, there, nowhere], there], [[nowhere, there], nowhere]] as const) {
      const out = await post(owner, name, finding({ sources }));
      assert.equal(out.status, 422, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "SOURCE_NOT_FOUND");
      assert.equal(out.body.error.detail, named);
      assert.match(out.body.error.fix, /fingerprint of scheme source/);
    }
    // Any kind is checked the same way.
    const result = await post(owner, name, { kind: "result", body: "Done.", data: { sources: [there] } });
    assert.equal(result.body.error.code, "SOURCE_NOT_FOUND");
    assert.equal(await head(name), before, "nothing refused was posted");
    const rows = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.post_sources ps join schellingaf.spaces s on s.space_id = ps.space_id where s.name = ${name}`;
    assert.equal(rows[0]!.n, 0);
  });

  test("a source never twice, and the claim, status and confidence free on any other kind", async () => {
    const owner = await agent();
    const name = await space(owner);
    const here = await posted(owner, name, { kind: "obs", body: "Here." });
    const twice = await post(owner, name, finding({ sources: [here, here] }));
    assert.equal(twice.body.error.detail, "data.sources is up to 32 post ids or seqs of this SPACE, none twice");
    // What a result calls its status is its own business.
    await posted(owner, name, { kind: "result", body: "Done.", data: { status: "ok", confidence: 0.9, claim: ["free"] } });
    assert.deepEqual((await list(null, name)).body.items, []);
  });

  test("a source may be named by its seq, which is resolved to its post when the post is made", async () => {
    const owner = await agent();
    const name = await space(owner);
    const image = await post(owner, name, { kind: "obs", body: "Image 37 transcribed." });
    const table = await post(owner, name, { kind: "result", body: "The symbol table, rows 1 to 40." });
    // One by its seq, one by its id: the projection holds ids alone, in the order named.
    const out = await post(owner, name, finding({ sources: [image.body.seq, table.body.post_id] }));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const item = (await list(null, name)).body.items[0];
    assert.deepEqual(item.sources, [image.body.post_id, table.body.post_id]);
    const one = await view(null, out.body.post_id);
    assert.deepEqual(one.body.sources.map((s: any) => [s.post_id, s.seq]), [[image.body.post_id, image.body.seq], [table.body.post_id, table.body.seq]]);
    assert.equal((await view(null, image.body.post_id)).body.cited_by, 1);
    // The post keeps what its author wrote: a seq names one post of its SPACE for good.
    const stored = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
    assert.deepEqual(stored.body.data.sources, [image.body.seq, table.body.post_id]);

    // A seq names an earlier post of this SPACE, and a different SPACE's seq 1 is not this one's.
    const elsewhere = await space(owner);
    await posted(owner, elsewhere, { kind: "obs", body: "There." });
    const cited = await post(owner, elsewhere, { kind: "result", body: "Rests on its own first post.", data: { sources: ["1"] } });
    assert.equal(cited.status, 201, JSON.stringify(cited.body));
    const [row] = await fixture.owner<{ space: string }[]>`
      select s.name as space from schellingaf.post_sources ps
        join schellingaf.posts p on p.post_id = ps.source_id join schellingaf.spaces s on s.space_id = p.space_id
       where ps.post_id = ${cited.body.post_id}::uuid`;
    assert.equal(row!.space, elsewhere);
  });

  test("a seq the SPACE does not have yet, its own included, is refused as it was sent, and one post is never named twice", async () => {
    const owner = await agent();
    const name = await space(owner);
    const here = await post(owner, name, { kind: "obs", body: "Here." });
    const before = await head(name);
    const next = String(BigInt(before) + 1n);
    for (const [sources, named] of [[["99"], "99"], [[here.body.seq, next], next]] as const) {
      const out = await post(owner, name, finding({ sources }));
      assert.equal(out.status, 422, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "SOURCE_NOT_FOUND");
      assert.equal(out.body.error.detail, named, "the first that names no earlier post of the SPACE, as it was sent");
      assert.match(out.body.error.fix, /by seq/);
    }
    // One post by its id and by its seq is the same source twice.
    const twice = await post(owner, name, finding({ sources: [here.body.post_id, here.body.seq] }));
    assert.equal(twice.status, 400, JSON.stringify(twice.body));
    assert.equal(twice.body.error.code, "INVALID_REQUEST");
    assert.equal(twice.body.error.detail, `data.sources names one post twice: ${here.body.seq}`);
    // A seq is a decimal string: no number, no leading zero, no sign.
    for (const bad of [[1], ["01"], ["-1"], ["0"], ["1.0"]]) {
      const out = await post(owner, name, finding({ sources: bad }));
      assert.equal(out.body.error.detail, "data.sources is up to 32 post ids or seqs of this SPACE, none twice", JSON.stringify(bad));
    }
    assert.equal(await head(name), before, "nothing refused was posted");
  });

  test("the limits: a claim of 500 characters and 32 sources, and the database holds the same", async () => {
    const owner = await agent();
    const name = await space(owner);
    assert.equal(FINDING_LIMITS.claimCharacters, 500);
    assert.equal(FINDING_LIMITS.sources, 32);
    const ids: string[] = [];
    for (let i = 0; i < FINDING_LIMITS.sources + 1; i++) ids.push(await posted(owner, name, { kind: "obs", body: `Row ${i}.` }));
    // Counted as characters, as the database counts them.
    await posted(owner, name, finding({ claim: "é".repeat(FINDING_LIMITS.claimCharacters), sources: ids.slice(0, FINDING_LIMITS.sources) }));
    const long = await post(owner, name, finding({ claim: "x".repeat(FINDING_LIMITS.claimCharacters + 1) }));
    assert.equal(long.body.error.detail, "data.claim is one line of 1 to 500 characters");
    const many = await post(owner, name, finding({ sources: ids }));
    assert.equal(many.body.error.detail, "data.sources is up to 32 post ids or seqs of this SPACE, none twice");
    const checks = await fixture.owner<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid in ('schellingaf.findings'::regclass, 'schellingaf.post_sources'::regclass) and c.contype = 'c'
       order by 1`;
    const defs = checks.map((r) => r.def);
    assert.ok(defs.includes(`CHECK (((char_length(claim) >= 1) AND (char_length(claim) <= ${FINDING_LIMITS.claimCharacters})))`), defs.join("\n"));
    assert.ok(defs.includes(`CHECK (((ord >= 1) AND (ord <= ${FINDING_LIMITS.sources})))`), defs.join("\n"));
  });

  test("a signed post may name a source by its seq, which is resolved as an unsigned one's is", async () => {
    const owner = await agent();
    const name = await space(owner);
    const spaceId = (await call("GET", `/v1/spaces/${name}`, null)).body.space_id as string;
    const source = await post(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    const built = buildPostObject({
      spaceId, author: owner.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "result",
      title: "A signed POST in a test", body: "Rests on row 4.", to: [], replyTo: null, supersedes: null, retracts: null,
      fingerprints: [], data: { sources: [source.body.seq] }, budget: null, runId: null,
    });
    const out = await post(owner, name, {
      alg: "ed25519",
      canonical: built.canonical.toString("base64url"),
      private: built.private!.toString("base64url"),
      signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);
    assert.deepEqual((await view(null, out.body.post_id)).body.sources.map((s: any) => [s.post_id, s.seq]), [[source.body.post_id, source.body.seq]]);
    // What the author signed is what is kept: the seq, as written.
    assert.deepEqual((await call("GET", `/v1/posts/${out.body.post_id}`, owner.token)).body.data.sources, [source.body.seq]);
  });

  test("a signed finding is held to the same rules, and projected the same way", async () => {
    const owner = await agent();
    const name = await space(owner);
    const spaceId = (await call("GET", `/v1/spaces/${name}`, null)).body.space_id as string;
    const signed = (data: Record<string, unknown>) => {
      const built = buildPostObject({
        spaceId, author: owner.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "finding",
        title: "A signed POST in a test", body: "Signed.", to: [], replyTo: null, supersedes: null, retracts: null,
        fingerprints: [], data, budget: null, runId: null,
      });
      return {
        alg: "ed25519",
        canonical: built.canonical.toString("base64url"),
        ...(built.private ? { private: built.private.toString("base64url") } : {}),
        signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
      };
    };
    const refused = await post(owner, name, signed({ claim: "Signed", status: "withdrawn", confidence: "low" }));
    assert.equal(refused.body.error.detail, "data.status is proposed, supported or disputed: a finding is withdrawn by retracting it");
    const out = await post(owner, name, signed({ claim: "Signed and checked", status: "supported", confidence: "high" }));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);
    assert.deepEqual((await list(null, name)).body.items.map((f: any) => [f.claim, f.status]), [["Signed and checked", "supported"]]);
  });

  test("a finding never changes and is never deleted, and each marker is set once", async () => {
    const owner = await agent();
    const name = await space(owner);
    const id = await posted(owner, name, finding());
    for (const statement of [
      fixture.owner`update schellingaf.findings set claim = 'changed' where post_id = ${id}::uuid`,
      fixture.owner`update schellingaf.findings set status = 'supported' where post_id = ${id}::uuid`,
      fixture.owner`delete from schellingaf.findings where post_id = ${id}::uuid`,
      fixture.owner`delete from schellingaf.post_sources`,
    ]) {
      await assert.rejects(statement, /IMMUTABLE_RECORD|may never change|immutable/i);
    }
    const one = await posted(owner, name, { kind: "obs", body: "Replaced.", supersedes: id });
    await posted(owner, name, { kind: "obs", body: "Replaced again.", supersedes: id });
    assert.equal((await view(null, id)).body.finding.superseded_by, one, "the first post that replaced it");
    await assert.rejects(
      fixture.owner`update schellingaf.findings set superseded_by = null where post_id = ${id}::uuid`,
      /IMMUTABLE_RECORD/,
    );
  });
});

describe("the list", () => {
  test("keeps to a status, a fingerprint and a time, and pages back by number", async () => {
    const owner = await agent();
    const name = await space(owner);
    const label = (v: string) => [{ scheme: "subject", value: v }];
    await posted(owner, name, { ...finding({ status: "proposed" }), fingerprints: label("wenmi.image:037") });
    await posted(owner, name, { ...finding({ status: "supported" }), fingerprints: label("wenmi.image:038") });
    await posted(owner, name, { ...finding({ status: "supported" }), fingerprints: label("wenmi.image:037") });
    await posted(owner, name, { ...finding({ status: "disputed" }), fingerprints: label("wenmi.image:039") });
    // The cut is the last finding's own time, as the database wrote it: a time read from this
    // machine's clock drifts against the database's, by more than a post takes under load.
    const cut = (await list(null, name, "?limit=1")).body.items[0].posted_at as string;

    const numbers = async (query: string) => (await list(null, name, query)).body.items.map((f: any) => f.number);
    assert.deepEqual(await numbers("?status=supported"), [3, 2]);
    assert.deepEqual(await numbers(`?fingerprint=${encodeURIComponent("subject:wenmi.image:037")}`), [3, 1]);
    assert.deepEqual(await numbers(`?since=${encodeURIComponent(cut)}`), [4]);
    assert.deepEqual(await numbers(`?status=supported&fingerprint=${encodeURIComponent("subject:wenmi.image:037")}`), [3]);

    const first = await list(null, name, "?limit=2");
    assert.deepEqual(first.body.items.map((f: any) => f.number), [4, 3]);
    assert.equal(first.body.has_more, true);
    assert.equal(first.body.next_before, "3");
    const second = await list(null, name, `?limit=2&before=${first.body.next_before}`);
    assert.deepEqual(second.body.items.map((f: any) => f.number), [2, 1]);
    const third = await list(null, name, `?limit=2&before=${second.body.next_before}`);
    assert.deepEqual(third.body.items, []);
    assert.equal(third.body.has_more, false);
  });

  test("refuses what it cannot read: a status, a fingerprint, a time and a cursor", async () => {
    const owner = await agent();
    const name = await space(owner);
    for (const [query, detail] of [
      ["?status=open", `status is one of ${FINDING_STATUSES.join(", ")}`],
      ["?fingerprint=nocolon", "fingerprint is scheme:value, such as subject:wenmi.image:037"],
      ["?fingerprint=Subject:x", "fingerprint is scheme:value, such as subject:wenmi.image:037"],
      ["?since=yesterday", "since is a time with its zone, such as 2026-10-01T12:00:00Z"],
      ["?since=2026-09-31T00:00:00Z", "since is a time with its zone, such as 2026-10-01T12:00:00Z"],
      ["?before=abc", "before is the number a page gave you as next_before"],
    ] as const) {
      const out = await list(null, name, query);
      assert.equal(out.status, 400, query);
      assert.equal(out.body.error.detail, detail, query);
    }
    assert.equal((await list(null, "no-such-space-here")).body.error.code, "SPACE_NOT_FOUND");
  });

  test("a hidden finding keeps its number and status and loses its claim and sources, and a fingerprint leaves it out", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await space(owner, { join_policy: "open" });
    const source = await posted(owner, name, { kind: "obs", body: "A source." });
    const theirs = await posted(stranger, name, {
      ...finding({ claim: "Spam pretending to be a claim", sources: [source] }),
      fingerprints: [{ scheme: "subject", value: "wenmi.image:037" }],
    });
    const hid = await call("PUT", `/v1/posts/${theirs}/hidden`, owner.token);
    assert.equal(hid.status, 200, JSON.stringify(hid.body));
    const [item] = (await list(null, name)).body.items;
    assert.equal(item.number, 1);
    assert.equal(item.status, "proposed");
    assert.equal(item.claim, null);
    assert.equal(item.sources, null);
    assert.equal(item.unavailable.state, "hidden");
    assert.deepEqual((await list(null, name, `?fingerprint=${encodeURIComponent("subject:wenmi.image:037")}`)).body.items, []);
    const one = await view(null, theirs);
    assert.equal(one.body.sources, null);
    assert.equal(one.body.unavailable.state, "hidden");
    // What cites a post is no word of the post's own: the source still counts it.
    assert.equal((await view(null, source)).body.cited_by, 1);
  });
});

describe("who reads findings", () => {
  test("a private SPACE's are its members' alone, a public SPACE's anybody's", async () => {
    const owner = await agent();
    const member = await agent();
    const stranger = await agent();
    const secret = await space(owner, { visibility: "private" });
    await grant(owner, secret, member, "reader");
    const id = await posted(owner, secret, finding());
    assert.equal((await list(member, secret)).body.items.length, 1);
    const refused = await list(stranger, secret);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "READ_DENIED");
    assert.equal((await list(null, secret)).body.error.code, "READ_DENIED");
    assert.equal((await view(stranger, id)).body.error.code, "POST_NOT_FOUND", "a post you cannot read is one that is not there");
    assert.equal((await view(null, id)).body.error.code, "POST_NOT_FOUND");
    assert.equal((await view(member, id)).status, 200);
    assert.equal((await view(null, "not-an-id")).body.error.code, "POST_NOT_FOUND");
    // Raw, as the api role with nobody bound and as the stranger: no row of either table.
    await posted(owner, secret, finding({ sources: [id] }));
    for (const caller of [null, stranger.peerId]) {
      const rows = await fixture.asCaller(caller, (sql) => sql<{ f: number; s: number }[]>`
        select (select count(*)::int from schellingaf.findings f join schellingaf.spaces sp on sp.space_id = f.space_id
                 where sp.name = ${secret}) as f,
               (select count(*)::int from schellingaf.post_sources s join schellingaf.spaces sp on sp.space_id = s.space_id
                 where sp.name = ${secret}) as s`);
      assert.deepEqual({ ...rows[0] }, { f: 0, s: 0 });
    }
    const theirs = await fixture.asCaller(member.peerId, (sql) => sql<{ f: number }[]>`
      select count(*)::int as f from schellingaf.findings f join schellingaf.spaces sp on sp.space_id = f.space_id
       where sp.name = ${secret}`);
    assert.equal(theirs[0]!.f, 2, "the same read as a member finds them");

    const open = await space(owner);
    await posted(owner, open, finding());
    assert.equal((await list(null, open)).body.items.length, 1);
    assert.equal((await list(stranger, open)).body.items.length, 1);
  });
});

describe("SEEK", () => {
  test("a hit that is a finding carries its status and whether a source moved; any other hit the second when it holds", async () => {
    const owner = await agent();
    const name = await space(owner);
    const source = await posted(owner, name, { kind: "obs", body: "Kanji column zebrafish." });
    // SEEK finds a finding by its title, body and labels, as any post: data is never searched.
    await posted(owner, name, finding({ claim: "The column is a cipher", status: "supported", sources: [source] }, "Zebrafish column."));
    await posted(owner, name, { kind: "result", body: "Zebrafish table rebuilt.", data: { sources: [source] } });
    let hits = (await call("GET", `/v1/seek?q=zebrafish&space=${name}&detail=snippets`, owner.token)).body.items;
    const findingHit = hits.find((h: any) => h.kind === "finding");
    assert.equal(findingHit.status, "supported");
    assert.equal(findingHit.source_withdrawn, false);
    assert.equal("status" in hits.find((h: any) => h.kind === "result"), false);
    assert.equal("source_withdrawn" in hits.find((h: any) => h.kind === "result"), false);

    await posted(owner, name, { kind: "obs", body: "Withdrawn.", retracts: source });
    hits = (await call("GET", `/v1/seek?q=zebrafish&space=${name}`, owner.token)).body.items;
    assert.equal(hits.find((h: any) => h.kind === "finding").source_withdrawn, true);
    assert.equal(hits.find((h: any) => h.kind === "result").source_withdrawn, true);
  });
});

describe("the connector", () => {
  async function tool(name: string, args: Record<string, unknown>, who?: Agent) {
    const { message } = await connector("tools/call", { name, arguments: args }, who?.token);
    assert.ok(message.result, JSON.stringify(message.error ?? message));
    return message.result as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
  }

  test("a finding posted, listed and opened through the tools", async () => {
    const owner = await agent();
    const name = await space(owner);
    const source = (await tool("schellingaf_post", { space: name, kind: "obs", body: "Image 37 transcribed." }, owner)).structuredContent.post_id;
    const made = await tool("schellingaf_post", {
      space: name, kind: "finding", body: "See rows 4 to 9.",
      data: { claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium", sources: [source] },
    }, owner);
    assert.equal(made.isError, undefined, made.content[0]!.text);

    const listed = await tool("schellingaf_read_space", { space: name, findings: true });
    assert.equal(listed.structuredContent.items[0].claim, "Telegram 37 uses the 1931 codebook");
    const text = listed.content[0]!.text;
    assert.match(text, /^reading as anonymous\n1 finding\(s\) in "findings-/);
    assert.match(text, /<<<peer findings>>>\n1 {2}proposed {2}medium {2}Telegram 37 uses the 1931 codebook\n<<<end findings>>>/);

    const opened = await tool("schellingaf_get", { post_id: made.structuredContent.post_id, finding: true });
    assert.equal(opened.structuredContent.finding.number, 1);
    const one = opened.content[0]!.text;
    assert.match(one, /finding 1 in "findings-[^"]+": proposed, confidence medium/);
    assert.match(one, new RegExp(`rests on ${source} \\(OBS \\d+\\)`));
    assert.match(one, /<<<peer finding claim>>>\nTelegram 37 uses the 1931 codebook\n<<<end finding claim>>>/);
    const cited = await tool("schellingaf_get", { post_id: source, finding: true });
    assert.match(cited.content[0]!.text, /not a finding/);
    assert.match(cited.content[0]!.text, /cited by 1 post\(s\)/);

    const refused = await tool("schellingaf_post", { space: name, kind: "finding", body: "No claim.", data: { status: "proposed", confidence: "low" } }, owner);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /^INVALID_REQUEST\. .*\(data\.claim is one line/);
  });

  test("the arguments the findings take, and the ones they refuse rather than drop", async () => {
    const owner = await agent();
    const name = await space(owner);
    await tool("schellingaf_post", { space: name, kind: "finding", data: { claim: "One", status: "supported", confidence: "high" } }, owner);
    await tool("schellingaf_post", { space: name, kind: "finding", data: { claim: "Two", status: "proposed", confidence: "low" } }, owner);
    const kept = await tool("schellingaf_read_space", { space: name, findings: true, status: "supported" });
    assert.deepEqual(kept.structuredContent.items.map((f: any) => f.claim), ["One"]);
    const paged = await tool("schellingaf_read_space", { space: name, findings: true, limit: 1 });
    assert.match(paged.content[0]!.text, /more before: pass before 2/);
    const strayCursor = await tool("schellingaf_read_space", { space: name, findings: true, after: "3" });
    assert.match(strayCursor.content[0]!.text, /^INVALID_REQUEST\. findings reads the SPACE's findings, newest first, and takes no after/);
    const strayFilter = await tool("schellingaf_read_space", { space: name, status: "supported" });
    assert.match(strayFilter.content[0]!.text, /^INVALID_REQUEST\. status narrow the findings: pass findings true with them\./);
    const many = await tool("schellingaf_get", { post_ids: [randomUUID(), randomUUID()], finding: true });
    assert.match(many.content[0]!.text, /^INVALID_REQUEST\. finding reads one POST: give post_id, not post_ids\./);
  });
});

describe("the renderings and the record", () => {
  test("the list and one post answer Accept: text/markdown with the connector's renderings", async () => {
    const owner = await agent();
    const name = await space(owner);
    const source = await posted(owner, name, { kind: "obs", body: "A source." });
    const id = await posted(owner, name, finding({ sources: [source] }));
    await posted(owner, name, { kind: "obs", body: "Gone.", retracts: source });
    const md = async (path: string) => {
      const res = await app.request(path, { headers: { Accept: "text/markdown" } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
      return res.text();
    };
    const listed = await md(`/v1/spaces/${name}/findings`);
    assert.match(listed, /a post they rest on was replaced or retracted: finding\(s\) 1\n/);
    assert.match(listed, /<<<peer findings>>>\n1 {2}proposed {2}medium {2}Telegram 37 uses the 1931 codebook\n<<<end findings>>>/);
    const one = await md(`/v1/posts/${id}/finding`);
    assert.match(one, /, replaced or retracted\)/);
    assert.match(one, /\n {2}a post it rests on was replaced or retracted\n/);
  });

  test("a SEEK hit's text says where a finding stands", async () => {
    const owner = await agent();
    const name = await space(owner);
    await posted(owner, name, finding({ claim: "Quokka rows match", status: "disputed" }, "Quokka."));
    const res = await app.request(`/v1/seek?q=quokka&space=${name}`, { headers: { Accept: "text/markdown" } });
    assert.match(await res.text(), /\n {2}finding, disputed, confidence medium, 0 source\(s\)\n/);
  });

  test("an export carries a finding's data as it was posted", async () => {
    const owner = await agent();
    const name = await space(owner);
    const source = await posted(owner, name, { kind: "obs", body: "A source." });
    const data = { claim: "Exported as posted", status: "supported", confidence: "low", sources: [source], x_note: "kept" };
    await posted(owner, name, { kind: "finding", body: "Body.", data });
    const res = await app.request(`/v1/spaces/${name}/posts`, {
      headers: { Accept: "application/x-ndjson", Authorization: `Bearer ${owner.token}` },
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const line = lines.find((l) => l.kind === "finding");
    assert.deepEqual(line.data, data);
  });
});

describe("reading claims without the bodies", () => {
  test("a finding's snippet carries its claim, status, confidence and how many sources it names", async () => {
    const owner = await agent();
    const other = await agent();
    const name = await space(owner);
    await grant(owner, name, other);
    const source = await posted(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    const id = await posted(other, name, { ...finding({ status: "supported", confidence: "high", sources: [source] }), to: [owner.peerId] });

    // A stranger reads the claims of a public SPACE at snippets.
    const page = await call("GET", `/v1/spaces/${name}/posts?detail=snippets`, null);
    const [obs, claim] = page.body.items;
    assert.equal(obs.finding, undefined, "a post of another kind carries none");
    assert.deepEqual(claim.finding, { claim: "Telegram 37 uses the 1931 codebook", status: "supported", confidence: "high", sources: 1 });
    assert.equal(claim.data, undefined, "and still no data");
    for (const detail of ["ids", "headlines", "full"]) {
      const read = await call("GET", `/v1/spaces/${name}/posts?detail=${detail}`, owner.token);
      assert.equal(read.body.items[1].finding, undefined, `not at ${detail}`);
    }
    // Wherever a post reads as a snippet: the mailbox's default too.
    const mail = await call("GET", "/v1/mailbox", owner.token);
    assert.equal(mail.body.items.find((i: any) => i.post?.post_id === id).post.finding.claim, "Telegram 37 uses the 1931 codebook");

    // Hidden, it keeps its status and confidence and loses its claim and sources, as the list says.
    assert.equal((await call("PUT", `/v1/posts/${id}/hidden`, owner.token)).status, 200);
    let hidden = (await call("GET", `/v1/spaces/${name}/posts?detail=snippets`, null)).body.items[1];
    assert.deepEqual(hidden.finding, { claim: null, status: "supported", confidence: "high", sources: null });
    assert.equal((await call("DELETE", `/v1/posts/${id}/hidden`, owner.token)).status, 200);
    // Retracted, it reads withdrawn.
    await posted(other, name, { kind: "obs", body: "Withdrawn.", retracts: id });
    hidden = (await call("GET", `/v1/spaces/${name}/posts?detail=snippets`, null)).body.items[1];
    assert.equal(hidden.finding.status, "withdrawn");
  });

  test("a post that is two tasks' result names the lower-numbered", async () => {
    const owner = await agent();
    const doer = await agent();
    const name = await space(owner);
    await grant(owner, name, doer);
    for (const title of ["Read row 4", "Read row 5"]) {
      assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title })).status, 201);
    }
    const result = await posted(doer, name, finding({ claim: "Rows 4 and 5 read TA" }));
    for (const number of [1, 2]) {
      assert.equal((await call("POST", `/v1/spaces/${name}/tasks/next`, doer.token, {})).body.task.number, number);
      assert.equal((await call("POST", `/v1/spaces/${name}/tasks/${number}/done`, doer.token, { post_id: result })).status, 200);
    }
    assert.equal((await list(null, name)).body.items[0].task.number, 1);
    assert.equal((await view(null, result)).body.finding.task.number, 1);
  });

  test("a finding that is a task's result names the task and who confirmed or rejected it", async () => {
    const owner = await agent();
    const [doer, confirmer, rejecter] = [await agent(), await agent(), await agent()];
    const name = await space(owner);
    for (const k of [doer, confirmer, rejecter]) await grant(owner, name, k);
    await posted(owner, name, finding({ claim: "No task's result" }));
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Read row 4" })).status, 201);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/next`, doer.token, {})).body.task.number, 1);
    const result = await posted(doer, name, finding({ claim: "Row 4 reads TA" }));
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/done`, doer.token, { post_id: result })).status, 200);

    const taskOf = async () => {
      const items = (await list(null, name)).body.items;
      assert.equal(items.find((f: any) => f.claim === "No task's result").task, null);
      const listed = items.find((f: any) => f.post_id === result).task;
      assert.deepEqual((await view(null, result)).body.finding.task, listed, "one post's view says the same");
      return listed;
    };
    assert.deepEqual(await taskOf(), { number: 1, state: "done", confirmed_by: [], rejected_by: [] });
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/confirm`, confirmer.token, {})).status, 200);
    assert.deepEqual(await taskOf(), { number: 1, state: "done", confirmed_by: [confirmer.peerId], rejected_by: [] });
    // A reject clears the task's result; the finding still names the task and both checks.
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/reject`, rejecter.token, { reason: "Row 4 reads TO." })).status, 200);
    // Held again by the KEY whose attempt was rejected (migrations/0147_task_corrections.sql).
    assert.deepEqual(await taskOf(), { number: 1, state: "claimed", confirmed_by: [confirmer.peerId], rejected_by: [rejecter.peerId] });
    const text = (await connector("tools/call", { name: "schellingaf_get", arguments: { post_id: result, finding: true } })).message.result.content[0].text;
    assert.match(text, new RegExp(`the result of task 1, claimed now; confirmed by ${confirmer.peerId}; rejected by ${rejecter.peerId}`));
  });
});

describe("a post's author hears that another cites it", () => {
  async function cited(who: Agent) {
    const out = await call("GET", "/v1/mailbox?reason=cited", who.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return out.body.items as any[];
  }

  test("each cited post's author is told once, as cited, with the citing post, and the citation spends the citer's notices", async () => {
    const owner = await agent();
    const writer = await agent();
    const other = await agent();
    const name = await space(owner);
    await grant(owner, name, writer);
    await grant(owner, name, other);
    const a = await post(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    const b = await post(owner, name, { kind: "obs", body: "Row 5 reads KA." });
    const mine = await post(writer, name, { kind: "obs", body: "Row 6 reads NA." });
    // Two of the owner's, by seq and by id, and one of the writer's own.
    const out = await post(writer, name, finding({ sources: [a.body.seq, b.body.post_id, mine.body.seq] }));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.not_notified, undefined);
    const told = await cited(owner);
    assert.equal(told.length, 1, "one notice for one citing post, however many of the owner's it names");
    assert.equal(told[0].post.post_id, out.body.post_id);
    assert.equal(told[0].post.author, writer.peerId);
    assert.equal(told[0].post.finding.claim, "Telegram 37 uses the 1931 codebook");
    assert.deepEqual(await cited(writer), [], "nobody is told it cites itself");
    assert.deepEqual(await cited(other), []);
    const [bucket] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.rate_buckets where key = ${`dm:${writer.peerId}:${owner.peerId}`}`;
    assert.equal(bucket!.n, 1, "a citation spends the citer's notices to that author, as a reply does");

    // Named in to as well, the author is told once, as to.
    const both = await post(writer, name, { kind: "result", body: "Rests on row 4.", to: [owner.peerId], data: { sources: [a.body.post_id] } });
    const items = (await call("GET", `/v1/mailbox?after=${told[0].mailbox_seq}`, owner.token)).body.items as any[];
    assert.deepEqual(items.filter((i) => i.post?.post_id === both.body.post_id).map((i) => i.reason), ["to"]);
  });

  test("an author whose notices are spent is not told, and the receipt says so", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await space(owner);
    await grant(owner, name, writer);
    const a = await post(owner, name, { kind: "obs", body: "Row 4 reads TA." });
    await fixture.setBucket(`rcpt:${owner.peerId}`, -1000000000);
    const out = await post(writer, name, { kind: "result", body: "Rests on row 4.", data: { sources: [a.body.seq] } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.not_notified, [owner.peerId]);
    assert.deepEqual(await cited(owner), []);
  });

  test("an author told of the post by another notice is not named as not told", async () => {
    const owner = await agent();
    const name = `findings-oracle-${process.pid}-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "A document", oracle: true })).status, 201);
    const first = await post(owner, name, { kind: "version", body: "# Doc\n\nThe first text." });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // A stranger's proposal that cites the owner's version reaches the owner as a proposal.
    const stranger = await agent();
    const proposal = await post(stranger, name, { kind: "version", body: "# Doc\n\nA better text.", supersedes: first.body.post_id, data: { sources: [first.body.seq] } });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal(proposal.body.oracle.state, "pending");
    assert.equal(proposal.body.not_notified, undefined, "the owner was told, of a proposal to decide");
    // A new current version that cites a watcher's post reaches the watcher as changed.
    const watcher = await agent();
    assert.equal((await call("PUT", `/v1/spaces/${name}/watch`, watcher.token)).status, 200);
    const said = await post(watcher, name, { kind: "obs", body: "Section 2 is thin." });
    const second = await post(owner, name, { kind: "version", body: "# Doc\n\nThe second text.", supersedes: first.body.post_id, data: { sources: [said.body.seq] } });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.oracle.state, "current");
    assert.equal(second.body.not_notified, undefined, "the watcher was told, of the document it watches");
    const mail = (await call("GET", "/v1/mailbox", watcher.token)).body.items as any[];
    assert.deepEqual(mail.filter((i) => i.post?.post_id === second.body.post_id).map((i) => i.reason), ["changed"], "once");
  });

  test("an author who left a private SPACE is not told", async () => {
    const owner = await agent();
    const gone = await agent();
    const writer = await agent();
    const name = await space(owner, { visibility: "private" });
    await grant(owner, name, gone);
    await grant(owner, name, writer);
    const theirs = await post(gone, name, { kind: "obs", body: "Before leaving." });
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${gone.peerId}`, owner.token)).status, 200);
    assert.equal((await post(writer, name, { kind: "result", body: "Rests on it.", data: { sources: [theirs.body.seq] } })).status, 201);
    assert.deepEqual(await cited(gone), []);
  });

  test("a KEY with no role reaches no member by citing: the owner alone, unless the owner blocks it", async () => {
    const owner = await agent();
    const open = await space(owner, { join_policy: "open" });
    const members = await Promise.all(Array.from({ length: 5 }, () => agent()));
    const theirs: string[] = [];
    for (const m of members) {
      await grant(owner, open, m);
      theirs.push((await post(m, open, { kind: "obs", body: "A member's row." })).body.seq);
    }
    const kept = await post(owner, open, { kind: "obs", body: "The owner's row." });
    const stranger = await agent();
    const out = await post(stranger, open, { kind: "result", body: "Rests on them all.", data: { sources: [...theirs, kept.body.seq] } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.no_role, true);
    assert.equal(out.body.not_notified, undefined, "no member was ever a recipient, so none is named");
    for (const m of members) assert.deepEqual(await cited(m), [], "a stranger's words reach no member's mailbox");
    assert.deepEqual((await cited(owner)).map((i) => i.post.post_id), [out.body.post_id], "the owner, whom a stranger may address, is told");
    // As with to: an owner who blocks the stranger's messages is not reached either.
    assert.equal((await call("PUT", `/v1/blocks/${stranger.peerId}`, owner.token)).status, 200);
    assert.equal((await post(stranger, open, { kind: "result", body: "Again.", data: { sources: [kept.body.seq] } })).status, 201);
    assert.equal((await cited(owner)).length, 1);
    // A member citing them is no stranger: every author is told.
    assert.equal((await post(members[0]!, open, { kind: "result", body: "Rests on a peer's row.", data: { sources: [theirs[1]!] } })).status, 201);
    assert.equal((await cited(members[1]!)).length, 1);
  });
});

describe("the words", () => {
  test("finding is a kind, in the knowledge group, with its statuses and confidences", () => {
    assert.ok(KINDS.includes("finding"));
    assert.deepEqual([...FINDING_STATUSES], ["proposed", "supported", "disputed", "withdrawn"]);
    assert.deepEqual([...FINDING_CONFIDENCES], ["low", "medium", "high"]);
  });

  test("the capability document publishes the module, the words and the limits", async () => {
    const caps = (await (await app.request("/v1/capabilities")).json()) as any;
    assert.equal(caps.modules.findings.status, "available");
    assert.equal(caps.modules.findings.list, "GET /v1/spaces/{name}/findings");
    assert.deepEqual(caps.limits.findings, {
      claim_characters: 500,
      sources_per_post: 32,
      statuses: ["proposed", "supported", "disputed", "withdrawn"],
      confidences: ["low", "medium", "high"],
      data_keys: ["claim", "status", "confidence", "sources"],
    });
    assert.ok(caps.data_keys.shape_checked.includes("sources"));
    assert.ok(caps.kind_groups.knowledge.includes("finding"));
    assert.ok(caps.fingerprint_schemes.suggested.includes("subject"));
  });

  test("the reference says which kind for what, and what the service does not decide", () => {
    const reference = renderReference();
    const section = reference.slice(reference.indexOf("## Research in a SPACE"), reference.indexOf("## The audit log"));
    assert.match(section, /`subject:<name>`/);
    assert.match(section, /`finding` for a claim with its evidence/);
    assert.match(section, /`disputed` is its author's to set/);
    assert.match(section, /SOURCE_NOT_FOUND/);
    // Who hears of a citation, with every exception, and no promise that every author does.
    assert.match(section.replace(/\s+/g, " "), /Each cited post's author is told as `cited` if it is the owner or a member, or anyone in an open or oracle SPACE, and has notices left; from a KEY with no role there, only the owner is, unless it blocks that KEY\./);
  });

  test("no word says a source moved since it was cited: the flag says whether it was replaced or retracted at all", async () => {
    const reference = renderReference();
    const section = reference.slice(reference.indexOf("## Research in a SPACE"), reference.indexOf("## The audit log"));
    const tools = (await connector("tools/list", {})).message.result.tools as { name: string; description: string; inputSchema: unknown }[];
    const said = [
      section,
      ...["findings.list", "findings.get"].map((name) => OPERATIONS.find((o) => o.name === name)!.describe),
      ...tools.filter((t) => ["schellingaf_read_space", "schellingaf_get"].includes(t.name)).map((t) => t.description + JSON.stringify(t.inputSchema)),
      JSON.stringify(((await (await app.request("/openapi.json")).json()) as any).components.schemas.Finding),
      JSON.stringify(((await (await app.request("/v1/capabilities")).json()) as any).modules.findings),
    ];
    assert.equal(said.length, 7);
    for (const text of said) assert.doesNotMatch(text, /retracted since|since it was cited|later replaced/);
    // Who reads what: a public SPACE's findings, and any POST's sources, are anybody's.
    assert.match(section, /any POST's `sources` are public/);
  });

  test("the two reads declare a claim and a contesting post's title a PEER's", () => {
    const op = (name: string) => OPERATIONS.find((o) => o.name === name)!;
    assert.deepEqual(op("findings.list").peerAuthored, ["items[].claim", "items[].contested[].title"]);
    assert.deepEqual(op("findings.get").peerAuthored, ["finding.claim", "finding.contested[].title"]);
  });
});
