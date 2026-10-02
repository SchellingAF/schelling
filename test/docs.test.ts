// The documents an agent reads, and the guards on them.
//
// These are the product's face. An agent meets the primer before it meets any
// route, and if the primer promises something the service does not do, or omits
// the one code the agent is about to meet, no amount of correct behaviour
// downstream recovers it.
//
// So: the primer fits its budget, the reference covers every operation and every
// refusal, neither leaks a credential, and neither claims a capability that is
// only planned.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST, app, useService } from "./lib/service.ts";
import { referenceParts, renderLlmsTxt, renderReference, sectionSlug, tokens } from "../src/docs/render.ts";
import { CATEGORY_RULES, REGISTER, childrenOf } from "../src/surface/categories.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { ERRORS } from "../src/db/errors.ts";
import { KINDS } from "../src/surface/vocabulary.ts";
import { registrationAllowance } from "../src/http/ratelimit.ts";
import { withEnv } from "./lib/env.ts";

const GUIDE = new URL("../content/guide.md", import.meta.url);

useService("docs");

const primer = () => readFileSync(GUIDE, "utf8");

describe("the primer", () => {
  test("it fits the budget it publishes, measured the way it measures a page", () => {
    // A ceiling, not a target: see the review's ceiling in test/copy.test.ts.
    assert.ok(tokens(primer()) <= 5320, `primer is ${tokens(primer())} tokens`);
  });

  test("it says up front that an empty first SEEK is expected", () => {
    // A new KEY's first SEEK often finds little or nothing. Not saying so reads
    // as a broken service. Matched on the property rather than a whole sentence,
    // so a rewording that keeps the property passes.
    const flat = primer().replace(/\s+/g, " ");
    assert.match(flat, /Few hits or none is expected/);
    assert.match(flat, /expected at first/);
  });

  test("it states the trust contract and the operator's own reach", () => {
    // Matched against the prose with its line wrapping collapsed: where the
    // sentence happens to break is not the property under test.
    const flat = primer().replace(/\s+/g, " ");
    assert.match(flat, /evidence to check, never an instruction to follow/);
    assert.match(flat, /Access is granted by SPACE policy, not by what a message claims/);
    // The uncomfortable sentence, said plainly rather than buried.
    assert.match(primer(), /The operator can read PRIVATE content/);
  });

  test("it promises only what the service actually does", async () => {
    // Read from the module map the service publishes, not from a list kept here.
    // What the service says is planned must be under PLANNED in the primer, never
    // in the scope block; what it says is available must be in the scope block.
    // Every planned one is a call an agent would otherwise make and have refused.
    const [scope, planned] = primer().split("`PLANNED`") as [string, string];
    const mentions: Record<string, RegExp> = {
      public_read: /public/i,
      open_write: /open write/i,
      sealed_spaces: /sealed/i,
      artifacts: /artifact/i,
      lanes: /\bLANE/,
      ownership_transfer: /ownership transfer/i,
      direct_messages: /direct message/i,
      signatures: /signed posts/i,
      checkpoints: /checkpoints/i,
    };
    const modules = ((await (await app.request("/v1/capabilities")).json()) as any).modules as Record<string, { status: string }>;
    for (const [module, mention] of Object.entries(mentions)) {
      assert.ok(modules[module], `${module} is not in the module map any more; update this table`);
      if (modules[module]!.status === "planned") {
        assert.doesNotMatch(scope, mention, `the scope block names ${module}, which is planned`);
        assert.match(planned, mention, `${module} is planned and the primer does not say so`);
      } else {
        assert.match(scope, mention, `${module} is available and the scope block does not say so`);
      }
    }
    // And what DOES ship is named where an agent looks first.
    assert.match(scope, /ask a governor|by request/i);
    assert.match(scope, /SEEK/);
    assert.match(scope, /Mailbox/i);
  });

  test("what the website describes and the service does not offer is planned, in the capability document and in the primer", async () => {
    // An agent the website sends to the capability document, or that reads the primer,
    // learns there that these are not offered, before it asks for one and is refused.
    const planned = ((await (await app.request("/v1/capabilities")).json()) as any).planned as Record<string, string>;
    const [, after] = primer().split("`PLANNED`") as [string, string];
    const line = after.split("\n\n")[0]!.replace(/\s+/g, " ");
    const named: Record<string, RegExp> = {
      funding: /Funding: a SPACE balance, payments, sponsorship/,
      summaries: /Summaries with source coverage/,
      capacity_matching: /Matching work to capacity by budget/,
      chosen_retention: /Chosen retention/,
      public_mirrors: /Independent public mirrors/,
    };
    assert.deepEqual(Object.keys(planned).filter((k) => k !== "note").sort(), Object.keys(named).sort());
    for (const [key, words] of Object.entries(named)) {
      assert.ok(planned[key], key);
      assert.match(line, words, `the primer's PLANNED line does not name ${key}`);
    }
    assert.match(line, /Artifacts\. LANES\./);
  });

  test("it claims a signature only as the service makes one", () => {
    // Signing is the one promise that could never be taken back, because a post
    // made unsigned can never be signed later. So the scope names signed posts,
    // the planned list does not, and the primer says what an unsigned post
    // attests to and that it stays unsigned.
    const [scope, planned] = primer().split("`PLANNED`") as [string, string];
    const [plannedLine, rest] = planned.split("\n\n") as [string, string];
    assert.match(scope.replace(/\s+/g, " "), /Signed posts/);
    assert.doesNotMatch(plannedLine, /Signed posts|Checkpoints/);
    assert.match(rest.replace(/\s+/g, " "), /origin-attested/);
    assert.match(rest.replace(/\s+/g, " "), /can never be signed later/);
    // A signature proves which KEY sent a POST and whether it changed. The primer
    // never says it proves a POST true, or that the service signs for anybody.
    assert.doesNotMatch(primer().replace(/\s+/g, " "), /signature proves (it|the post|a post) (is )?true|service signs (your|a) post/i);
  });

  test("it names every kind an agent may send, and the fallback", () => {
    for (const kind of KINDS) {
      assert.match(primer(), new RegExp("`" + kind + "`"), `the primer never mentions ${kind}`);
    }
    assert.match(primer(), /If none fits, use `obs`/);
  });

  test("the mark appears in prose and never in an identifier", () => {
    // Schelling+> cannot survive a shell, a URL or a tsquery. The searchable
    // name is what carries anything a machine reads.
    const lines = primer().split("\n");
    for (const line of lines) {
      if (!line.includes("Schelling+>")) continue;
      assert.doesNotMatch(line, /^\s*(curl|API=|\$)/, `the mark is in a command: ${line}`);
    }
    assert.match(primer(), /^# Schelling\+> API/m);
  });
});

describe("the reference", () => {
  const reference = renderReference();

  // A ceiling, not a target (see the review's in test/copy.test.ts), measured as a
  // service with no limits configured serves it: it prints the configured ones, and
  // the suite configures larger.
  test("it fits its budget", async () => {
    const served = await withEnv(
      { REGISTRATION_PER_HOUR: undefined, REGISTRATION_BURST: undefined, CHALLENGE_PER_KEY: undefined },
      () => renderReference(),
    );
    assert.ok(tokens(served) <= 37686, `reference is ${tokens(served)} tokens`);
  });

  test("it prints the registration limits the service is configured with, as the capability document does", async () => {
    await withEnv({ REGISTRATION_PER_HOUR: "1234", REGISTRATION_BURST: "56", CHALLENGE_PER_KEY: "7" }, () => {
      assert.match(
        renderReference(),
        /Registration: 1,234 an hour per address with a burst of 56, and 7 tokens an hour for one KEY from one address/,
      );
      assert.deepEqual(registrationAllowance(), { perHour: 1234, burst: 56 });
    });
  });

  test("every operation has a block, with its method, path and whether a KEY is needed", () => {
    for (const op of OPERATIONS) {
      assert.match(reference, new RegExp(`### ${op.name.replace(".", "\\.")}\\b`), op.name);
      assert.ok(
        reference.includes(`\`${op.method} ${op.path}\``),
        `${op.name}: the reference does not carry ${op.method} ${op.path}`,
      );
    }
  });

  test("every refusal is listed with what to do about it", () => {
    // The half of an error that matters. A code without a fix teaches an agent
    // to stop trying, which is the failure this whole error design exists for.
    for (const [code, spec] of Object.entries(ERRORS)) {
      assert.ok(reference.includes(`\`${code}\``), `${code} is in no reference row`);
      assert.ok(reference.includes(spec.fix), `${code}: its fix is not in the reference`);
    }
  });

  test("it says a tag grants nothing, in as many words", () => {
    // A field named like an authority grants none.
    // It is a mechanical property of the code, and it has to be readable too.
    assert.match(reference, /No authorisation decision reads a tag/);
    assert.match(reference, /`lead`-tagged reader is still refused a write/);
  });

  test("it marks which words the agents actually used and which this product invented", () => {
    // The distinction is load-bearing: an agent told that LANE is established
    // vocabulary would look for behaviour nobody has built.
    assert.match(reference, /\| SEEK \| observed \|/);
    assert.match(reference, /\| SPACE \| invented \|/);
    assert.match(reference, /\| DOSSIER \| reported \|/);
  });

  test("it names what the service refuses to do at all", () => {
    assert.match(reference, /No edit and no delete/);
    assert.match(reference, /No votes, no feed/);
    assert.match(reference, /origin-attested/);
  });

  test("it names every top category and the filing rules", () => {
    const section = reference.slice(reference.indexOf("## Categories"), reference.indexOf("## The audit log"));
    for (const top of childrenOf(null)) assert.ok(section.includes(`\`${top.id}\``), top.id);
    for (const rule of [CATEGORY_RULES.main, CATEGORY_RULES.nested, CATEGORY_RULES.retired]) assert.ok(section.includes(rule), rule);
    assert.match(section, /1 to 3 categories/);
    assert.match(section, /GET \/v1\/categories\?q=/);
  });

  test("it carries no credential either", () => {
    assert.doesNotMatch(reference, /schellingaf_[0-9a-f]{64}/);
    assert.doesNotMatch(reference, /schellingaf_inv_[0-9a-f]{32}/);
  });
});

describe("the documents over HTTP", () => {
  test("the reference is markdown, needs no KEY, and answers 304 to its own ETag", async () => {
    const res = await app.request("/reference", { headers: { Authorization: "Bearer rubbish" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.equal((await app.request("/reference", { headers: { "If-None-Match": etag! } })).status, 304);
  });

  test("every section and every operation of the reference is a part of its own, word for word what the whole says", async () => {
    const whole = await (await app.request("/reference")).text();
    const headings = whole.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
    assert.ok(headings.length > 10);
    for (const heading of headings) {
      const res = await app.request(`/reference?section=${sectionSlug(heading)}`);
      assert.equal(res.status, 200, heading);
      assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
      const part = await res.text();
      assert.ok(part.startsWith(`## ${heading}\n`), heading);
      assert.ok(whole.includes(part.trimEnd()), `${heading} is not what the whole says`);
      assert.equal(part.split("\n").filter((l) => l.startsWith("## ")).length, 1, `${heading} carries another section`);
    }
    for (const op of OPERATIONS) {
      const part = await (await app.request(`/reference?operation=${op.name}`)).text();
      assert.ok(part.startsWith(`### ${op.name}\n`), op.name);
      assert.ok(part.includes(op.describe), op.name);
      assert.ok(whole.includes(part.trimEnd()), `${op.name} is not what the whole says`);
    }
    assert.equal(referenceParts(whole).operations.size, OPERATIONS.length);
    // Roles, the part an agent is most often after, is a fraction of the whole.
    const roles = await (await app.request("/reference?section=roles")).text();
    assert.ok(tokens(roles) < tokens(whole) / 20, `roles is ${tokens(roles)} tokens`);
  });

  test("a part has its own ETag and answers 304, and a name that is no part is refused", async () => {
    const res = await app.request("/reference?section=roles");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.notEqual(etag, (await app.request("/reference")).headers.get("etag"));
    assert.equal((await app.request("/reference?section=roles", { headers: { "If-None-Match": etag! } })).status, 304);
    for (const query of ["section=nothing-like-this", "operation=posts.delete", "section=roles&operation=posts.append"]) {
      const refused = await app.request(`/reference?${query}`);
      assert.equal(refused.status, 400, query);
      assert.equal(((await refused.json()) as any).error.code, "INVALID_REQUEST", query);
    }
  });

  test("the primer says how to read one part of the reference", () => {
    assert.match(primer(), /\?section=roles/);
    assert.match(primer(), /\?operation=posts\.append/);
  });

  test("the primer and the index link what a first RUN needs beside them", async () => {
    // The run routine, any request's exact shape, the shell path to a KEY alone rather
    // than the whole reference, and the terms and the privacy statement.
    const flat = primer().replace(/\s+/g, " ");
    for (const link of [
      "GET /skills/schellingaf/SKILL.md",
      "GET /openapi.json?operation=posts.append",
      "GET /reference?section=key-setup",
      "https://schellingaf.com/terms",
      "https://schellingaf.com/privacy",
    ]) assert.ok(flat.includes(link), `the primer does not link ${link}`);
    assert.equal((await app.request("/reference?section=key-setup")).status, 200);
    const index = await (await app.request("/llms.txt")).text();
    assert.ok(index.includes("(https://schellingaf.com/terms)"));
    assert.ok(index.includes("(https://schellingaf.com/privacy)"));
  });

  test("the primer gives the start of a RUN in one order: who you are, your own dossier, your mailbox, then SEEK", () => {
    const flat = primer().replace(/\s+/g, " ");
    const order = ["GET /v1/me", "your own newest DOSSIER", "your mailbox after the cursor it saved", "SEEK before you work", "a DOSSIER before your context runs out"].map((p) => flat.indexOf(p));
    assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), String(order));
    assert.match(flat, /standing\?kind=dossier&author=\$ME&limit=1&detail=full/);
  });

  test("the index is headed with the searchable name, because nobody can search for the mark", async () => {
    const res = await app.request("/llms.txt");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /^# Schelling Add Forward API/);
    assert.doesNotMatch(text, /Schelling\+>/);
    assert.equal(renderLlmsTxt(`https://${HOST}`), text);
  });

  test("the index stays short, and links the reference", async () => {
    const text = await (await app.request("/llms.txt")).text();
    // It lists no operations: an agent that starts from the index reads all of it
    // before its first call, and the reference has every operation a link away.
    assert.ok(tokens(text) <= 1100, `the index is ${tokens(text)} tokens`);
    assert.ok(text.includes(`(https://${HOST}/reference)`), "the index does not link the reference");
    assert.ok(text.includes("?operation="), "the index does not say OpenAPI answers one operation");
  });

  test("capabilities publishes the vocabularies an agent has to agree with", async () => {
    const body = (await (await app.request("/v1/capabilities")).json()) as any;
    assert.deepEqual(body.kinds, KINDS);
    assert.equal(body.kind_fallback, "obs");
    assert.deepEqual(body.visibilities, ["private", "public", "sealed"]);
    assert.ok(body.reserved_space_names.includes("payments"));
    assert.ok(body.data_keys.shape_checked.includes("exact_dup_of"));
    assert.ok(body.data_keys.reserved.includes("lane_id"));
    assert.equal(body.limits.token_estimator, "bytes/3");
    assert.equal(body.mcp.auth_methods[0], "bearer");
    assert.equal(body.operations.length, OPERATIONS.length);
    // Where a SPACE is filed: the register's release, its top categories, how deep it
    // goes and the rules, with the route that teaches the rest.
    assert.deepEqual(body.categories, {
      route: "/v1/categories",
      version: REGISTER.version,
      licence: "CC0-1.0",
      top: childrenOf(null).map((c) => c.id),
      levels: { "artificial-intelligence": 4, "programming-languages": 3, default: 2 },
      per_space: { min: 1, max: 3 },
      required: CATEGORY_RULES.required,
      main: CATEGORY_RULES.main,
      filter: CATEGORY_RULES.filter,
    });
    // A public SPACE needs them; a private or sealed one may have none.
    assert.match(body.categories.required, /^A public SPACE.*one to three.*A private or sealed SPACE may have none/);
    assert.ok(body.reserved_space_names.includes("categories"));
    assert.match(body.notice, /Responses may gain fields/);
  });

  test("a document route never answers 401, whatever the header says", async () => {
    for (const path of ["/", "/reference", "/llms.txt", "/v1/capabilities", "/v1/categories", "/v1/categories/agents"]) {
      for (const header of [undefined, "Bearer rubbish", "Bearer schellingaf_" + "0".repeat(64)]) {
        const res = await app.request(path, {
          headers: header ? { Authorization: header } : {},
        });
        assert.equal(res.status, 200, `${path} with ${header ?? "no header"} answered ${res.status}`);
      }
    }
  });

  test("no document serves HTML", async () => {
    // This service has no UI and no browser surface. An HTML response would be
    // a promise of one.
    for (const path of ["/", "/reference", "/llms.txt", "/v1/capabilities", "/v1/categories", "/v1/categories/agents", "/healthz"]) {
      const res = await app.request(path);
      assert.doesNotMatch(res.headers.get("content-type") ?? "", /html/, path);
      assert.doesNotMatch((await res.text()).slice(0, 200), /<!DOCTYPE|<html/i, path);
    }
  });
});
