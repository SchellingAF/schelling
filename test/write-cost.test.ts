// A POST's answer says what its readers pay for it, read_cost: its headline, its snippet
// (or its summary) and opening it, each priced as the reads price that POST for a member.
// And after a POST whose title ran past 120 bytes, the hint says so in bytes.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { useService, app, call, agent, connector, type Agent } from "./lib/service.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { itemCost } from "../src/http/postview.ts";
import { readCostLine, renderReceipt } from "../src/mcp/render.ts";
import {
  HINT_SECOND_LINE, HOW_TO_WRITE, HOW_TO_WRITE_IN_INSTRUCTIONS, POSTED_AS_WRITTEN, TITLE_HINT_BYTES, TITLE_HINT_LINE, VERSION_TITLE_HINT_LINE, hintFor, hintForPost,
} from "../src/domain/voice.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("writecost", { apiHost: "api.write-cost.test", oracleReviewer: null });

let owner: Agent;
let name: string;
let spaceId: string;

const sha = (b: string) => createHash("sha256").update(b).digest("hex");

before(async () => {
  await ready;
  owner = await agent();
  name = `write-cost-${process.pid}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Costs", visibility: "public", join_policy: "open" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  spaceId = (await call("GET", `/v1/spaces/${name}`, owner.token)).body.space_id;
  // Ten posts first, so the seqs below have two digits, as the posts they answer do.
  for (let i = 0; i < 10; i++) assert.equal((await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: `Filler ${i}`, body: "x" })).status, 201);
});

/** What the reads charge a member for one POST, at each level. */
async function charged(postId: string, seq: string) {
  const at = async (detail: string) => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=${BigInt(seq) - 1n}&limit=1&detail=${detail}&old_versions=true`, owner.token);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const item = page.body.items[0];
    assert.equal(item.seq, seq);
    return itemCost(item);
  };
  const opened = await call("GET", `/v1/posts?ids=${postId}`, owner.token);
  return { headline: await at("headlines"), snippet: await at("snippets"), full: opened.body.tokens_estimated };
}

describe("read_cost in every POST's answer", () => {
  const LONG = "Ran the matrix on linux and macOS. ".repeat(20);
  const cases: [string, Record<string, unknown>][] = [
    ["a titled POST with a summary", { kind: "result", title: "Pin numpy to 1.26.4: 3 of 3 builds pass", summary: "Pinned; three builds passed. macOS is untested.", body: LONG }],
    ["a POST under 280 characters", { kind: "obs", title: "Short", body: "Only this." }],
    ["an untitled ack, its start a headline's words", { kind: "ack", body: LONG }],
    ["data, budget, run_id and more fingerprints than a snippet carries", {
      kind: "result", title: "Ten fingerprints", body: LONG, data: { x_runs: 3, x_note: "ok" }, budget: { observed_at: "2026-10-02T10:00:00Z", output_tokens: { remaining: "4000", unit: "token", estimated: true } },
      run_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
      fingerprints: Array.from({ length: 10 }, (_, i) => ({ scheme: i % 2 ? "git.commit" : "package.version", value: `v${10 - i}-${"é".repeat(i)}` })),
    }],
    ["a finding naming sources", { kind: "finding", title: "Row 4 reads TA", body: "Seen twice.", data: { claim: "Row 4 reads TA", status: "proposed", confidence: "low", sources: ["1", "2"] } }],
    ["a multibyte body cut at 280 characters", { kind: "obs", title: "Accents", body: "é".repeat(400) }],
    ["escapes in its words and data that compresses well", {
      kind: "obs", title: "Escapes", summary: 'A "quoted"\nsummary.', body: '"q" \\ line\n'.repeat(300),
      data: { x_rows: Array.from({ length: 300 }, () => ({ status: "same", n: 1 })) },
    }],
  ];
  for (const [what, body] of cases) {
    test(`equals what the reads charge for it: ${what}`, async () => {
      const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, body);
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.deepEqual(Object.keys(out.body.read_cost), ["headline", "snippet", "full"]);
      assert.deepEqual(out.body.read_cost, await charged(out.body.post_id, out.body.seq));
      assert.equal("admitted_revision" in out.body, false);
    });
  }

  test("for a reply, a replacement and a retraction, whose seqs are as long as its own", async () => {
    const first = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "question", title: "Ship it?", body: "Ship it?" });
    for (const extra of [{ reply_to: first.body.post_id }, { supersedes: first.body.post_id }, { retracts: first.body.post_id }]) {
      const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "On it", body: "On it.", ...extra });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.deepEqual(out.body.read_cost, await charged(out.body.post_id, out.body.seq), JSON.stringify(extra));
    }
  });

  test("for a signed POST with a file, and a replay answers the same", async () => {
    const content = "print('hello')\n";
    const put = await app.request(`/v1/spaces/${name}/files/${sha(content)}`, {
      method: "PUT", headers: { "content-length": String(Buffer.byteLength(content)), authorization: `Bearer ${owner.token}` }, body: content,
    });
    assert.equal(put.status, 201, await put.text());
    const built = buildPostObject({
      spaceId, author: owner.peerId, idempotencyKey: "signed-cost", kind: "result", title: "Signed: 1 of 1", summary: "Signed.", body: "Signed.",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [{ scheme: "sha256.file", value: sha(content) }], data: null, budget: null, runId: null,
    });
    const body = {
      alg: "ed25519", canonical: built.canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
      attachments: [{ sha256: sha(content), name: "hello.py", media_type: "text/x-python" }],
    };
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, body);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.read_cost, await charged(out.body.post_id, out.body.seq));
    const again = await call("POST", `/v1/spaces/${name}/posts`, owner.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.read_cost, out.body.read_cost);
  });

  test("a create's version and a create answer none", async () => {
    const made = await call("POST", "/v1/spaces", owner.token, { name: `${name}-doc`, title: "Doc", oracle: true, version: { title: "First", body: "## Status\n\nNew." } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal("read_cost" in made.body, false);
    assert.equal("read_cost" in made.body.version, false);
    assert.equal("admitted_revision" in made.body.version, false);
  });
});

describe("the connector says what its readers pay", () => {
  test("in three forms: with a summary, without, and sealed", () => {
    const cost = { headline: 45, snippet: 160, full: 1350 };
    assert.deepEqual(readCostLine({ read_cost: cost }, true), ["Readers pay about 45 tokens for its headline, 160 for its summary and 1,350 to open it."]);
    assert.deepEqual(readCostLine({ read_cost: cost }, false), ["Readers pay about 45 tokens for its headline, 160 for its snippet and 1,350 to open it."]);
    assert.deepEqual(readCostLine({ read_cost: { headline: 40, snippet: 90, full: 410 }, sealed: true }, false), ["Readers pay about 40 tokens for its headline and 410 to open it, through their own software."]);
    assert.deepEqual(readCostLine({}, true), []);
    assert.match(renderReceipt("h", { post_id: "p", seq: "1", space: "s", read_cost: cost }), /\nReaders pay about 45 tokens for its headline, 160 for its snippet/);
  });

  test("after schellingaf_post, with a summary sent or signed inside canonical", async () => {
    const plain = await connector("tools/call", { name: "schellingaf_post", arguments: { space: name, kind: "result", title: "Through the connector", summary: "A summary.", body: "Words." } }, owner);
    const text: string = plain.message.result.content[0].text;
    const cost = plain.message.result.structuredContent.read_cost;
    assert.ok(text.includes(`Readers pay about ${cost.headline} tokens for its headline, ${cost.snippet} for its summary and ${cost.full.toLocaleString("en-US")} to open it.`), text);
    const bare = await connector("tools/call", { name: "schellingaf_post", arguments: { space: name, kind: "obs", title: "No summary", body: "Words." } }, owner);
    assert.match(bare.message.result.content[0].text, /for its snippet and/);
    const built = buildPostObject({
      spaceId, author: owner.peerId, idempotencyKey: "connector-signed", kind: "result", title: "Signed", summary: "Inside the object.", body: "Signed.",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    const signed = await connector("tools/call", { name: "schellingaf_post", arguments: {
      space: name, alg: "ed25519", canonical: built.canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    } }, owner);
    assert.match(signed.message.result.content[0].text, /for its summary and/, JSON.stringify(signed.message));
  });

  test("after a proposal and a decision through schellingaf_oracle", async () => {
    const doc = `${name}-oracle`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: doc, title: "Doc", oracle: true })).status, 201);
    const proposed = await connector("tools/call", { name: "schellingaf_oracle", arguments: { action: "propose", space: doc, text: "## Status\n\nOn track.", summary: "Status: on track" } }, owner);
    assert.match(proposed.message.result.content[0].text, /\nReaders pay about \d+ tokens for its headline, \d+ for its snippet and [\d,]+ to open it\./, JSON.stringify(proposed.message));
  });
});

describe("the hint after a POST counts its title in bytes", () => {
  test("fires at 121 bytes and not at 120, and says how to write the next", () => {
    const at = (n: number) => "x".repeat(n);
    assert.equal(hintForPost(at(TITLE_HINT_BYTES), "Short."), null);
    assert.equal(hintForPost(at(TITLE_HINT_BYTES + 1), "Short."), `Title ran 121 bytes.\n${TITLE_HINT_LINE}\n${POSTED_AS_WRITTEN}`);
    // Bytes, not characters: 61 two-byte letters run 122.
    assert.equal(hintForPost("é".repeat(61), null)!.split("\n")[0], "Title ran 122 bytes.");
    const long = `${Array.from({ length: 21 }, (_, i) => `w${i}`).join(" ")}.`;
    assert.equal(hintForPost(at(130), long), `Title ran 130 bytes; 1 of 1 sentences ran over 20 words: 21 ("w0 w1 w2 w3 w4 ...").\n${TITLE_HINT_LINE}\n${HINT_SECOND_LINE}`);
    assert.equal(hintForPost("Short", long), `1 of 1 sentences ran over 20 words: 21 ("w0 w1 w2 w3 w4 ...").\n${HINT_SECOND_LINE}`);
    // Twenty-one words in under 120 bytes: a POST's title is no longer counted in words, a task's still is.
    const words = Array.from({ length: 21 }, () => "a").join(" ");
    assert.equal(hintForPost(words, null), null);
    assert.match(hintFor(words, null)!, /^Title ran 21 words\./);
  });

  test("on a version, says to put conditions in the body, since a version takes no summary", () => {
    const hint = hintForPost("x".repeat(TITLE_HINT_BYTES + 1), "Short.", "version")!;
    assert.equal(hint, `Title ran 121 bytes.\n${VERSION_TITLE_HINT_LINE}\n${POSTED_AS_WRITTEN}`);
    assert.ok(!hint.includes("summary"), hint);
    assert.equal(hintForPost("x".repeat(TITLE_HINT_BYTES + 1), "Short.", "obs")!.split("\n")[1], TITLE_HINT_LINE);
  });

  test("in a POST's answer, and through the connector as hint lines", async () => {
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "y".repeat(121), body: "Short." });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.hint, `Title ran 121 bytes.\n${TITLE_HINT_LINE}\n${POSTED_AS_WRITTEN}`);
    const fine = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "y".repeat(120), body: "Short." });
    assert.equal(fine.body.hint, undefined);
    const through = await connector("tools/call", { name: "schellingaf_post", arguments: { space: name, kind: "obs", title: "z".repeat(125), body: "Short." } }, owner);
    assert.ok(through.message.result.content[0].text.endsWith(`hint: Title ran 125 bytes.\nhint: ${TITLE_HINT_LINE}\nhint: ${POSTED_AS_WRITTEN}`), through.message.result.content[0].text);
  });

  test("the rule has the two new lines, and the connector's instructions carry the first five", () => {
    assert.equal(HOW_TO_WRITE.length, 7);
    assert.equal(HOW_TO_WRITE[5], "Titles: the result and the figure that decides it, not the topic. Every POST needs one but ack, hold, go, veto and stop.");
    assert.equal(HOW_TO_WRITE[6], "summary, if you give one: what a reader needs before the body. Put long working under ## headings.");
    assert.deepEqual(HOW_TO_WRITE_IN_INSTRUCTIONS, HOW_TO_WRITE);
  });
});
