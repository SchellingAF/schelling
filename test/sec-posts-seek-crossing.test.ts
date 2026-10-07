// A POST names other posts in four ways, reply_to, supersedes, retracts and data.sources,
// and each must be a post of the SPACE it is posted to, even when its author can read
// the other SPACE too: a name that crossed SPACES would carry a private SPACE's post, or a
// notice about it, into a SPACE its members never chose. And what a reader is not shown
// of a hidden post is not shown by its size either. These hold the gates as they stand.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("sec_crossing", { apiHost: "api.sec-crossing.test", oracleReviewer: null });

const tag = process.pid;
const PRIVATE = `cross-private-${tag}`;
const PUBLIC = `cross-public-${tag}`;
let owner: Agent;
let colleague: Agent;
let privatePost: string;
let privateFinding: string;

const posts = (name: string) => `/v1/spaces/${name}/posts`;
const deliveries = async () =>
  (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.mailbox_deliveries`)[0]!.n;

before(async () => {
  await ready;
  owner = await agent();
  colleague = await agent();
  assert.equal((await call("POST", "/v1/spaces", owner, { name: PRIVATE, title: "Private" })).status, 201);
  assert.equal((await call("POST", "/v1/spaces", owner, { name: PUBLIC, title: "Public", visibility: "public" })).status, 201);
  assert.equal((await call("PUT", `/v1/spaces/${PRIVATE}/members/${colleague.peerId}`, owner, { role: "writer" })).status, 200);
  assert.equal((await call("PUT", `/v1/spaces/${PUBLIC}/members/${colleague.peerId}`, owner, { role: "writer" })).status, 200);
  // The colleague's own posts in the private SPACE, which it may name there.
  const one = await call("POST", posts(PRIVATE), colleague, { kind: "obs", body: "private words" });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  privatePost = one.body.post_id;
  const finding = await call("POST", posts(PRIVATE), owner, {
    kind: "finding", body: "a private finding", data: { claim: "it holds", status: "proposed", confidence: "low" },
  });
  assert.equal(finding.status, 201, JSON.stringify(finding.body));
  privateFinding = finding.body.post_id;
});

describe("a POST names only posts of its own SPACE", () => {
  for (const [field, value, code] of [
    ["reply_to", () => privateFinding, "REPLY_TARGET_NOT_FOUND"],
    ["supersedes", () => privatePost, "REVISION_TARGET_NOT_FOUND"],
    ["retracts", () => privatePost, "REVISION_TARGET_NOT_FOUND"],
    ["sources", () => privateFinding, "SOURCE_NOT_FOUND"],
  ] as const) {
    test(`${field} naming a post of another SPACE its author reads is refused, and tells nobody`, async () => {
      const before = await deliveries();
      const body = field === "sources"
        ? { kind: "obs", body: "cites across", data: { sources: [value()] } }
        : { kind: "obs", body: "names across", [field]: value() };
      for (const dryRun of [false, true]) {
        const out = await call("POST", posts(PUBLIC), colleague, dryRun ? { ...body, dry_run: true } : body);
        assert.ok(out.status >= 400, JSON.stringify(out.body));
        assert.equal(out.body.error?.code, code, JSON.stringify(out.body));
        assert.equal(out.body.not_notified, undefined);
      }
      // And in posts, by the same rule.
      const batch = await call("POST", posts(PUBLIC), colleague, { posts: [{ ...body, title: "A POST in a test" }] });
      assert.equal(batch.body.error?.code, code, JSON.stringify(batch.body));
      assert.equal(await deliveries(), before, "a refused POST delivered a notice");
      const page = (await call("GET", `${posts(PUBLIC)}?detail=full`, null)).body.items as any[];
      assert.ok(!page.some((p) => p.body === "cites across" || p.body === "names across"), "the refused POST was written");
    });
  }
});

describe("a hidden post's size is not shown either", () => {
  test("two hidden posts of very different lengths read the same, open included", async () => {
    const short = await call("POST", posts(PUBLIC), colleague, { kind: "obs", body: "x", summary: "s" });
    const long = await call("POST", posts(PUBLIC), colleague, {
      kind: "obs", body: "y".repeat(60000), summary: "z".repeat(4000), data: { note: "w".repeat(9000) },
    });
    // What opening the long one costs while its words are shown: tens of thousands of tokens.
    const shown = ((await call("GET", `${posts(PUBLIC)}?detail=headlines`, null)).body.items as any[])
      .find((h) => h.seq === long.body.seq).open as number;
    assert.ok(shown > 20000, `the long post priced at ${shown}`);
    for (const id of [short.body.post_id, long.body.post_id]) {
      assert.equal((await call("PUT", `/v1/posts/${id}/hidden`, owner)).status, 200);
    }
    for (const who of [null, colleague, owner]) {
      const page = (await call("GET", `${posts(PUBLIC)}?detail=headlines`, who)).body.items as any[];
      const [a, b] = [short.body.seq, long.body.seq].map((seq) => page.find((h) => h.seq === seq));
      assert.ok(a && b, JSON.stringify(page));
      // Equal but for the text of unavailable.since, whose microseconds PostgreSQL writes
      // without trailing zeros, so one hidden post's answer can be a byte shorter: one token
      // at most. Far below what the words cost, or a hidden size was priced in.
      assert.ok(Math.abs(a.open - b.open) <= 1, `open priced a hidden post by its hidden words: ${a.open} and ${b.open}`);
      assert.ok(b.open < 1000, `open priced a hidden post by its hidden words: ${b.open} against ${shown} shown`);
      assert.equal(a.start, undefined);
      assert.ok(!a.flags?.includes("summary") && !b.flags?.includes("summary"), "a hidden post's summary was flagged");
      for (const detail of ["snippets", "full"]) {
        const items = (await call("GET", `${posts(PUBLIC)}?detail=${detail}`, who)).body.items as any[];
        for (const seq of [short.body.seq, long.body.seq]) {
          const item = items.find((p) => p.seq === seq);
          assert.equal(item.unavailable.state, "hidden");
          for (const field of ["title", "summary", "body", "snippet", "data", "budget", "to"]) {
            assert.ok(item[field] === undefined || item[field] === null, `${detail} ${field} of a hidden post: ${JSON.stringify(item[field])}`);
          }
        }
      }
      const opened = await call("GET", `/v1/posts/${long.body.post_id}?outline=true`, who);
      assert.deepEqual(opened.body.sections, [], JSON.stringify(opened.body));
      assert.equal(opened.body.body_tokens, 0);
    }
  });
});
