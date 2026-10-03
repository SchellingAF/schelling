// The grammar an oracle space's document is written in, held to its vectors. A
// change to the grammar regenerates test/fixtures/document-vectors.json in the
// same commit; other copies of src/domain/document.ts are held to the same file.
//
// Then a work space's document (migrations/0115_documents.sql): the same machinery
// under the SPACE's own visibility, decided by its owner, an admin or a coordinator,
// driven through the routes and the connector as an agent would.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inline, parseDocument, replaceSection, sectionText, slug } from "../src/domain/document.ts";
import { useService, app, db, config, fixture, call, agent, connector, type Agent, type App } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { sign, randomUUID } from "node:crypto";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { STAGE_HINT } from "../src/domain/voice.ts";
import { STAGE_LIMITS } from "../src/surface/vocabulary.ts";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/document-vectors.json", import.meta.url), "utf8"));

describe("the document grammar", () => {
  for (const v of vectors.parse) {
    test(`parses: ${v.name}`, () => {
      const { name: _name, text, ...expected } = v;
      assert.deepEqual(parseDocument(text), expected);
    });
  }
  for (const e of vectors.edits) {
    test(`edits: ${e.name}`, () => {
      assert.equal(replaceSection(e.text, e.section, e.with), e.result);
      assert.equal(sectionText(e.text, e.section), e.section_text);
    });
  }

  test("an address scheme is never an identifier, and never a link at all", () => {
    const parsed = parseDocument("[[javascript:alert(1)]] [[data:text/html,x]] [[vbscript:x]]");
    assert.deepEqual(parsed.references, []);
  });

  test("links for what-links-here are SPACES and posts alone, once each, at most 256", () => {
    const many = Array.from({ length: 300 }, (_, i) => `[[space-${i}]] [[space-${i}]]`).join(" ");
    const parsed = parseDocument(many + " [[https://example.org]] [[git.commit:abc]]");
    assert.equal(parsed.links.length, 256);
    assert.equal(new Set(parsed.links).size, 256);
    assert.ok(parsed.links.every((l) => l.startsWith("space:")));
  });

  test("reads a document built to be slow in time proportional to its length", () => {
    const k64 = (unit: string) => unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536);
    const hostile = {
      "a thousand headings with one name": k64("# a\n"),
      "a line of link openings": k64("[["),
      "openings with a close far away": k64("[[" + "[".repeat(1998) + "]]"),
      "openings each with a bar": k64("[[x|"),
      "a target padded past its limit": k64("[[" + " ".repeat(3000) + "x]]"),
      "backticks never closed on a line": k64("`[[a|"),
      "list items of openings": k64("- [[[[[[\n"),
      "a heading of spaces that never ends": "#" + " ".repeat(65_000) + "\u2028",
      "a list item of spaces that never ends": "-" + "\t".repeat(65_000) + "\u2029",
    };
    // The time is this process's own processor time, which other work on the machine
    // does not add to, and the least of three reads: a parse costs the same each time,
    // and the first also pays for compiling the parser.
    for (const [name, text] of Object.entries(hostile)) {
      let took = Infinity;
      for (let read = 0; read < 3; read++) {
        const began = process.cpuUsage();
        parseDocument(text);
        const spent = process.cpuUsage(began);
        took = Math.min(took, (spent.user + spent.system) / 1000);
      }
      assert.ok(took < 250, `${name}: ${took.toFixed(0)} ms`);
    }
  });

  test("reads every line exactly as a reference parser, written independently, does", () => {
    // A reference parser, written independently, to hold the real one to. The grammar's
    // own rules for a target are copied, so it shares nothing with the real one.
    const classifyLike = (target: string) => {
      if (/^([a-z0-9][a-z0-9-]{2,62})\/([1-9][0-9]{0,17})$/.test(target)) return "post";
      if (/^[a-z0-9][a-z0-9-]{2,62}$/.test(target)) return "space";
      if (/^https?:\/\/[^\s<>"'`\\]{1,2000}$/.test(target)) return "web";
      const id = /^([a-z][a-z0-9_.-]{0,63}):([^\s\[\]|]{1,512})$/.exec(target);
      return id && !["http", "https", "javascript", "data", "vbscript", "file", "mailto", "blob"].includes(id[1]!) ? "identifier" : null;
    };
    const reference = (text: string) => {
      const out: any[] = [];
      const push = (part: any) => {
        const last = out[out.length - 1];
        if (part.t === "text" && last?.t === "text") last.v += part.v;
        else if (part.t !== "text" || part.v !== "") out.push(part);
      };
      let i = 0;
      while (i < text.length) {
        if (text[i] === "`") {
          const close = text.indexOf("`", i + 1);
          if (close > i + 1) { push({ t: "code", v: text.slice(i + 1, close) }); i = close + 1; continue; }
        }
        if (text.startsWith("[[", i)) {
          const close = text.indexOf("]]", i + 2);
          if (close > i + 2) {
            const inside = text.slice(i + 2, close);
            const bar = inside.indexOf("|");
            const target = (bar === -1 ? inside : inside.slice(0, bar)).trim();
            const label = bar === -1 ? null : inside.slice(bar + 1).trim().slice(0, 200) || null;
            const kind = inside.includes("\n") ? null : classifyLike(target);
            if (kind) { push({ t: "link", kind, target, label }); i = close + 2; continue; }
          }
        }
        let next = text.length;
        for (const mark of ["`", "[["]) {
          const at = text.indexOf(mark, i + 1);
          if (at !== -1 && at < next) next = at;
        }
        push({ t: "text", v: text.slice(i, next) });
        i = next;
      }
      return out;
    };
    const pieces = ["[[", "]]", "|", "`", "a", " ", "\n", "git.commit:abc", "abc", "abc/12", "https://e.example/x", "x y", "[", "]"];
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 5000; n++) {
      const line = Array.from({ length: 1 + Math.floor(random() * 14) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
      assert.deepEqual(inline(line), reference(line), JSON.stringify(line));
    }
    // Heading ids: the smallest free number from 2.
    const headings = Array.from({ length: 400 }, () => ["a", "a 2", "a-3", "b", "lead", ""][Math.floor(random() * 6)]!);
    const used = new Set(["lead"]);
    const expected = headings.map((h) => {
      const base = slug(h);
      let id = base;
      for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
      used.add(id);
      return id;
    });
    assert.deepEqual(parseDocument(headings.map((h) => `# ${h}`).join("\n")).sections.slice(1).map((sec) => sec.id), expected);
    // A heading and a list item read the same whatever run of spaces and tabs follows the mark.
    for (const gap of [" ", "  ", "\t", " \t  "]) {
      const parsed = parseDocument(`#${gap}Title here\n\n-${gap}an item`);
      assert.equal(parsed.sections[1]!.heading, "Title here");
      assert.deepEqual(parsed.blocks[1], { t: "list", items: [[{ t: "text", v: "an item" }]] });
    }
  });
});

// ── a work space's document ─────────────────────────────────────────────────

let reviewer: Agent;
let reviewerApp: App;

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("document", { apiHost: "api.document.test", oracleReviewer: null });
before(async () => {
  await ready;
  reviewer = await agent();
  // The same database with the service's reviewer named, as production runs.
  reviewerApp = createApp({ ...config, oracleReviewer: reviewer.peerId }, db);
});

let made = 0;
/** A work space of `owner`'s that keeps a document, private unless `extra` says. */
async function workSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `work-doc-${process.pid}-${made++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Wen mi telegrams", document: true, ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string): Promise<void> {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

function post(who: Agent, name: string, body: Record<string, unknown>, via: App = app) {
  return call("POST", `/v1/spaces/${name}/posts`, who.token, body, via);
}

function version(who: Agent, name: string, text: string, supersedes?: string | null, via: App = app) {
  return post(who, name, { kind: "version", body: text, ...(supersedes ? { supersedes } : {}) }, via);
}

async function current(name: string, who?: Agent): Promise<string | undefined> {
  return (await call("GET", `/v1/spaces/${name}/document`, who?.token)).body.version?.post_id;
}

async function mailbox(who: Agent, reason: string, via: App = app) {
  const out = await call("GET", `/v1/mailbox?reason=${reason}`, who.token, undefined, via);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.items as { reason: string; post?: { post_id: string } }[];
}

describe("a work space takes a document", () => {
  test("at creation, and later from its owner or an admin, and says so on its profile and in its events", async () => {
    const owner = await agent();
    const admin = await agent();
    const name = await workSpace(owner);
    const profile = await call("GET", `/v1/spaces/${name}`, owner.token);
    assert.equal(profile.body.oracle, false);
    assert.deepEqual(profile.body.document, { version: null, pending: 0 });
    assert.equal(profile.body.access.decide, true);
    const made = await call("GET", `/v1/spaces/${name}/events`, owner.token);
    assert.deepEqual(made.body.items.map((e: { event: string }) => e.event), ["space.created", "space.updated"]);
    assert.deepEqual(made.body.items[1].payload, { document: true });

    const later = `work-doc-later-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: later, title: "plain" })).status, 201);
    assert.equal((await call("GET", `/v1/spaces/${later}`, owner.token)).body.document, undefined, "a work space keeps none unless asked");
    await grant(owner, later, admin, "admin");
    const on = await call("PATCH", `/v1/spaces/${later}`, admin.token, { document: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.changed, true);
    assert.equal(on.body.document, true);
    const again = await call("PATCH", `/v1/spaces/${later}`, admin.token, { document: true });
    assert.equal(again.body.changed, false);
    // Off again while no version is posted, and on once more.
    assert.equal((await call("PATCH", `/v1/spaces/${later}`, owner.token, { document: false })).body.document, false);
    assert.equal((await call("PATCH", `/v1/spaces/${later}`, owner.token, { document: true })).body.document, true);
    // With a task setting in the same request: both, in one transaction.
    const both = await call("PATCH", `/v1/spaces/${later}`, owner.token, { document: true, task_confirmations: 1 });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.task_confirmations, 1);
    assert.equal(both.body.document, true);
    assert.equal(both.body.changed, true);
  });

  test("a writer may not set it, and an admin who also sends an owner's field changes nothing", async () => {
    const owner = await agent();
    const writer = await agent();
    const admin = await agent();
    const name = `work-doc-denied-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "plain" })).status, 201);
    await grant(owner, name, writer, "writer");
    await grant(owner, name, admin, "admin");
    const denied = await call("PATCH", `/v1/spaces/${name}`, writer.token, { document: true });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "CONTROL_DENIED");
    const mixed = await call("PATCH", `/v1/spaces/${name}`, admin.token, { document: true, title: "renamed" });
    assert.equal(mixed.status, 403);
    assert.equal((await call("GET", `/v1/spaces/${name}`, owner.token)).body.document, undefined);
  });

  test("never on an oracle space, which is one, nor on a sealed SPACE", async () => {
    const owner = await agent();
    const oracle = await call("POST", "/v1/spaces", owner.token, { name: `oracle-doc-${process.pid}`, title: "x", oracle: true, document: true });
    assert.equal(oracle.status, 400);
    assert.match(oracle.body.error.detail, /an oracle space is one document already/);
    const sealed = await call("POST", "/v1/spaces", owner.token, { name: `sealed-doc-${process.pid}`, title: "x", visibility: "sealed", document: true });
    assert.equal(sealed.status, 400);
    assert.match(sealed.body.error.detail, /a sealed SPACE keeps no document/);

    const made = await call("POST", "/v1/spaces", owner.token, { name: `oracle-doc2-${process.pid}`, title: "x", oracle: true });
    assert.equal(made.status, 201);
    for (const value of [true, false]) {
      const patch = await call("PATCH", `/v1/spaces/oracle-doc2-${process.pid}`, owner.token, { document: value });
      assert.equal(patch.status, 400, JSON.stringify(patch.body));
      assert.match(patch.body.error.detail, /an oracle space is one document already/);
    }
  });

  test("cannot be switched off once a version is posted, and the refusal says why", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    assert.equal((await version(owner, name, "The first.")).status, 201);
    const off = await call("PATCH", `/v1/spaces/${name}`, owner.token, { document: false });
    assert.equal(off.status, 400);
    assert.equal(off.body.error.code, "INVALID_REQUEST");
    assert.match(off.body.error.detail, /stays on once a version is posted/);
    assert.equal((await call("GET", `/v1/spaces/${name}`, owner.token)).body.document.version !== null, true);
  });

  test("a work space with no document still refuses a version, and watching and forking stay an oracle space's", async () => {
    const owner = await agent();
    const plain = `work-nodoc-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: plain, title: "plain", visibility: "public" })).status, 201);
    const refused = await version(owner, plain, "text");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "NOT_AN_ORACLE");
    assert.equal((await call("GET", `/v1/spaces/${plain}/document`)).body.error.code, "NOT_AN_ORACLE");

    const name = await workSpace(owner, { visibility: "public" });
    await version(owner, name, "Text.");
    assert.equal((await call("PUT", `/v1/spaces/${name}/watch`, owner.token)).body.error.code, "NOT_AN_ORACLE");
    assert.equal((await call("POST", `/v1/spaces/${name}/fork`, owner.token, { name: `${name}-fork` })).body.error.code, "NOT_AN_ORACLE");
  });
});

describe("who proposes and who decides", () => {
  test("a member proposes, the owner is told, and a writer's go is refused", async () => {
    const owner = await agent();
    const writer = await agent();
    const other = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    await grant(owner, name, other, "writer");
    const first = await version(owner, name, "v1");
    assert.deepEqual(first.body.oracle, { state: "current" }, "the owner's version is current at once");

    const p = await version(writer, name, "v2 by a member", first.body.post_id);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.deepEqual(p.body.oracle, { state: "pending" });
    assert.ok((await mailbox(owner, "proposal")).some((i) => i.post?.post_id === p.body.post_id));

    const go = await post(other, name, { kind: "go", body: "Looks right.", reply_to: p.body.post_id });
    assert.equal(go.status, 403, JSON.stringify(go.body));
    assert.equal(go.body.error.code, "CONTROL_DENIED");
    assert.match(go.body.error.detail, /only the owner, an admin or a coordinator decides one/);
    assert.equal(await current(name, owner), first.body.post_id);
    // A go on anything else is a writer's to post.
    const remark = await post(other, name, { kind: "obs", body: "A remark." });
    assert.equal((await post(writer, name, { kind: "go", body: "Agreed.", reply_to: remark.body.post_id })).status, 201);
  });

  test("a KEY that is no member may not propose in a work space that admits by request", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await workSpace(owner, { visibility: "public" });
    const first = await version(owner, name, "v1");
    const p = await version(stranger, name, "v2 by a stranger", first.body.post_id);
    assert.equal(p.status, 403, JSON.stringify(p.body));
    assert.equal(p.body.error.code, "WRITE_DENIED");
  });

  test("in an open work space a stranger proposes, marked no_role, and waits", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await workSpace(owner, { visibility: "public", join_policy: "open" });
    const first = await version(owner, name, "v1");
    const p = await version(stranger, name, "v2 by a stranger", first.body.post_id);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.deepEqual(p.body.oracle, { state: "pending" });
    assert.equal(p.body.no_role, true);
    const veto = await post(stranger, name, { kind: "veto", body: "Mine is better.", reply_to: p.body.post_id });
    assert.equal(veto.body.error.code, "CONTROL_DENIED");
  });

  test("the owner, an admin and a coordinator each decide, and a coordinator's own version is current at once", async () => {
    const owner = await agent();
    const admin = await agent();
    const coordinator = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, admin, "admin");
    await grant(owner, name, coordinator, "coordinator");
    await grant(owner, name, writer, "writer");
    let at = (await version(owner, name, "v1")).body.post_id as string;

    const byOwner = await version(writer, name, "v2", at);
    const ownerGo = await post(owner, name, { kind: "go", body: "Yes.", reply_to: byOwner.body.post_id });
    assert.deepEqual(ownerGo.body.oracle, { decided: "approved", version: byOwner.body.post_id });
    at = byOwner.body.post_id;

    const byAdmin = await version(writer, name, "v3", at);
    const adminGo = await post(admin, name, { kind: "go", body: "Yes.", reply_to: byAdmin.body.post_id });
    assert.deepEqual(adminGo.body.oracle, { decided: "approved", version: byAdmin.body.post_id });
    at = byAdmin.body.post_id;

    const declined = await version(writer, name, "v4, worse", at);
    const coordinatorVeto = await post(coordinator, name, { kind: "veto", body: "Unsourced.", reply_to: declined.body.post_id });
    assert.equal(coordinatorVeto.status, 201, JSON.stringify(coordinatorVeto.body));
    assert.deepEqual(coordinatorVeto.body.oracle, { decided: "declined", version: declined.body.post_id });
    const byCoordinator = await version(writer, name, "v4, better", at);
    const coordinatorGo = await post(coordinator, name, { kind: "go", body: "Sourced.", reply_to: byCoordinator.body.post_id });
    assert.deepEqual(coordinatorGo.body.oracle, { decided: "approved", version: byCoordinator.body.post_id });
    // The proposer hears the decision as a reply to its proposal.
    assert.ok((await mailbox(writer, "reply")).some((i) => i.post?.post_id === coordinatorGo.body.post_id));

    const own = await version(coordinator, name, "v5 from the coordinator", byCoordinator.body.post_id);
    assert.deepEqual(own.body.oracle, { state: "current" });
    assert.equal((await call("GET", `/v1/spaces/${name}`, coordinator.token)).body.access.decide, true);
    assert.equal((await call("GET", `/v1/spaces/${name}`, writer.token)).body.access.decide, false);

    const history = await call("GET", `/v1/spaces/${name}/versions`, owner.token);
    assert.deepEqual(
      history.body.items.map((v: { state: string }) => v.state),
      ["current", "replaced", "declined", "replaced", "replaced", "replaced"],
    );
    // A version is no post's to correct, in a work space as in an oracle space.
    const fix = await post(coordinator, name, { kind: "obs", body: "x", supersedes: own.body.post_id });
    assert.equal(fix.body.error.code, "REVISION_TARGET_NOT_FOUND");
  });

  test("a decision reaches its proposer whatever its mailbox holds, as in an oracle space", async () => {
    const owner = await agent();
    const coordinator = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, coordinator, "coordinator");
    await grant(owner, name, writer, "writer");
    const first = await version(owner, name, "v1");
    const p = await version(writer, name, "v2", first.body.post_id);
    // Read against the proposer's allowance, a proposer who filled its own mailbox could
    // stop anybody deciding its proposals. Far below nothing, so it does not refill mid-test.
    await fixture.setBucket("rcpt:" + writer.peerId, -1000000000);
    const go = await post(coordinator, name, { kind: "go", body: "Sourced.", reply_to: p.body.post_id });
    assert.equal(go.status, 201, JSON.stringify(go.body));
    assert.equal(go.body.not_notified, undefined, "the proposer was held to its own allowance");
    assert.ok((await mailbox(writer, "reply")).some((i) => i.post?.post_id === go.body.post_id));
  });

  test("a proposal made out of date is told to its author while it is a member, and never after it left", async () => {
    const owner = await agent();
    const stays = await agent();
    const leaves = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, stays, "writer");
    await grant(owner, name, leaves, "writer");
    const first = await version(owner, name, "v1");
    const kept = await version(stays, name, "v2 by one who stays", first.body.post_id);
    const gone = await version(leaves, name, "v2 by one who leaves", first.body.post_id);
    assert.deepEqual([kept.body.oracle, gone.body.oracle], [{ state: "pending" }, { state: "pending" }]);
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${leaves.peerId}`, owner.token)).status, 200);
    const next = await version(owner, name, "v2 by the owner", first.body.post_id);
    assert.deepEqual(next.body.oracle, { state: "current" });
    assert.equal((await mailbox(stays, "out_of_date")).length, 1);
    assert.equal((await mailbox(leaves, "out_of_date")).length, 0, "a private SPACE it left tells it nothing");
  });

  test("the service's reviewer neither decides nor is told, even as a member", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    await grant(owner, name, reviewer, "writer");
    const first = await version(owner, name, "v1", null, reviewerApp);
    const before = (await mailbox(reviewer, "proposal", reviewerApp)).length;
    const p = await version(writer, name, "v2", first.body.post_id, reviewerApp);
    assert.deepEqual(p.body.oracle, { state: "pending" });
    assert.equal((await mailbox(reviewer, "proposal", reviewerApp)).length, before, "the reviewer is not told");
    const go = await post(reviewer, name, { kind: "go", body: "A genuine contribution.", reply_to: p.body.post_id }, reviewerApp);
    assert.equal(go.status, 403, JSON.stringify(go.body));
    assert.equal(go.body.error.code, "CONTROL_DENIED");
    assert.equal(await current(name, owner), first.body.post_id);
  });
});

describe("who reads it", () => {
  test("a private SPACE's document and its history are its members' alone, row by row", async () => {
    const owner = await agent();
    const member = await agent();
    const stranger = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, member, "reader");
    const first = await version(owner, name, "Private findings.");
    for (const path of [`/v1/spaces/${name}/document`, `/v1/spaces/${name}/versions`]) {
      const refused = await call("GET", path, stranger.token);
      assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, "READ_DENIED");
      assert.equal((await call("GET", path)).status, 403, `${path} with no KEY`);
      const read = await call("GET", path, member.token);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.headers.get("cache-control"), "no-store");
    }
    assert.equal((await call("GET", `/v1/spaces/${name}/document`, member.token)).body.text, "Private findings.");

    // The profile tells a stranger only that a document is kept.
    const seen = await call("GET", `/v1/spaces/${name}`, stranger.token);
    assert.equal(seen.body.document, null);
    assert.equal(seen.body.access.decide, false);
    assert.deepEqual((await call("GET", `/v1/spaces/${name}`, member.token)).body.document, {
      version: { post_id: first.body.post_id, seq: first.body.seq },
      pending: 0,
    });

    // As the api role with no caller bound, not one row of it.
    const spaceId = seen.body.space_id;
    const [rows] = await db.readTx(null, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.oracle_versions where space_id = ${spaceId}::uuid`);
    assert.equal(rows!.n, 0);
  });

  test("a public work space's document is anybody's, and a read with no KEY may be cached", async () => {
    const owner = await agent();
    const name = await workSpace(owner, { visibility: "public" });
    await version(owner, name, "Public findings.");
    const read = await call("GET", `/v1/spaces/${name}/document`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.text, "Public findings.");
    assert.equal(read.headers.get("cache-control"), "public, max-age=60");
    assert.equal((await call("GET", `/v1/spaces/${name}/versions`)).body.items.length, 1);
    assert.deepEqual((await call("GET", `/v1/spaces/${name}`)).body.document.pending, 0);
  });

  test("SEEK and what links here leave a work space's document out", async () => {
    const owner = await agent();
    const target = `work-doc-target-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: target, title: "target", visibility: "public" })).status, 201);
    const name = await workSpace(owner, { visibility: "public" });
    const word = `axolotl${process.pid}`;
    await version(owner, name, `The ${word} document links [[${target}]].`);
    const seek = await call("GET", `/v1/seek?q=${word}`, owner.token);
    assert.deepEqual(seek.body.items, []);
    assert.deepEqual((await call("GET", `/v1/seek?q=${word}&space=${name}`, owner.token)).body.items, []);
    assert.deepEqual((await call("GET", `/v1/spaces/${target}/links`)).body.items, []);
  });
});

describe("a section that cites a post that moved", () => {
  test("is marked source_withdrawn, and so is the version, from its links and from data.sources", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const obs = await post(owner, name, { kind: "obs", body: "Image 37 is a 1931 codebook." });
    const kept = await post(owner, name, { kind: "result", body: "Rows match." });
    const text = `Lead.\n\n## Codebook\n\nPer [[${name}/${obs.body.seq}]].\n\n## Rows\n\n- [[${name}/${kept.body.seq}]] and [[other-space/${obs.body.seq}]]\n`;
    const first = await version(owner, name, text);
    const clean = await call("GET", `/v1/spaces/${name}/document`, owner.token);
    assert.equal(clean.body.version.source_withdrawn, undefined, "said only when true");
    assert.ok(clean.body.sections.every((s: Record<string, unknown>) => !("source_withdrawn" in s)));

    // Its author replaces the cited post: the section citing it is marked, and the version.
    await post(owner, name, { kind: "obs", body: "Image 37 is a 1932 codebook.", supersedes: obs.body.post_id });
    const moved = await call("GET", `/v1/spaces/${name}/document`, owner.token);
    assert.equal(moved.body.version.source_withdrawn, true);
    assert.deepEqual(
      moved.body.sections.map((s: { id: string; source_withdrawn?: boolean }) => [s.id, s.source_withdrawn === true]),
      [["lead", false], ["codebook", true], ["rows", false]],
    );
    const one = await call("GET", `/v1/spaces/${name}/document?section=codebook`, owner.token);
    assert.equal(one.body.section.source_withdrawn, true);
    assert.equal((await call("GET", `/v1/spaces/${name}/document?section=rows`, owner.token)).body.section.source_withdrawn, undefined);

    // A version whose data.sources names a post since retracted is marked as a whole.
    const plain = await version(owner, name, "No links here.", first.body.post_id);
    assert.equal((await call("GET", `/v1/spaces/${name}/document`, owner.token)).body.version.source_withdrawn, undefined);
    const withSources = await post(owner, name, { kind: "version", body: "Rests on rows.", supersedes: plain.body.post_id, data: { sources: [kept.body.post_id] } });
    assert.equal(withSources.status, 201, JSON.stringify(withSources.body));
    await post(owner, name, { kind: "decision", body: "Rows were wrong.", retracts: kept.body.post_id });
    const retracted = await call("GET", `/v1/spaces/${name}/document`, owner.token);
    assert.equal(retracted.body.version.source_withdrawn, true);
    assert.deepEqual(retracted.body.sections.map((s: { id: string }) => s.id), ["lead"]);
    // An older version by number is read the same way.
    const older = await call("GET", `/v1/spaces/${name}/document?version=${first.body.seq}`, owner.token);
    assert.equal(older.body.version.source_withdrawn, true);
  });

  test("an oracle space's document carries no source_withdrawn mark", async () => {
    const owner = await agent();
    const oracle = `oracle-unmarked-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "x", oracle: true })).status, 201);
    const obs = await post(owner, oracle, { kind: "obs", body: "A source." });
    await version(owner, oracle, `## Cites\n\n[[${oracle}/${obs.body.seq}]]`);
    await post(owner, oracle, { kind: "obs", body: "Gone.", retracts: obs.body.post_id });
    const doc = await call("GET", `/v1/spaces/${oracle}/document`);
    assert.equal(doc.body.version.source_withdrawn, undefined);
    assert.ok(doc.body.sections.every((s: Record<string, unknown>) => !("source_withdrawn" in s)));
  });
});

describe("the connector, the renderings and export", () => {
  async function tool(name: string, args: Record<string, unknown>, token?: string): Promise<{ text: string; isError: boolean }> {
    const { message } = await connector("tools/call", { name, arguments: args }, token);
    assert.ok(message.result, JSON.stringify(message.error ?? message));
    return { text: message.result.content?.[0]?.text ?? "", isError: message.result.isError === true };
  }

  test("schellingaf_space_control makes one, and schellingaf_oracle reads it, proposes and decides", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = `work-doc-tool-${process.pid}`;
    const made = await tool("schellingaf_space_control", { action: "create", name, title: "Through the tool", document: true }, owner.token);
    assert.equal(made.isError, false, made.text);
    assert.equal((await call("GET", `/v1/spaces/${name}`, owner.token)).body.document.version, null);
    await grant(owner, name, writer, "writer");

    const direct = await tool("schellingaf_oracle", { action: "propose", space: name, text: "Lead.\n\n## Limits\n\nTen." }, owner.token);
    assert.match(direct.text, /is current/);
    const proposed = await tool("schellingaf_oracle", { action: "propose", space: name, section: "limits", text: "## Limits\n\nTwelve.", summary: "twelve", wait: 0 }, writer.token);
    assert.equal(proposed.isError, false, proposed.text);
    assert.match(proposed.text, /proposed version \d+/);
    const pending = (await call("GET", `/v1/spaces/${name}/versions?state=pending`, owner.token)).body.items[0];
    const approved = await tool("schellingaf_oracle", { action: "approve", space: name, proposal: pending.post_id, reason: "Counted again." }, owner.token);
    assert.match(approved.text, /approved proposal/);
    const read = await tool("schellingaf_oracle", { action: "read", space: name }, writer.token);
    assert.match(read.text, /Twelve\./);
    const stranger = await agent();
    const refused = await tool("schellingaf_oracle", { action: "read", space: name }, stranger.token);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /READ_DENIED/);
  });

  test("the document and the profile answer Accept: text/markdown with the marks", async () => {
    const owner = await agent();
    const name = await workSpace(owner, { visibility: "public" });
    const obs = await post(owner, name, { kind: "obs", body: "A source." });
    await version(owner, name, `## Cites\n\nPer [[${name}/${obs.body.seq}]].`);
    await post(owner, name, { kind: "obs", body: "Gone.", retracts: obs.body.post_id });
    const md = async (path: string) => {
      const res = await app.request(path, { headers: { Accept: "text/markdown" } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
      return res.text();
    };
    const doc = await md(`/v1/spaces/${name}/document`);
    assert.match(doc, /\na post this version cites was replaced or retracted\n/);
    assert.match(doc, /\nsections that cite a post of this SPACE that was replaced or retracted, by id:\n<<<peer section id>>>\ncites\n<<<end section id>>>/);
    assert.match(doc, /\nwritten by a KEY that decides here, so current at once\n/);
    assert.match(await md(`/v1/spaces/${name}/document?section=cites`), /\nit cites a post of this SPACE that was replaced or retracted/);
    assert.match(await md(`/v1/spaces/${name}`), /\n {2}keeps a document, version \d+, 0 proposal\(s\) waiting; read it with schellingaf_oracle action read\n/);

    const hidden = await workSpace(owner);
    const res = await app.request(`/v1/spaces/${hidden}`, { headers: { Accept: "text/markdown" } });
    assert.match(await res.text(), /\n {2}keeps a document, which only its members read\n/);
  });

  test("an export carries the versions and the decisions, as every post", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    const first = await version(owner, name, "v1");
    const p = await version(writer, name, "v2", first.body.post_id);
    await post(owner, name, { kind: "go", body: "Yes.", reply_to: p.body.post_id });
    const res = await app.request(`/v1/spaces/${name}/posts`, {
      headers: { Accept: "application/x-ndjson", Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.filter((l) => l.kind).map((l) => l.kind), ["version", "version", "go"]);
    assert.ok(lines.at(-1).export, "the trailer closes it");
  });

  test("the capability document says a work space may keep one", async () => {
    const caps = (await (await app.request("/v1/capabilities")).json()) as any;
    assert.match(caps.modules.oracle_spaces.work_space, /^A public or private work space may keep one document as well/);
  });
});

describe("one section of many documents, by GET /v1/documents", () => {
  test("one item a SPACE, in the order asked: each reason, and a found item equal to the single read's", async () => {
    const owner = await agent();
    const found = await workSpace(owner);
    const obs = await post(owner, found, { kind: "obs", body: "Image 37." });
    await version(owner, found, `Lead.\n\n## Status\n\nPer [[${found}/${obs.body.seq}]].\n\n## Plan\n\nNext.\n`);
    const noSection = await workSpace(owner);
    await version(owner, noSection, "## Current status\n\nNear, not the same id.");
    const noVersion = await workSpace(owner);
    const noDocument = `plain-${process.pid}-${made++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: noDocument, title: "No document" })).status, 201);
    const unavailable = await workSpace(owner);
    const gone = await version(owner, unavailable, "## Status\n\nA live key was here.");
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'credential_exposure', 'a test' from schellingaf.posts p where p.post_id = ${gone.body.post_id}::uuid`;
    const invented = `no-such-${process.pid}-${made++}`;

    const asked = [found, invented, noDocument, noVersion, noSection, unavailable];
    const out = await call("GET", `/v1/documents?spaces=${asked.join(",")}&section=status`, owner.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.section, "status");
    assert.deepEqual(out.body.items.map((i: { space: string }) => i.space), asked);
    assert.deepEqual(out.body.items.map((i: { reason?: string }) => i.reason ?? "found"), ["found", "not_found", "no_document", "no_version", "no_section", "unavailable"]);
    const [hit, missing, plain, empty, near, withheld] = out.body.items;
    for (const item of [missing, plain, empty]) assert.deepEqual([item.version, item.text], [null, null]);
    assert.equal(near.text, null);
    assert.ok(near.version?.seq, "no_section carries its version");
    assert.equal(withheld.text, null);
    assert.equal(withheld.unavailable.state, "withheld");
    assert.equal(withheld.version.post_id, gone.body.post_id);

    // A found item is the single read's section, its text and its version.
    const single = await call("GET", `/v1/spaces/${found}/document?section=status`, owner.token);
    assert.equal(hit.text, single.body.section.text);
    assert.deepEqual(hit.version, { post_id: single.body.version.post_id, seq: single.body.version.seq });
    assert.deepEqual(out.body.not_included, []);
    assert.equal(out.body.budget_cut, undefined);
  });

  test("source_withdrawn is on the section that cites a post since replaced, and not on its neighbour", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const obs = await post(owner, name, { kind: "obs", body: "Image 37 is a 1931 codebook." });
    await version(owner, name, `## Codebook\n\nPer [[${name}/${obs.body.seq}]].\n\n## Rows\n\nNone cited.\n`);
    await post(owner, name, { kind: "obs", body: "Image 37 is a 1932 codebook.", supersedes: obs.body.post_id });
    const codebook = await call("GET", `/v1/documents?spaces=${name}&section=codebook`, owner.token);
    assert.equal(codebook.body.items[0].source_withdrawn, true);
    const rows = await call("GET", `/v1/documents?spaces=${name}&section=rows`, owner.token);
    assert.equal(rows.body.items[0].source_withdrawn, undefined);
    assert.ok(rows.body.items[0].text, "the neighbour was not found");
  });
});

// ── a SPACE's stage, set by a version (migrations/0123_space_stages.sql) ────────

describe("a SPACE's stage, set by a version", () => {
  /** A version that carries data.stage. */
  function staged(who: Agent, name: string, text: string, stage: unknown, supersedes?: string | null, via: App = app) {
    return post(who, name, { kind: "version", body: text, data: { stage }, ...(supersedes ? { supersedes } : {}) }, via);
  }
  async function stageOf(name: string, who?: Agent) {
    const out = await call("GET", `/v1/spaces/${name}`, who?.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return out.body.stage;
  }
  const SHAPE = /^data\.stage is word and note: word is one lowercase word of up to 32 of a-z, 0-9, _, \. and -, starting with a letter or digit; note is optional, one line of up to 200 characters$/;

  test("a malformed data.stage is refused, signed or not, and a well-made one at its limits is not", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const malformed: unknown[] = [
      { note: "no word" },
      { word: "Merged" },
      { word: "x".repeat(STAGE_LIMITS.wordCharacters + 1) },
      { word: "merged", note: "x".repeat(STAGE_LIMITS.noteCharacters + 1) },
      { word: "merged", note: "two\nlines" },
      { word: "merged", note: "a separator inside" },
      { word: "merged", note: "" },
      { word: "merged", by: "the owner" },
      { word: "-merged" },
      { word: "" },
      "merged",
      ["merged"],
      null,
    ];
    for (const stage of malformed) {
      const out = await staged(owner, name, "v1", stage);
      assert.equal(out.status, 400, `${JSON.stringify(stage)}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error.code, "INVALID_REQUEST");
      assert.match(out.body.error.detail, SHAPE, `${JSON.stringify(stage)}: ${JSON.stringify(out.body)}`);
    }
    // Signed, the same refusal, before anything is spent or written.
    const space = (await call("GET", `/v1/spaces/${name}`, owner.token)).body;
    const built = buildPostObject({
      spaceId: space.space_id, author: owner.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "version",
      title: null, body: "v1 signed", to: [], replyTo: null, supersedes: null, retracts: null,
      fingerprints: [], data: { stage: { word: "Merged" } }, budget: null, runId: null,
    });
    const signed = await call("POST", `/v1/spaces/${name}/posts`, owner.token, {
      alg: "ed25519",
      canonical: built.canonical.toString("base64url"),
      private: built.private!.toString("base64url"),
      signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    });
    assert.equal(signed.status, 400, JSON.stringify(signed.body));
    assert.match(signed.body.error.detail, SHAPE);
    assert.equal(await current(name, owner), undefined, "nothing was written");

    const word = "a".repeat(STAGE_LIMITS.wordCharacters);
    const note = "é".repeat(STAGE_LIMITS.noteCharacters);
    const ok = await staged(owner, name, "v1", { word, note });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([(await stageOf(name, owner)).word, (await stageOf(name, owner)).note], [word, note]);
    const noNote = await staged(owner, name, "v2", { word: "in-progress", note: null }, ok.body.post_id);
    assert.equal(noNote.status, 201, JSON.stringify(noNote.body));
    assert.equal((await stageOf(name, owner)).note, null);
  });

  test("a decider's version sets it at once; a writer's waits, and the go that makes it current sets it in the decider's name", async () => {
    const owner = await agent();
    const writer = await agent();
    const coordinator = await agent();
    const name = await workSpace(owner, { visibility: "public" });
    await grant(owner, name, writer, "writer");
    await grant(owner, name, coordinator, "coordinator");
    assert.equal(await stageOf(name), null, "no stage before a version sets one");

    const first = await staged(owner, name, "v1", { word: "proposed", note: "First draft." });
    assert.deepEqual(first.body.oracle, { state: "current" });
    assert.equal(first.body.stage_set, undefined, "a version is not a go");
    const set = await stageOf(name);
    assert.deepEqual({ ...set, set_at: undefined }, {
      word: "proposed", note: "First draft.", post_id: first.body.post_id, set_by: owner.peerId, set_at: undefined, finished: false,
    });
    assert.ok(!Number.isNaN(Date.parse(set.set_at)));

    const proposal = await staged(writer, name, "v2", { word: "accepted" }, first.body.post_id);
    assert.deepEqual(proposal.body.oracle, { state: "pending" });
    assert.equal((await stageOf(name)).word, "proposed", "a pending version sets nothing");

    const go = await post(coordinator, name, { kind: "go", body: "Sourced.", reply_to: proposal.body.post_id });
    assert.equal(go.status, 201, JSON.stringify(go.body));
    assert.deepEqual(go.body.stage_set, { word: "accepted", note: null, finished: false });
    const now = await stageOf(name);
    assert.equal(now.word, "accepted");
    assert.equal(now.post_id, proposal.body.post_id, "post_id leads to the proposer's version");
    assert.equal(now.set_by, coordinator.peerId, "set_by is the decider, never the proposer");
    // The list item says the same, with no token.
    const listed = await call("GET", `/v1/spaces?prefix=${name}`);
    assert.deepEqual(listed.body.items.map((i: { stage: unknown }) => i.stage), [now]);
  });

  test("a current version without one leaves the stage, and on any other kind data.stage sets nothing and says so", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    const first = await staged(owner, name, "v1", { word: "proposed" });
    const second = await version(owner, name, "v2, no stage", first.body.post_id);
    assert.deepEqual(second.body.oracle, { state: "current" });
    assert.equal(second.body.hint, undefined);
    assert.deepEqual([(await stageOf(name, owner)).word, (await stageOf(name, owner)).post_id], ["proposed", first.body.post_id]);

    for (const kind of ["obs", "decision", "go"]) {
      const out = await post(owner, name, { kind, body: "Merged.", data: { stage: { word: "merged" } } });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.equal(out.body.hint, STAGE_HINT, kind);
    }
    // Any shape at all: on another kind the key is free.
    const free = await post(owner, name, { kind: "obs", body: "Free.", data: { stage: "Anything At All" } });
    assert.equal(free.status, 201, JSON.stringify(free.body));
    assert.equal(free.body.hint, STAGE_HINT);
    assert.equal((await stageOf(name, owner)).word, "proposed");

    // A go that carries one and decides a version that carries another: the version's
    // is set, and the go hears that its own set nothing.
    const proposal = await staged(writer, name, "v3", { word: "accepted" }, second.body.post_id);
    const go = await post(owner, name, { kind: "go", body: "Yes.", reply_to: proposal.body.post_id, data: { stage: { word: "declined" } } });
    assert.deepEqual(go.body.stage_set, { word: "accepted", note: null, finished: false });
    assert.equal(go.body.hint, STAGE_HINT);
    assert.equal((await stageOf(name, owner)).word, "accepted");

    // Beside the long-text hint: this sentence first, then its two lines. A replay says the same.
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const body = { kind: "obs", title: long, body: "Short.", data: { stage: { word: "merged" } }, idempotency_key: "stage-long" };
    const both = await post(owner, name, body);
    const lines = String(both.body.hint).split("\n");
    assert.equal(lines.length, 3, both.body.hint);
    assert.equal(lines[0], STAGE_HINT);
    assert.match(lines[1]!, /^Title ran 30 words/);
    const again = await post(owner, name, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.hint, both.body.hint);
    // A veto and a go on a version with none set nothing, and say no stage_set.
    const plain = await version(writer, name, "v4", proposal.body.post_id);
    const plainGo = await post(owner, name, { kind: "go", body: "Yes.", reply_to: plain.body.post_id });
    assert.equal(plainGo.body.stage_set, undefined);
    const vetoed = await staged(writer, name, "v5", { word: "declined" }, plain.body.post_id);
    const veto = await post(owner, name, { kind: "veto", body: "No.", reply_to: vetoed.body.post_id });
    assert.equal(veto.body.stage_set, undefined);
    assert.equal((await stageOf(name, owner)).word, "accepted");
  });

  test("a version posted before the release, with no stage kept, sets nothing when it is approved", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    const first = await version(owner, name, "v1");
    const old = await staged(writer, name, "v2", { word: "merged" }, first.body.post_id);
    // What a version written before migrations/0123 holds: data.stage in the post, and
    // nothing beside it in oracle_versions.
    await fixture.owner`
      update schellingaf.oracle_versions set stage_word = null, stage_note = null where post_id = ${old.body.post_id}::uuid`;
    const go = await post(owner, name, { kind: "go", body: "Yes.", reply_to: old.body.post_id });
    assert.deepEqual(go.body.oracle, { decided: "approved", version: old.body.post_id });
    assert.equal(go.body.stage_set, undefined);
    assert.equal(await stageOf(name, owner), null);
  });

  test("the setter demoted or removed: the stage stays as it was", async () => {
    const owner = await agent();
    const coordinator = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, coordinator, "coordinator");
    const own = await staged(coordinator, name, "v1 from the coordinator", { word: "in-progress", note: "Building." });
    assert.deepEqual(own.body.oracle, { state: "current" });
    const set = await stageOf(name, owner);
    assert.equal(set.set_by, coordinator.peerId);
    await grant(owner, name, coordinator, "writer");
    assert.deepEqual(await stageOf(name, owner), set);
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${coordinator.peerId}`, owner.token)).status, 200);
    assert.deepEqual(await stageOf(name, owner), set);
  });

  test("whoever decides sees a proposal's stage first: on /versions, on the proposal notice and in the connector's history", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, writer, "writer");
    const first = await version(owner, name, "v1");
    const proposal = await staged(writer, name, "v2", { word: "merged", note: "Pull request 12 merged." }, first.body.post_id);

    const versions = await call("GET", `/v1/spaces/${name}/versions`, owner.token);
    const item = versions.body.items.find((v: { post_id: string }) => v.post_id === proposal.body.post_id);
    assert.deepEqual(item.stage, { word: "merged", note: "Pull request 12 merged." });
    assert.equal(versions.body.items.find((v: { post_id: string }) => v.post_id === first.body.post_id).stage, undefined);

    const notices = await call("GET", "/v1/mailbox?reason=proposal", owner.token);
    const notice = notices.body.items.find((i: { post?: { post_id: string } }) => i.post?.post_id === proposal.body.post_id);
    assert.deepEqual(notice.stage, { word: "merged", note: "Pull request 12 merged." });

    const tool = async (args: Record<string, unknown>) => {
      const { message } = await connector("tools/call", { name: "schellingaf_oracle", arguments: args }, owner.token);
      assert.ok(message.result, JSON.stringify(message.error ?? message));
      return { text: String(message.result.content?.[0]?.text ?? ""), data: message.result.structuredContent };
    };
    const history = await tool({ action: "history", space: name });
    assert.match(history.text, /sets stage once it is current:\n<<<peer stage word>>>\nmerged\n<<<end stage word>>>\n<<<peer stage note>>>\nPull request 12 merged\.\n<<<end stage note>>>/);
    const approved = await tool({ action: "approve", space: name, proposal: proposal.body.post_id, reason: "Checked." });
    assert.match(approved.text, /this made the SPACE's stage:\n<<<peer stage word>>>\nmerged\n<<<end stage word>>>/);
    assert.deepEqual(approved.data.stage_set, { word: "merged", note: "Pull request 12 merged.", finished: true });
    assert.equal((await stageOf(name, owner)).set_by, owner.peerId);
  });

  test("a KEY with no role in an open work space proposes a stage only for a decider to see and decide", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await workSpace(owner, { visibility: "public", join_policy: "open" });
    const first = await version(owner, name, "v1");
    const proposal = await staged(stranger, name, "v2", { word: "merged" }, first.body.post_id);
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal(await stageOf(name), null, "a proposal sets nothing");
    const versions = await call("GET", `/v1/spaces/${name}/versions`, owner.token);
    assert.deepEqual(versions.body.items.find((v: { post_id: string }) => v.post_id === proposal.body.post_id).stage, { word: "merged", note: null });
    const go = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "go", body: "Yes.", reply_to: proposal.body.post_id });
    assert.deepEqual(go.body.stage_set, { word: "merged", note: null, finished: true });
    const now = await stageOf(name);
    assert.equal(now.set_by, owner.peerId, "set in the decider's name, which the decider saw first");
    assert.equal(now.post_id, proposal.body.post_id);
  });
});
