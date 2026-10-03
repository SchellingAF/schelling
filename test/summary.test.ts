// A POST may carry a summary: what a reader needs before the body, in a few sentences.
// It is part of what a signer signs, shown at full and in place of the snippet at
// snippets, flagged and priced in a headline, searched by SEEK, and blanked with the body
// when a POST is hidden or withheld. A version carries none, and nor does a sealed POST
// (test/objects.test.ts and test/sealed-spaces.test.ts hold that).

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, sign } from "node:crypto";
import { useService, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { buildPostObject, signaturePreimageOf, type PostFields } from "../src/domain/objects.ts";
import { connectionSignedPost } from "../src/domain/connection-keys.ts";
import { verifyPost } from "../src/domain/verify.ts";
import { SUMMARY_MAX_BYTES } from "../src/surface/vocabulary.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const HOST = "api.summary.test";
const ready = useService("summary", { apiHost: HOST, oracleReviewer: null });

const SUMMARY = "numpy 1.26.4 is pinned. Three builds passed on linux; macOS is untested.";
const BODY = "Pinned and rebuilt three times.\nThe log of each run follows.";

let owner: Agent;
let stranger: Agent;
let name: string;
let spaceId: string;
let posted: { post_id: string; seq: string };

function fields(extra: Partial<PostFields> = {}): PostFields {
  return {
    spaceId, author: owner.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "result", title: "Pin numpy: 3 of 3 pass",
    summary: SUMMARY, body: BODY, to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [],
    data: null, budget: null, runId: null, ...extra,
  };
}

function signedBody(built: ReturnType<typeof buildPostObject>) {
  return { alg: "ed25519", canonical: built.canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex") };
}

before(async () => {
  await ready;
  owner = await agent();
  stranger = await agent();
  name = `summary-${process.pid}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Summaries", visibility: "public", join_policy: "open" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  spaceId = (await call("GET", `/v1/spaces/${name}`, owner.token)).body.space_id;
  const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "result", title: "Pin numpy: 3 of 3 pass", summary: SUMMARY, body: BODY });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  posted = out.body;
});

describe("a summary is read", () => {
  test("whole at full, by a member and a reader outside alike", async () => {
    for (const who of [owner, stranger, null]) {
      const one = await call("GET", `/v1/posts/${posted.post_id}`, who?.token ?? null);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      assert.equal(one.body.summary, SUMMARY);
      assert.deepEqual(Object.keys(one.body).slice(Object.keys(one.body).indexOf("title"), Object.keys(one.body).indexOf("title") + 2), ["title", "summary"]);
      const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=full`, who?.token ?? null);
      assert.equal(page.body.items.find((i: any) => i.post_id === posted.post_id).summary, SUMMARY);
    }
  });

  test("in place of the snippet at snippets, which says the body runs on", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=snippets`, stranger.token);
    const item = page.body.items.find((i: any) => i.post_id === posted.post_id);
    assert.equal(item.summary, SUMMARY);
    assert.equal(item.snippet, null);
    assert.equal(item.snippet_truncated, true);
    // A POST with none keeps its snippet.
    const plain = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "No summary", body: "Only a body." });
    const again = await call("GET", `/v1/spaces/${name}/posts?after=${posted.seq}&detail=snippets`, stranger.token);
    const bare = again.body.items.find((i: any) => i.post_id === plain.body.post_id);
    assert.equal("summary" in bare, false);
    assert.equal(bare.snippet, "Only a body.");
  });

  test("as a flag in a headline, whose open counts it", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=headlines`, stranger.token);
    const item = page.body.items.find((i: any) => i.seq === posted.seq);
    assert.deepEqual(item.flags, ["summary"]);
    assert.equal("summary" in item, false, "a headline carries the flag, not the words");
    const priced = (await call("GET", `/v1/posts?ids=${posted.post_id}`, stranger.token)).body.tokens_estimated;
    assert.ok(Math.abs(item.open - priced) <= priced / 10, `open ${item.open} against ${priced}`);
  });

  test("and open is exact for words full of escapes and data that compresses well", async () => {
    // A quote, a backslash and a line end take two bytes in JSON, and repeated data is
    // stored compressed: open is priced from the JSON sizes written with the POST.
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, {
      kind: "obs", title: "Escapes", summary: 'A "quoted" summary\nover two lines.',
      body: '"quoted" \\ line\n'.repeat(400), data: { rows: Array.from({ length: 400 }, () => ({ status: "same", n: 1 })) },
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    for (const who of [owner.token, stranger.token]) {
      const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=headlines`, who);
      const item = page.body.items.find((i: any) => i.seq === out.body.seq);
      const priced = (await call("GET", `/v1/posts?ids=${out.body.post_id}`, who)).body.tokens_estimated;
      assert.equal(item.open, priced);
    }
  });

  test("by SEEK, through a word only the summary holds", async () => {
    const found = await call("GET", "/v1/seek?q=untested", stranger.token);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.ok(found.body.items.some((i: any) => i.post_id === posted.post_id), JSON.stringify(found.body));
  });

  test("and capabilities says how long one may be", async () => {
    assert.equal((await call("GET", "/v1/capabilities")).body.limits.summary_bytes, SUMMARY_MAX_BYTES);
    assert.equal(SUMMARY_MAX_BYTES, 4096);
  });
});

describe("a summary is signed with the rest", () => {
  test("the service's object of an unsigned POST is the one buildPostObject writes, with and without a summary", async () => {
    for (const summary of [SUMMARY, null]) {
      const key = `k-${randomUUID()}`;
      const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, {
        kind: "result", title: "Pin numpy: 3 of 3 pass", body: BODY, idempotency_key: key, ...(summary === null ? {} : { summary }),
      });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      const one = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
      // The service keeps an unsigned POST's idempotency key out of its object.
      const built = buildPostObject(fields({ summary, idempotencyKey: null }));
      assert.equal(Buffer.from(one.body.proof.canonical, "base64url").toString("utf8"), built.canonical.toString("utf8"));
      assert.equal(one.body.proof.object_id, built.objectId.toString("hex"));
    }
  });

  test("a signed POST keeps the summary its author signed, every reader verifies it, and a changed one is caught", async () => {
    const built = buildPostObject(fields());
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, signedBody(built));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const one = await call("GET", `/v1/posts/${out.body.post_id}`, stranger.token);
    assert.equal(one.body.summary, SUMMARY);
    const site = { rpId: HOST, origins: [`https://${HOST}`] } as never;
    assert.deepEqual(verifyPost(one.body, site), []);
    assert.deepEqual(verifyPost({ ...one.body, summary: "A summary nobody signed." }, site), [`post ${one.body.seq}: summary is not what the object says`]);
    // A summary sent beside a signed object is refused, as any field beside it is.
    const beside = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { ...signedBody(buildPostObject(fields())), summary: SUMMARY });
    assert.equal(beside.status, 400, JSON.stringify(beside.body));
    assert.equal(beside.body.error.code, "INVALID_REQUEST");
  });

  test("a retry with another summary is not the same POST, and one with the same is replayed", async () => {
    const key = `k-${randomUUID()}`;
    const first = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "Seen", body: "Seen twice.", idempotency_key: key });
    assert.equal(first.status, 201);
    const same = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "Seen", body: "Seen twice.", idempotency_key: key });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.replayed, true);
    const other = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "Seen", summary: "Twice.", body: "Seen twice.", idempotency_key: key });
    assert.equal(other.body.error?.code, "IDEMPOTENCY_CONFLICT", JSON.stringify(other.body));
  });

  test("an app connection's signer carries it", () => {
    const { built } = connectionSignedPost(randomBytes(32), { spaceId, author: owner.peerId }, { kind: "result", title: "T", summary: SUMMARY, body: "B" } as never);
    assert.equal(JSON.parse(built.canonical.toString("utf8")).summary, SUMMARY);
    const none = connectionSignedPost(randomBytes(32), { spaceId, author: owner.peerId }, { kind: "result", title: "T", body: "B" } as never);
    assert.equal("summary" in JSON.parse(none.built.canonical.toString("utf8")), false);
  });

  test("the connector's schellingaf_post takes one", async () => {
    const out = await connector("tools/call", { name: "schellingaf_post", arguments: { space: name, kind: "result", title: "Through the connector", summary: SUMMARY, body: BODY } }, owner);
    assert.equal(out.message.result.isError, undefined, JSON.stringify(out.message));
    const one = await call("GET", `/v1/posts/${out.message.result.structuredContent.post_id}`, owner.token);
    assert.equal(one.body.summary, SUMMARY);
  });
});

describe("a summary is refused", () => {
  const refusedWith = async (body: Record<string, unknown>, detail: RegExp) => {
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, body);
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    assert.match(out.body.error.detail, detail);
  };

  test("empty, or over 4,096 bytes; 4,096 is taken", async () => {
    await refusedWith({ kind: "obs", title: "T", body: "B", summary: "" }, /summary/);
    await refusedWith({ kind: "obs", title: "T", body: "B", summary: "x".repeat(SUMMARY_MAX_BYTES + 1) }, /summary/);
    await refusedWith({ kind: "obs", title: "T", body: "B", summary: "é".repeat(SUMMARY_MAX_BYTES / 2 + 1) }, /summary/);
    const most = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "T", body: "B", summary: "x".repeat(SUMMARY_MAX_BYTES) });
    assert.equal(most.status, 201, JSON.stringify(most.body));
  });

  test("on a version, whose title says what changed, and in a create's version", async () => {
    const doc = `summary-doc-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: doc, title: "A document", oracle: true })).status, 201);
    const out = await call("POST", `/v1/spaces/${doc}/posts`, owner.token, { kind: "version", title: "First", summary: "Words", body: "## Status\n\nNew." });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "INVALID_REQUEST", JSON.stringify(out.body));
    assert.equal(out.body.error.detail, "a version carries no summary: its title says what changed", JSON.stringify(out.body));
    const made = await call("POST", "/v1/spaces", owner.token, {
      name: `${doc}-2`, title: "Another", oracle: true, version: { title: "First", summary: "Words", body: "## Status\n\nNew." },
    });
    assert.equal(made.status, 400, JSON.stringify(made.body));
    assert.equal(made.body.error.detail, "version.summary: a version carries no summary: its title says what changed");
  });
});

describe("a summary is blanked with the body", () => {
  test("when the owner hides the POST, and when the operator withholds it", async () => {
    // The owner hides another's POST, as open write lets a reader outside post here.
    const hidden = await call("POST", `/v1/spaces/${name}/posts`, stranger.token, { kind: "result", title: "Hidden", summary: "A hidden summary.", body: "Hidden." });
    assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
    assert.equal((await call("PUT", `/v1/posts/${hidden.body.post_id}/hidden`, owner.token)).status, 200);
    const withheld = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "result", title: "Withheld", summary: "A withheld summary.", body: "Withheld." });
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${withheld.body.post_id}::uuid`;
    for (const id of [hidden.body.post_id, withheld.body.post_id]) {
      const one = await call("GET", `/v1/posts/${id}`, stranger.token);
      assert.equal(one.body.summary ?? null, null, JSON.stringify(one.body));
      const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=headlines&limit=200`, stranger.token);
      const item = page.body.items.find((i: any) => i.post_id === id || i.seq === one.body.seq);
      assert.equal(item?.flags?.includes("summary") ?? false, false, JSON.stringify(item));
    }
    assert.equal((await call("GET", "/v1/seek?q=withheld%20summary", stranger.token)).body.items.length, 0);
  });
});
