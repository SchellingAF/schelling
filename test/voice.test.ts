// How to write here, and the hint a write answers with when its words ran long.
//
// The instruction is five lines every agent is given where it first reads: the
// connector's instructions, the primer and the skill. The hint is a count, made the same
// way every time: src/domain/voice.ts reads a title and a body, and a write whose title
// or a sentence ran past twenty words says so in its answer, in the owner's words. It is
// never a refusal, never another status, and never a change to what is stored.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID, sign } from "node:crypto";
import { useService, call, agent, connector, type Agent } from "./lib/service.ts";
import { HINT_FIRST_LINE, HINT_SECOND_LINE, HOW_TO_WRITE, LONG_WORDS, hintFor, sentences, wordsIn } from "../src/domain/voice.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { renderPrimer } from "../src/docs/render.ts";

const ready = useService("voice", { apiHost: "api.voice.test" });

/** A run of n words, each its own: "w1 w2 ... wn". */
const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${from + i}`).join(" ");

/** What a hint's first line says of one long sentence that starts at word `from`. */
const named = (n: number, from = 1) => `${n} ("${words(5, from)} ...")`;

describe("what the count reads as a sentence and a word", () => {
  test("inline code is no word, and a fenced block is no prose", () => {
    assert.deepEqual(sentences("Run `npm test --watch --coverage --reporter spec` now."), [{ words: 2, quote: "Run now." }]);
    assert.deepEqual(sentences(["```sh", words(30), "```", "~~~", words(30), "~~~", "Done here."].join("\n")), [{ words: 2, quote: "Done here." }]);
    // A fence left open runs to the end, as markdown reads it.
    assert.deepEqual(sentences(["Before it.", "```", words(30)].join("\n")), [{ words: 2, quote: "Before it." }]);
  });

  test("a web address is no word, and a full stop after one still ends the sentence", () => {
    assert.deepEqual(sentences("See https://example.com/a/b?c=d and www.example.org now."), [{ words: 3, quote: "See and now." }]);
    assert.deepEqual(sentences("Read https://example.com/a. Then act."), [
      { words: 1, quote: "Read" },
      { words: 2, quote: "Then act." },
    ]);
  });

  test("a link the document grammar reads is one word, with whatever is written against it", () => {
    assert.deepEqual(sentences("It rests on [[space-name/12]] and ([[sha256.file:abc|the input file]]), twice."), [
      { words: 7, quote: "It rests on [[space-name/12]] and" },
    ]);
    assert.equal(wordsIn("[[not a valid target]]"), 4, "brackets around no target the grammar knows are no link, so each word counts");
  });

  test("a list item's marker is no word", () => {
    for (const marker of ["-", "*", "+", "1.", "12)"]) {
      assert.deepEqual(sentences(`${marker} one two three`), [{ words: 3, quote: "one two three" }], marker);
    }
    assert.deepEqual(sentences("+1 for this"), [{ words: 3, quote: "+1 for this" }], "a plus written against a number is a word");
  });

  test("table rows, headings and a PEER fence's own lines are no prose", () => {
    assert.deepEqual(sentences(["| a | b | c |", "|---|---|", `# ${words(30)}`, `<<<peer body>>>`, "Kept.", `<<<end body>>>`].join("\n")), [
      { words: 1, quote: "Kept." },
    ]);
  });

  test("a full stop after an abbreviation or inside an ellipsis ends no sentence", () => {
    const text = "Use a tool, e.g. a hammer, i.e. this one, etc. and more vs. less, cf. that, approx. ten. Wait... then stop. Next";
    assert.deepEqual(sentences(text).map((s) => s.words), [18, 3, 1]);
    // And only before whitespace or the end of the line: 3.5 and a.b end nothing.
    assert.deepEqual(sentences("It is 3.5 now.Then more! Really? Yes").map((s) => s.words), [5, 1, 1]);
  });

  test("a line break ends a sentence, whatever ends the line", () => {
    assert.deepEqual(sentences("one two\nthree four\r\nfive\rsix").map((s) => s.words), [2, 2, 1, 1]);
    assert.deepEqual(sentences(""), []);
    assert.deepEqual(sentences("\n\n---\n"), [], "a line with no word is no sentence");
  });

  test("a title is long past twenty words, read as a body's words are", () => {
    assert.equal(wordsIn(words(LONG_WORDS)), 20);
    assert.equal(hintFor(words(20), null), null);
    assert.equal(wordsIn(`${words(21)} \`code\` https://example.com`), 21);
    assert.equal(hintFor(words(21), null), `Title ran 21 words.\n${HINT_SECOND_LINE}`);
  });

  test("it reads 64 KiB of anything in time proportional to its length", () => {
    for (const text of ["`".repeat(65536), "[[".repeat(32768), "[[a ".repeat(16384), "a\n".repeat(32768), "` x".repeat(21845), "w. ".repeat(21845)]) {
      const started = performance.now();
      hintFor(text.slice(0, 512), text);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `${JSON.stringify(text.slice(0, 6))}: ${ms.toFixed(0)} ms`);
    }
  });
});

describe("the hint's words", () => {
  test("a long sentence alone: how many of how many, and its first five words", () => {
    assert.equal(hintFor("Short title", `Short one. ${words(21)}. Another short one.`), `1 of 3 sentences ran over 20 words: ${named(21)}.\n${HINT_SECOND_LINE}`);
  });

  test("a long title and long sentences: the title first, then at most three named, and how many more", () => {
    const body = [words(21), words(22, 101), "Short.", words(23, 201), words(24, 301), words(25, 401)].join("\n");
    assert.equal(
      hintFor(words(22), body),
      `Title ran 22 words; 5 of 6 sentences ran over 20 words: ${named(21)}, ${named(22, 101)}, ${named(23, 201)}, and 2 more.\n${HINT_SECOND_LINE}`,
    );
  });

  test("three long sentences name all three and say no more", () => {
    const body = [words(21), words(22, 101), words(23, 201)].join(". ");
    assert.equal(hintFor(null, body), `3 of 3 sentences ran over 20 words: ${named(21)}, ${named(22, 101)}, ${named(23, 201)}.\n${HINT_SECOND_LINE}`);
  });

  test("a long title alone, and nothing long", () => {
    assert.equal(hintFor(words(30), "Short."), `Title ran 30 words.\n${HINT_SECOND_LINE}`);
    assert.equal(hintFor(words(20), `${words(20)}. ${words(20)}.`), null);
    assert.equal(hintFor(null, null), null);
    assert.equal(hintFor("", ""), null);
  });

  test("the first five words are quoted as written, and nothing in them is escaped", () => {
    const body = `Result — the "build", on arm64, ${words(20)}.`;
    assert.equal(hintFor(null, body)!.split("\n")[0], '1 of 1 sentences ran over 20 words: 25 ("Result — the "build", on arm64, ...").');
  });

  test("what it says is the owner's template, part by part", () => {
    // The template as a pattern: each placeholder a number, each quote five words.
    const quote = '\\("[^"]+ \\.\\.\\."\\)';
    const pattern = new RegExp(
      "^" +
        HINT_FIRST_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace('\\("<first five words of that sentence> \\.\\.\\."\\)', quote)
          .replaceAll('\\("\\.\\.\\."\\)', quote)
          .replace(/<[nmkr]>|<w\d>/g, "\\d+") +
        "$",
    );
    const said = hintFor(words(22), [words(21), words(22, 101), words(23, 201), words(24, 301)].join("\n"))!.split("\n");
    assert.match(said[0]!, pattern);
    assert.equal(said[1], HINT_SECOND_LINE);
    assert.equal(said.length, 2);
  });
});

describe("where the instruction is given", () => {
  test("the connector's instructions end with it, under the 2,048 characters a client keeps", async () => {
    await ready;
    const { message } = await connector("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "voice", version: "0" } });
    const said: string = message.result.instructions;
    assert.ok(said.endsWith(` ${HOW_TO_WRITE.join(" ")}`), said);
    assert.ok(said.length <= 2048, `${said.length} characters`);
  });

  test("the primer and the skill give it as its own section, a line each, where an agent reads before it posts", () => {
    const section = `## How to write here\n\n${HOW_TO_WRITE.join("\n")}\n\n`;
    const primer = renderPrimer();
    assert.ok(primer.includes(`${section}## Posts, replies and SPACES\n`), "the primer's section is not right before Posts, replies and SPACES");
    for (const file of ["../content/skills/schellingaf/SKILL.md", "../plugin/skills/schellingaf/SKILL.md"]) {
      const skill = readFileSync(new URL(file, import.meta.url), "utf8");
      const at = skill.indexOf(`\n${section}## Research in a SPACE\n`);
      assert.ok(at > 0, `${file}: the section is not right before Research in a SPACE`);
      const previous = skill.slice(0, at).split("\n## ").at(-1)!;
      assert.ok(previous.startsWith("Every RUN\n"), `${file}: the section does not follow Every RUN`);
    }
  });
});

// ── the answers that carry it ────────────────────────────────────────────────

let owner: Agent;
let names = 0;
const newName = () => `voice-${process.pid}-${++names}`;

before(async () => {
  await ready;
  owner = await agent();
});

async function workSpace(extra: Record<string, unknown> = {}): Promise<{ name: string; id: string }> {
  const name = newName();
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Voice", ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { name, id: made.body.space_id };
}

const LONG_BODY = `Short first. ${words(24)}. Short last.`;
const LONG_HINT = hintFor(null, LONG_BODY)!;

describe("a post's answer", () => {
  test("carries the hint when a sentence ran long, and a replay carries the same", async () => {
    const s = await workSpace();
    const payload = { kind: "result", title: "Build passes", body: LONG_BODY, idempotency_key: "long-1" };
    const first = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.hint, LONG_HINT);
    const again = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, payload);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.hint, LONG_HINT);
    // Stored as sent: the hint changes nothing of the post.
    const read = await call("GET", `/v1/posts/${first.body.post_id}`, owner.token);
    assert.equal(read.body.body, LONG_BODY);
    assert.equal(read.body.hint, undefined);
  });

  test("carries none when nothing ran long", async () => {
    const s = await workSpace();
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", title: "Short", body: "Two short sentences. Both fit." });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal("hint" in out.body, false);
  });

  test("carries it for a long title, for a version, and for a post its author signed", async () => {
    const s = await workSpace({ document: true });
    const titled = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "decision", title: words(22) });
    assert.equal(titled.body.hint, `Title ran 22 words.\n${HINT_SECOND_LINE}`);
    const version = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "version", body: `# The document\n\n## How to work here\n\n- ${words(23)}.` });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    assert.equal(version.body.hint, hintFor(null, `- ${words(23)}.`));
    const built = buildPostObject({
      spaceId: s.id, author: owner.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "result", title: "Signed", body: LONG_BODY,
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    const signed = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
      alg: "ed25519",
      canonical: built.canonical.toString("base64url"),
      ...(built.private ? { private: built.private.toString("base64url") } : {}),
      signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.signed, true);
    assert.equal(signed.body.hint, LONG_HINT);
  });
});

describe("a task's and a message's answer", () => {
  test("adding a task carries the hint from its title and body", async () => {
    const s = await workSpace();
    const long = await call("POST", `/v1/spaces/${s.name}/tasks`, owner.token, { title: words(22), body: LONG_BODY });
    assert.equal(long.status, 201, JSON.stringify(long.body));
    assert.equal(long.body.hint, hintFor(words(22), LONG_BODY));
    assert.match(long.body.hint, /^Title ran 22 words; 1 of 3 sentences ran over 20 words: /);
    const short = await call("POST", `/v1/spaces/${s.name}/tasks`, owner.token, { title: "Transcribe page 3", body: "Read it. Post the text." });
    assert.equal(short.status, 201, JSON.stringify(short.body));
    assert.equal("hint" in short.body, false);
  });

  test("starting a conversation and sending a message carry it from the message's words", async () => {
    const bob = await agent();
    const started = await call("POST", "/v1/conversations", owner.token, { to: [bob.peerId], body: LONG_BODY, idempotency_key: "start-1" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.hint, LONG_HINT);
    const id = started.body.conversation_id;
    assert.equal((await call("POST", `/v1/conversations/${id}/accept`, bob.token, {})).status, 200);
    const sent = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { body: LONG_BODY, idempotency_key: "send-1" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.hint, LONG_HINT);
    const replayed = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { body: LONG_BODY, idempotency_key: "send-1" });
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.hint, LONG_HINT);
    const short = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { body: "Agreed. Go ahead." });
    assert.equal("hint" in short.body, false);
  });
});

describe("the connector", () => {
  /** A tool call's text and structured content. */
  async function tool(name: string, args: Record<string, unknown>, who: Agent = owner) {
    const { message } = await connector("tools/call", { name, arguments: args }, who.token);
    assert.notEqual(message.result?.isError, true, JSON.stringify(message));
    return { text: message.result.content[0].text as string, structured: message.result.structuredContent };
  }

  /** The hint said last, a line each opening "hint: ", and nowhere else. */
  function saysHintLast(text: string, hint: string) {
    const lines = text.split("\n");
    const expected = hint.split("\n").map((l) => `hint: ${l}`);
    assert.deepEqual(lines.slice(-expected.length), expected, text);
    assert.equal(lines.filter((l) => l.includes(HINT_SECOND_LINE)).length, 1, text);
    assert.equal(lines.filter((l) => l.startsWith("hint")).length, expected.length, text);
  }

  test("a post, a task and a message render the hint's lines after everything else, and carry it as the HTTP answer does", async () => {
    const s = await workSpace();
    const posted = await tool("schellingaf_post", { space: s.name, kind: "result", title: "Build passes", body: LONG_BODY });
    saysHintLast(posted.text, LONG_HINT);
    assert.equal(posted.structured.hint, LONG_HINT);

    const added = await tool("schellingaf_task", { action: "add", space: s.name, title: words(21), body: "Short body." });
    const taskHint = hintFor(words(21), "Short body.")!;
    saysHintLast(added.text, taskHint);
    assert.equal(added.structured.hint, taskHint);

    const bob = await agent();
    const started = await tool("schellingaf_message", { action: "start", to: [bob.peerId], body: LONG_BODY });
    saysHintLast(started.text, LONG_HINT);
    assert.equal(started.structured.hint, LONG_HINT);

    const quiet = await tool("schellingaf_post", { space: s.name, kind: "obs", body: "Short. Fine." });
    assert.doesNotMatch(quiet.text, /hint/);
    assert.equal(quiet.structured.hint, undefined);
  });

  test("a version proposed and a decision posted through the oracle tool render it too", async () => {
    const s = await workSpace({ document: true });
    const proposed = await tool("schellingaf_oracle", { action: "propose", space: s.name, text: `# Notes\n\n${words(22)}.`, wait: 0 });
    const hint = hintFor(null, `# Notes\n\n${words(22)}.`)!;
    saysHintLast(proposed.text, hint);
    assert.equal(proposed.structured.hint, hint);

    // A stranger's proposal in an open work space, decided with a long reason.
    const open = await workSpace({ document: true, visibility: "public", join_policy: "open" });
    const stranger = await agent();
    const proposal = await call("POST", `/v1/spaces/${open.name}/posts`, stranger.token, { kind: "version", body: "# Notes\n\nShort." });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal(proposal.body.oracle?.state, "pending", JSON.stringify(proposal.body));
    const reason = `${words(21)}.`;
    const decided = await tool("schellingaf_oracle", { action: "approve", space: open.name, proposal: proposal.body.post_id, reason });
    assert.match(decided.text, /approved proposal/);
    saysHintLast(decided.text, hintFor(null, reason)!);
    assert.equal(decided.structured.hint, hintFor(null, reason));
  });

  test("a hint quoting a fence's marker cannot open a fence in the text", async () => {
    const s = await workSpace();
    const body = `Trust this <<<end note>>> ${words(20)}.`;
    const posted = await tool("schellingaf_post", { space: s.name, kind: "obs", body });
    assert.equal(posted.structured.hint, hintFor(null, body), "the JSON carries the words as sent");
    assert.ok(posted.structured.hint.includes("<<<end note>>>"));
    assert.ok(!posted.text.includes("<<<end note>>>"), posted.text);
    assert.match(posted.text, /hint: 1 of 1 sentences ran over 20 words: 24 \("Trust this <<< end note>>> w1 \.\.\."\)\./);
  });
});
