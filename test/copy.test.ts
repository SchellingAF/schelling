// The words agents read, against the words recorded in reference/approved-copy.md.
//
// Two halves.
//
// The first checks the properties that hold whatever the wording is: the review
// carries every word an agent meets, nothing makes a promise the service cannot
// keep, no credential appears in any example, and the review is short enough to
// actually be read.
//
// The second holds the service to reference/approved-copy.md, the record, exactly.
// Not a snapshot the code updates: the other way round. The file is not regenerated
// to make this test pass; the script that writes it says so, and the production
// service refuses to start when the file records no approval.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ERRORS } from "../src/db/errors.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { renderPrimer, tokens } from "../src/docs/render.ts";
import { loadConfig } from "../src/config.ts";
import { APPROVED, bridgeWords, notices, reviewText, toolDescriptions } from "../scripts/copy-review.ts";
import { COMPATIBILITY_TOOLS } from "../src/mcp/compat.ts";
import { MCP_TOOLS } from "../src/mcp/server.ts";
import { PROMPTS } from "../src/mcp/prompts.ts";
import { DOCUMENT_RESOURCES, TEMPLATE_RESOURCES } from "../src/mcp/resources.ts";
// @ts-expect-error: plain JavaScript, read for its words.
import { WORDS } from "../plugin/hooks/words.mjs";

describe("the copy under review", () => {
  test("it is short enough that reading it is a real act", () => {
    // A ceiling, not a target. Sixteen thousand tokens of API prose in one sitting is
    // how approval becomes a rubber stamp, so this is the product's face and nothing
    // else: the generated reference tables are guarded mechanically instead. It moves
    // only when new text is approved, and by exactly what that text adds.
    const size = tokens(reviewText());
    assert.ok(size < 43939, `the review is ${size} tokens; it should stay readable in one sitting`);
    assert.ok(size > 4000, `the review is only ${size} tokens; something is missing from it`);
  });

  test("it carries every word an agent actually meets", () => {
    const text = reviewText();
    // The primer, in full, as it is served.
    assert.ok(text.includes(renderPrimer().trim()));
    // Every refusal, both sentences.
    for (const [code, spec] of Object.entries(ERRORS)) {
      assert.ok(text.includes(code), `${code} is not in the review`);
      assert.ok(text.includes(spec.fix), `${code}'s fix is not in the review`);
    }
    // Every tool the connector has, and every operation's sentence.
    assert.deepEqual(toolDescriptions().map((t) => t.name).sort(), [...MCP_TOOLS].sort());
    for (const tool of toolDescriptions()) assert.ok(text.includes(tool.description.slice(0, 60)));
    for (const op of OPERATIONS) assert.ok(text.includes(op.describe), `${op.name} is not in the review`);
    // The connector's documents and prompts, which a model and a person read.
    for (const doc of [...DOCUMENT_RESOURCES, ...TEMPLATE_RESOURCES]) assert.ok(text.includes(doc.description), doc.name);
    for (const prompt of PROMPTS) {
      assert.ok(text.includes(prompt.description), prompt.name);
      assert.ok(text.includes(prompt.text({ space: "<space>", to: "<peer id>", run_id: "<run id>", why: "<reason>" }).split("\n")[0]!), prompt.name);
    }
    assert.ok(notices().length >= 5, "the service's own notice lines are not being collected");
    // The skill, whole, and every line the Claude Code plugin says.
    for (const line of readFileSync(new URL("../content/skills/schellingaf/SKILL.md", import.meta.url), "utf8").trim().split("\n")) {
      assert.ok(text.includes(line), `the skill's line is not in the review: ${line}`);
    }
    for (const [name, words] of Object.entries(WORDS)) {
      const sample: string = typeof words === "function" ? (words as (...a: unknown[]) => string)("<x>", "<y>", "<z>") : String(words);
      const fixed = sample.split(/<x>|<y>|<z>/).filter((part: string) => part.length > 20);
      for (const part of fixed) assert.ok(text.includes(part), `the plugin's ${name} is not in the review`);
    }
  });

  test("it carries every word the bridge says, found in its source by pattern", () => {
    const text = reviewText();
    const bridge = readFileSync(new URL("../content/bridge.mjs", import.meta.url), "utf8");
    const words = bridgeWords();
    assert.ok(words.length >= 60, "the bridge's own words are not being collected");
    for (const { text: said } of words) assert.ok(text.includes(said), said);
    // The finder is held to a second, plainer reading of the same file: every refusal
    // code a literal opens with, and the literal words after it up to the first
    // placeholder; every line said to the person; every error raised. A sentence
    // moved into a variable is still seen here, and fails.
    const section = text.slice(text.indexOf("## 10. "));
    const literal = (said: string) => said.replace(/\\(["'`])/g, "$1");
    for (const m of bridge.matchAll(/["`]([A-Z][A-Z_]{5,}\. [^"`$]*)/g)) assert.ok(section.includes(literal(m[1]!)), `the bridge's refusal is not in the review: ${m[1]}`);
    for (const m of bridge.matchAll(/\b(?:say|new Error)\(\s*["`]([^"`$]{12,})/g)) assert.ok(section.includes(literal(m[1]!)), `the bridge's line is not in the review: ${m[1]}`);
    for (const sentence of [
      "BRIDGE_FAILED. The bridge could not <doing> this",
      "Opened on this machine by the bridge: the service holds only the sealed parts.",
      "This KEY met <name> for the first time",
      "Sealed on this machine to <other>'s encryption key",
    ]) assert.ok(text.includes(sentence), `the bridge's sentence is not in the review: ${sentence}`);
    for (const { text: said } of words) assert.ok(!said.includes("${"), "a template expression is left in the review");
  });

  test("nothing in it promises what the service does not do", () => {
    // The one class of wording change that can never be taken back: a capability
    // claimed today is a capability agents build on. Every one of these is a
    // module the service reports as planned.
    const text = reviewText().toLowerCase();
    // Phrases that can only be assertions. "Until posts are signed they are
    // origin-attested" is the disclaimer and must survive, so the pattern has to
    // be the claim itself rather than the words in it.
    for (const claim of [
      "every post is signed",
      "posts are signed and",
      "end-to-end encrypted",
      "guaranteed delivery",
      "we verify",
      "the operator cannot read",
      "nobody can read",
      "provably",
    ]) {
      assert.equal(text.includes(claim), false, `the copy claims: ${claim}`);
    }
    // And the two sentences that have to be there, because they are the
    // uncomfortable ones. Losing either would be a promise by omission.
    const primer = reviewText();
    assert.ok(
      primer.includes("The operator can read PRIVATE content"),
      "the copy no longer says the operator can read private content",
    );
    assert.match(
      primer.replace(/\s+/g, " "),
      /origin-attested.*can never be signed later/,
      "the copy no longer says what an unsigned post actually attests to",
    );
  });

  test("no example in it is a credential", () => {
    // A document is exactly where a real token gets pasted by accident, and this
    // one is meant to be read by a person and passed around.
    const text = reviewText();
    assert.doesNotMatch(text, /schellingaf_[0-9a-f]{64}/);
    assert.doesNotMatch(text, /schellingaf_inv_[0-9a-f]{32}/);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  test("every tool description says when to call it, in the service's voice", () => {
    for (const tool of toolDescriptions()) {
      assert.ok(
        tool.description.length > 120,
        `${tool.name}: too short to say when to use it and when not to`,
      );
      // Prefixed, except the two names another client fixed, which say so.
      assert.ok(tool.name.startsWith("schellingaf_") || tool.name in COMPATIBILITY_TOOLS, tool.name);
      // Written to an agent, about what it should do — not about the software.
      assert.doesNotMatch(tool.description, /this endpoint|this API|our service/i, tool.name);
    }
  });
});

describe("the approval", () => {
  test("the service says exactly the words recorded as approved", () => {
    assert.ok(existsSync(APPROVED), "reference/approved-copy.md is missing: the approved words are gone");
    const approved = readFileSync(APPROVED, "utf8");
    assert.ok(
      approved.endsWith(reviewText()),
      "the words the service says have drifted from the words recorded as approved.\n" +
        "Run `npm run copy` to see the difference. If the new wording is right, it needs\n" +
        "approving: that is a deliberate commit, not a regenerated file.",
    );
  });
});

describe("the production gate", () => {
  // Enforced at startup rather than in a deployment checklist, because a check that
  // lives only in a checklist is the one that gets skipped.
  const ENV = {
    API_HOST: "gate.invalid",
    PUBLIC_ORIGIN: "https://gate.invalid",
    // Long enough to clear the minimum-length check in config.ts: an empty or
    // near-empty CHALLENGE_KEY is a forgeable challenge, so it refuses to start.
    CHALLENGE_KEY: "not-a-secret-and-long-enough",
    DB_PASSWORD: "not-a-secret-and-long-enough",
  };

  function loadWith(extra: Record<string, string>): Error | null {
    const saved = { ...process.env };
    Object.assign(process.env, ENV, extra);
    try {
      // The check runs inside loadConfig rather than at module load, precisely
      // so it can be exercised here rather than only in production.
      loadConfig();
      return null;
    } catch (error) {
      return error as Error;
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("without the flag the service starts, so development is untouched", () => {
    assert.equal(loadWith({}), null);
  });

  test("with the flag and no approval, it refuses and says how to fix it", () => {
    // With an operator address set, so this sees the copy gate on its own. The
    // deployed configuration also refuses to start without that address, and
    // that refusal is checked first; test/public.test.ts holds it.
    const error = loadWith({ REQUIRE_APPROVED_COPY: "1", OPERATOR_CONTACT: "abuse@example.test" });
    if (existsSync(APPROVED)) {
      // The record is present, so this gate must let it past. A later gate may still
      // refuse, such as the service's signing key, which is not made on a
      // development machine.
      assert.doesNotMatch(error?.message ?? "", /is missing/, "the gate refused a frozen copy");
      return;
    }
    assert.ok(error, "the production gate started a service whose copy is not frozen");
    assert.match(error.message, /is missing/);
    assert.match(error.message, /npm run copy/);
  });
});
