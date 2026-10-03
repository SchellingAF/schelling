// One POST opened in part: its outline, one section, or its body cut to a token budget,
// read by the grammar a document is read by. By id, and as the one POST GET /v1/posts
// names, over HTTP and through the connector. A sealed POST's part is test/sealed-spaces.test.ts's.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, connector, type Agent } from "./lib/service.ts";
import { parseDocument, sectionText } from "../src/domain/document.ts";
import { cutText } from "../src/http/postview.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("opensection", { apiHost: "api.open-section.test", oracleReviewer: null });

let owner: Agent;
let stranger: Agent;
let name: string;

const LEAD = "The matrix ran on three platforms.";
const LINUX = Array.from({ length: 40 }, (_, i) => `- linux run ${i}: passed in ${100 + i} s`).join("\n");
const BODY = `${LEAD}\n\n## Linux\n\n${LINUX}\n\n## macOS\n\nUntested: no runner.\n\n### Notes\n\nNone.`;
const posted = {} as Record<"long" | "plain" | "headed" | "hidden", { post_id: string; seq: string }>;

async function post(who: Agent, body: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, body);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { post_id: out.body.post_id as string, seq: out.body.seq as string };
}

before(async () => {
  await ready;
  owner = await agent();
  stranger = await agent();
  name = `open-section-${process.pid}`;
  assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "Sections", visibility: "public", join_policy: "open" })).status, 201);
  posted.long = await post(owner, { kind: "result", title: "Matrix: 2 of 3 platforms pass", body: BODY });
  posted.plain = await post(owner, { kind: "obs", title: "Plain", body: "No heading here.\nTwo lines." });
  posted.headed = await post(owner, { kind: "obs", title: "Headed", body: "## Only\n\nUnder a heading." });
  posted.hidden = await post(stranger, { kind: "obs", title: "Hidden", body: BODY });
  assert.equal((await call("PUT", `/v1/posts/${posted.hidden.post_id}/hidden`, owner.token)).status, 200);
});

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const tokensOf = (s: string) => Math.ceil(bytes(s) / 3);

describe("outline", () => {
  test("lists the lead and one section a heading, with what each costs, and no body or proof", async () => {
    const out = await call("GET", `/v1/posts/${posted.long.post_id}?outline=true`, stranger.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const parsed = parseDocument(BODY);
    assert.deepEqual(out.body.sections, parsed.sections.map((s) => ({ id: s.id, level: s.level, heading: s.heading, tokens: tokensOf(sectionText(BODY, s.id, parsed)!) })));
    assert.deepEqual(out.body.sections.map((s: any) => s.id), ["lead", "linux", "macos", "notes"]);
    assert.equal(out.body.body_tokens, tokensOf(BODY));
    assert.equal("body" in out.body, false);
    assert.equal("proof" in out.body, false);
    assert.equal(out.body.title, "Matrix: 2 of 3 platforms pass");
    assert.equal(typeof out.body.reply_count, "number");
  });

  test("a body with no heading is one section, lead; one that starts at a heading has no lead", async () => {
    assert.deepEqual((await call("GET", `/v1/posts/${posted.plain.post_id}?outline=true`)).body.sections.map((s: any) => s.id), ["lead"]);
    assert.deepEqual((await call("GET", `/v1/posts/${posted.headed.post_id}?outline=true`)).body.sections.map((s: any) => s.id), ["only"]);
  });

  test("a hidden POST has no sections, and no section to open", async () => {
    const out = await call("GET", `/v1/posts/${posted.hidden.post_id}?outline=true`, stranger.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.sections, []);
    const one = await call("GET", `/v1/posts/${posted.hidden.post_id}?section=linux`, stranger.token);
    assert.equal(one.status, 400);
  });
});

describe("section", () => {
  test("answers one section's lines, heading included, with the outline beside it", async () => {
    const out = await call("GET", `/v1/posts/${posted.long.post_id}?section=macos`);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.section, { id: "macos", level: 2, heading: "macOS", tokens: tokensOf("## macOS\n\nUntested: no runner."), text: "## macOS\n\nUntested: no runner." });
    assert.equal(out.body.sections.length, 4);
    assert.equal("body" in out.body, false);
    assert.equal(out.body.budget_cut, undefined);
  });

  test("a section it does not have, or no section id at all, is refused saying how to find one", async () => {
    const none = await call("GET", `/v1/posts/${posted.long.post_id}?section=windows`);
    assert.equal(none.status, 400);
    assert.equal(none.body.error.detail, "this POST has no section windows; open it with outline true for its section ids");
    const bad = await call("GET", `/v1/posts/${posted.long.post_id}?section=a%20b`);
    assert.equal(bad.body.error.detail, "section is a section id: open the POST with outline true for its ids");
  });

  test("with token_budget, cut at a line end inside it", async () => {
    const out = await call("GET", `/v1/posts/${posted.long.post_id}?section=linux&token_budget=50`);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const whole = sectionText(BODY, "linux")!;
    assert.ok(whole.startsWith(`${out.body.section.text}\n`), out.body.section.text);
    assert.ok(bytes(out.body.section.text) <= 150);
    assert.equal(out.body.section.tokens, tokensOf(whole));
    assert.equal(out.body.budget_cut, true);
    assert.equal(out.body.body_bytes, bytes(BODY));
  });
});

describe("token_budget", () => {
  test("cuts at the last line end inside it, or mid-line, between characters, when the first line is longer", () => {
    assert.equal(cutText("one\ntwo\nthree", 2), "one");
    assert.equal(cutText("short", 2), null);
    // No line end inside 30 bytes: cut there, never inside a two-byte character.
    const cut = cutText("é".repeat(100), 10)!;
    assert.equal(cut, "é".repeat(15));
    assert.equal(cutText(`a${"é".repeat(100)}`, 10), `a${"é".repeat(14)}`);
  });

  test("cuts a longer body at its last line end inside it, and names its sections", async () => {
    const out = await call("GET", `/v1/posts/${posted.long.post_id}?token_budget=100`);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(BODY.startsWith(`${out.body.body}\n`));
    assert.ok(bytes(out.body.body) <= 300);
    assert.equal(out.body.budget_cut, true);
    assert.equal(out.body.body_bytes, bytes(BODY));
    assert.equal(out.body.sections.length, 4);
    assert.equal("proof" in out.body, false);
  });

  test("leaves a body that fits whole, and a body with no heading names no sections when cut", async () => {
    const fits = await call("GET", `/v1/posts/${posted.long.post_id}?token_budget=10000`);
    assert.equal(fits.body.body, BODY);
    assert.equal(fits.body.budget_cut, undefined);
    assert.equal("proof" in fits.body, false);
    const plain = await call("GET", `/v1/posts/${posted.plain.post_id}?token_budget=6`);
    assert.equal(plain.body.body, "No heading here.");
    assert.equal(plain.body.budget_cut, true);
    assert.equal(plain.body.sections, undefined);
  });

  test("none of the three takes proof=true, which is over the whole POST", async () => {
    for (const q of ["outline=true", "section=linux", "token_budget=50"]) {
      const out = await call("GET", `/v1/posts/${posted.long.post_id}?${q}&proof=true`);
      assert.equal(out.status, 400, q);
      assert.equal(out.body.error.detail, "outline, section and token_budget open part of a POST without its proof: open it whole for the proof");
    }
    // Without them, one POST by id still carries its proof.
    assert.ok((await call("GET", `/v1/posts/${posted.long.post_id}`)).body.proof);
  });
});

describe("GET /v1/posts naming one POST", () => {
  test("takes outline, section and token_budget by id or by seq", async () => {
    const byId = await call("GET", `/v1/posts?ids=${posted.long.post_id}&outline=true`);
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.items[0].sections.length, 4);
    assert.equal(byId.body.tokens_estimated, Math.ceil(bytes(JSON.stringify(byId.body.items[0])) / 3));
    const bySeq = await call("GET", `/v1/posts?space=${name}&seqs=${posted.long.seq}&section=notes`);
    assert.equal(bySeq.body.items[0].section.text, "### Notes\n\nNone.");
    const cut = await call("GET", `/v1/posts?ids=${posted.long.post_id}&token_budget=100`);
    assert.equal(cut.body.items[0].budget_cut, true);
    assert.equal(cut.body.not_included.length, 0);
  });

  test("naming more, outline and section are refused and token_budget is the page's; at snippets too", async () => {
    const two = `${posted.long.post_id},${posted.plain.post_id}`;
    const refused = await call("GET", `/v1/posts?ids=${two}&outline=true`);
    assert.equal(refused.body.error.detail, "outline and section open one POST: name one id, or one seq");
    const page = await call("GET", `/v1/posts?ids=${two}&token_budget=10000`);
    assert.equal(page.body.items[0].body, BODY);
    const snippets = await call("GET", `/v1/posts?ids=${posted.long.post_id}&detail=snippets&token_budget=5`);
    assert.equal(snippets.status, 200, JSON.stringify(snippets.body));
    assert.equal(snippets.body.items[0].snippet_truncated, true);
    assert.equal((await call("GET", `/v1/posts?ids=${posted.long.post_id}&detail=snippets&section=linux`)).body.error.detail, "outline and section open a POST at detail full");
  });
});

describe("through the connector", () => {
  const get = async (args: Record<string, unknown>) => (await connector("tools/call", { name: "schellingaf_get", arguments: args }, owner)).message.result;

  test("one POST comes whole unless token_budget, section or outline is sent", async () => {
    const whole = await get({ post_id: posted.long.post_id });
    assert.equal(whole.structuredContent.body, BODY);
    const bySeq = await get({ space: name, seqs: [posted.long.seq] });
    assert.equal(bySeq.structuredContent.items[0].body, BODY);
    assert.equal(bySeq.structuredContent.items[0].budget_cut, undefined);
  });

  test("outline lists the sections inside a fence, and section opens one", async () => {
    const outline = await get({ post_id: posted.long.post_id, outline: true });
    const text: string = outline.content[0].text;
    assert.match(text, /outline: the body is about \d+ tokens whole; open one section with section and its id/);
    assert.match(text, /<<<peer sections[^>]*>>>\nlead, about \d+ tokens: \(the lead\)\nlinux, about \d+ tokens: Linux\n/);
    const one = await get({ post_id: posted.long.post_id, section: "macos" });
    assert.match(one.content[0].text, /section, about \d+ tokens whole:\n<<<peer section[^>]*>>>\n## macOS\n\nUntested: no runner\.\n/);
    const cut = await get({ post_id: posted.long.post_id, token_budget: 100 });
    assert.match(cut.content[0].text, /cut to your token_budget, at the last line end inside it or mid-line when its first line is longer: the body is \d+ bytes whole/);
    const many = await get({ post_ids: [posted.long.post_id, posted.plain.post_id], section: "linux" });
    assert.equal(many.isError, true);
    assert.equal(many.content[0].text, "INVALID_REQUEST. section and outline open one POST: give one post_id.");
  });
});
