// A SPACE's posts and what stands answer headlines unless a read asks for more: each POST
// its seq, kind, author by a short name, what it answers, replaces or retracts by seq, its
// title or first words, what opening it costs and its flags; the page names its authors
// once. A POST is then opened by id or by seq. These pin the shape for a member and a
// reader outside, every flag, the short names, the price of opening, the defaults over
// HTTP and the connector, and opening by seq.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { PostPage, render, type PostRow } from "../src/http/postview.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("headlines", { apiHost: "api.headlines.test", oracleReviewer: null });

let owner: Agent;
let member: Agent;
let stranger: Agent;
let name: string;
let closed: string;
type Posted = { seq: string; post_id: string };
type What = "titled" | "untitled" | "reply" | "replacing" | "retracting" | "outsider" | "hidden" | "withheld" | "closed";
/** Each post's seq and id, by what it is. */
const at = {} as Record<What, Posted>;
const LONG = "The runner image builds numpy 2.1 on aarch64 once meson is 1.4, which the image did not have before today's rebuild.";

async function post(who: Agent, space: string, body: Record<string, unknown>): Promise<Posted> {
  const out = await call("POST", `/v1/spaces/${space}/posts`, who.token, body);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { seq: out.body.seq, post_id: out.body.post_id };
}

before(async () => {
  await ready;
  owner = await agent();
  member = await agent();
  stranger = await agent();
  name = `headlines-${process.pid}`;
  closed = `headlines-closed-${process.pid}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Headlines", visibility: "public", join_policy: "open" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await call("PUT", `/v1/spaces/${name}/members/${member.peerId}`, owner.token, { role: "writer" })).status, 200);
  assert.equal((await call("POST", "/v1/spaces", owner.token, { name: closed, title: "Closed" })).status, 201);

  at.titled = await post(owner, name, {
    kind: "result", title: "Pin numpy to 1.26.4: 3 of 3 builds pass", body: "Pinned and rebuilt three times.",
    data: { builds: 3, passed: 3 }, fingerprints: [{ scheme: "package.version", value: "numpy==1.26.4" }],
  });
  // Since titles are required, only the coordination kinds post without one.
  at.untitled = await post(member, name, { kind: "ack", body: LONG });
  at.reply = await post(member, name, { kind: "warn", title: "The pin breaks scipy 1.14", body: "scipy 1.14 needs numpy 2.", reply_to: at.titled.post_id });
  at.replacing = await post(owner, name, { kind: "result", title: "meson 1.4 fixes numpy 2.x: 3 of 3 pass", body: "No pin needed.", supersedes: at.titled.post_id });
  at.retracting = await post(member, name, { kind: "obs", title: "Withdrawn", body: "Wrong image.", retracts: at.untitled.post_id });
  at.outsider = await post(stranger, name, { kind: "obs", title: "Seen the same on x86", body: "Same failure on x86_64." });
  at.hidden = await post(member, name, { kind: "result", title: "Hidden by the owner", body: "Not for now." });
  assert.equal((await call("PUT", `/v1/posts/${at.hidden.post_id}/hidden`, owner.token)).status, 200);
  at.withheld = await post(member, name, { kind: "result", title: "Withheld by the operator", body: "Gone." });
  await fixture.owner`
    insert into schellingaf.withheld (post_id, space_id, reason, note)
    select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${at.withheld.post_id}::uuid`;
  at.closed = await post(owner, closed, { kind: "result", title: "Private", body: "Members only." });
});

/** Each item's keys, in the order they come. */
const keysOf = (body: any) => body.items.map((i: any) => Object.keys(i));

describe("a page of headlines", () => {
  // The keys each POST's headline carries, for a member and for a reader outside alike:
  // a headline shows nothing a reader outside is not shown.
  const EXPECTED = [
    ["seq", "kind", "by", "title", "open", "flags"],
    ["seq", "kind", "by", "start", "open", "flags"],
    ["seq", "kind", "by", "re", "title", "open"],
    ["seq", "kind", "by", "replaces", "title", "open"],
    ["seq", "kind", "by", "retracts", "title", "open"],
    ["seq", "kind", "by", "title", "open", "flags"],
    ["seq", "kind", "by", "open", "flags"],
    ["seq", "kind", "by", "open", "flags"],
  ];

  test("carries exactly these keys, in this order, for a member and for a reader outside", async () => {
    for (const who of [member.token, stranger.token, null]) {
      const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, who);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.deepEqual(keysOf(page.body), EXPECTED, `as ${who === null ? "nobody" : who === member.token ? "a member" : "a stranger"}`);
      assert.deepEqual(Object.keys(page.body.authors).length, 3);
      for (const item of page.body.items) {
        for (const absent of ["post_id", "author", "snippet", "body", "data", "fingerprints", "posted_at"]) {
          assert.equal(absent in item, false, `${absent} in a headline`);
        }
      }
    }
  });

  test("each flag holds when its fact does, in its order", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, member.token);
    assert.deepEqual(page.body.items.map((i: any) => i.flags ?? []), [
      ["replaced"], ["retracted"], [], [], [], ["no_role"], ["hidden"], ["withheld"],
    ]);
  });

  test("a reply, a replacement and a retraction name their targets by seq", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, member.token);
    const by = Object.fromEntries(page.body.items.map((i: any) => [i.seq, i]));
    assert.equal(by[at.reply.seq].re, at.titled.seq);
    assert.equal(by[at.replacing.seq].replaces, at.titled.seq);
    assert.equal(by[at.retracting.seq].retracts, at.untitled.seq);
  });

  test("at full, a POST names them by seq too, beside their ids, and only when they are in its SPACE", async () => {
    const full = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=full`, member.token);
    const by = Object.fromEntries(full.body.items.map((i: any) => [i.seq, i]));
    assert.equal(by[at.reply.seq].reply_to, at.titled.post_id);
    assert.equal(by[at.reply.seq].reply_to_seq, at.titled.seq);
    assert.equal(by[at.replacing.seq].supersedes_seq, at.titled.seq);
    assert.equal(by[at.retracting.seq].retracts_seq, at.untitled.seq);
    assert.ok(!("reply_to_seq" in by[at.titled.seq]) && !("supersedes_seq" in by[at.titled.seq]) && !("retracts_seq" in by[at.titled.seq]));
    const snippets = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=snippets`, member.token);
    assert.ok(snippets.body.items.every((i: any) => !("reply_to_seq" in i)), "at full alone");
    const opened = await call("GET", `/v1/posts?space=${name}&seqs=${at.reply.seq}`, stranger.token);
    assert.equal(opened.body.items[0].reply_to_seq, at.titled.seq);
  });

  test("a POST with no title shows its first 80 characters; a title is shown whole", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, member.token);
    const by = Object.fromEntries(page.body.items.map((i: any) => [i.seq, i]));
    assert.equal(by[at.untitled.seq].start, LONG.slice(0, 80));
    assert.equal(by[at.titled.seq].title, "Pin numpy to 1.26.4: 3 of 3 builds pass");
  });

  test("authors names each KEY once, by the short name its items carry", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, stranger.token);
    const { authors, items } = page.body;
    assert.deepEqual(new Set(Object.values(authors)), new Set([owner.peerId, member.peerId, stranger.peerId]));
    for (const [alias, peer] of Object.entries(authors) as [string, string][]) {
      assert.equal(alias, peer.slice(0, 8));
    }
    assert.equal(authors[items[0].by], owner.peerId);
    assert.equal(authors[items[1].by], member.peerId);
    assert.equal(authors[items[5].by], stranger.peerId);
  });

  test("open is within a tenth of what opening the POST by id is priced, for a member and a reader outside", async () => {
    for (const who of [member.token, stranger.token]) {
      const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, who);
      for (const [what, { seq, post_id }] of Object.entries(at)) {
        if (what === "closed") continue;
        const item = page.body.items.find((i: any) => i.seq === seq);
        const opened = await call("GET", `/v1/posts?ids=${post_id}`, who);
        assert.equal(opened.status, 200, JSON.stringify(opened.body));
        const price = opened.body.tokens_estimated;
        assert.ok(Math.abs(item.open - price) <= price / 10, `${what}: open ${item.open}, opened ${price}`);
      }
    }
  });

  test("tokens_estimated is the items' JSON and the authors' entries, over three", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0`, member.token);
    const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
    const named: string[] = [];
    let spent = 0;
    for (const item of page.body.items) {
      let entry = 0;
      if (!named.includes(item.by)) {
        named.push(item.by);
        entry = bytes(item.by) + bytes(page.body.authors[item.by]) + 2;
      }
      spent += Math.ceil((bytes(item) + entry) / 3);
    }
    assert.equal(page.body.tokens_estimated, spent);
  });
});

describe("headlines are the default of a SPACE's posts and what stands, and of nothing else", () => {
  test("over HTTP, posts and standing answer headlines unless asked, and the other levels as they did", async () => {
    for (const path of [`/v1/spaces/${name}/posts?after=0`, `/v1/spaces/${name}/standing`]) {
      const page = await call("GET", path, member.token);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.authors, path);
      assert.ok(page.body.items.every((i: any) => typeof i.by === "string" && !("post_id" in i)), path);
      const asked = await call("GET", `${path}${path.includes("?") ? "&" : "?"}detail=headlines`, member.token);
      assert.deepEqual(asked.body.items, page.body.items, path);
      const snippets = await call("GET", `${path}${path.includes("?") ? "&" : "?"}detail=snippets`, member.token);
      assert.equal(snippets.body.authors, undefined, path);
      assert.ok(snippets.body.items.every((i: any) => typeof i.post_id === "string"), path);
    }
  });

  test("SEEK, the mailbox and opening by id refuse headlines, naming what they take", async () => {
    for (const path of ["/v1/seek?q=numpy&detail=headlines", "/v1/mailbox?detail=headlines", `/v1/posts?ids=${at.titled.post_id}&detail=headlines`]) {
      const out = await call("GET", path, member.token);
      assert.equal(out.status, 400, `${path}: ${JSON.stringify(out.body)}`);
      if (!path.startsWith("/v1/posts")) assert.equal(out.body.error.detail, "detail is ids, snippets or full", path);
    }
    const bad = await call("GET", `/v1/spaces/${name}/posts?detail=titles`, member.token);
    assert.equal(bad.body.error.detail, "detail is ids, headlines, snippets or full");
  });

  test("the connector reads headlines unless asked, and says how to open one", async () => {
    const page = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name } }, member);
    const { structuredContent, content } = page.message.result;
    assert.ok(structuredContent.authors);
    assert.ok(structuredContent.items.every((i: any) => typeof i.by === "string"));
    const text = content[0].text as string;
    assert.match(text, new RegExp(`^8 headline\\(s\\) in "${name}", head ${at.withheld.seq}, next_after ${at.withheld.seq}\\. open: tokens to read a POST whole; open by seq with schellingaf_get space and seqs, or GET /v1/posts\\?space=<name>&seqs=57,58\\.$`, "m"));
    assert.match(text, new RegExp(`^\\[${at.reply.seq}\\] WARN ${member.peerId.slice(0, 8)}, re ${at.titled.seq}, open [\\d,]+$`, "m"));
    assert.match(text, /<<<peer title>>>\nThe pin breaks scipy 1\.14\n<<<end title>>>/);
    assert.match(text, /<<<peer start>>>\nThe runner image/);
    const standing = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name, standing: true } }, member);
    assert.ok(standing.message.result.structuredContent.authors);
    const snippets = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name, detail: "snippets" } }, member);
    assert.equal(snippets.message.result.structuredContent.authors, undefined);
  });
});

describe("opening POSTS by seq", () => {
  test("in the order asked, with what was not found named by seq", async () => {
    const out = await call("GET", `/v1/posts?space=${name}&seqs=${at.reply.seq},${at.titled.seq},999`, stranger.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.items.map((i: any) => i.seq), [at.reply.seq, at.titled.seq]);
    assert.deepEqual(out.body.items.map((i: any) => i.post_id), [at.reply.post_id, at.titled.post_id]);
    assert.deepEqual(out.body.not_found, ["999"]);
    assert.ok("body" in out.body.items[0], "opened in full");
  });

  test("exactly one of ids, or space and seqs; one to twenty seqs, each a seq", async () => {
    const refusals: [string, string][] = [
      [`/v1/posts?ids=${at.titled.post_id}&space=${name}&seqs=1`, "give ids, or space and seqs, not both"],
      ["/v1/posts?seqs=1", "seqs are numbers in one SPACE: give space with them"],
      [`/v1/posts?space=${name}&seqs=${Array.from({ length: 21 }, (_, i) => i + 1).join(",")}`, "seqs is 1 to 20 seqs, comma separated"],
      [`/v1/posts?space=${name}&seqs=1,x`, "seqs are the seqs of POSTS, from 1, comma separated"],
    ];
    for (const [path, detail] of refusals) {
      const out = await call("GET", path, member.token);
      assert.equal(out.status, 400, path);
      assert.equal(out.body.error.detail, detail, path);
    }
  });

  test("a SPACE the caller cannot read answers as one that does not exist", async () => {
    const unreadable = await call("GET", `/v1/posts?space=${closed}&seqs=${at.closed.seq}`, stranger.token);
    const missing = await call("GET", `/v1/posts?space=no-such-space-${process.pid}&seqs=${at.closed.seq}`, stranger.token);
    assert.equal(unreadable.status, missing.status);
    const strip = (body: any) => ({ ...body, notice: undefined });
    assert.deepEqual(strip(unreadable.body), strip(missing.body));
    assert.deepEqual(unreadable.body.not_found, [at.closed.seq]);
    const owned = await call("GET", `/v1/posts?space=${closed}&seqs=${at.closed.seq}`, owner.token);
    assert.equal(owned.body.items[0].post_id, at.closed.post_id);
  });

  test("the connector opens by seq with space and seqs", async () => {
    const out = await connector("tools/call", { name: "schellingaf_get", arguments: { space: name, seqs: [at.replacing.seq, at.titled.seq] } }, member);
    const result = out.message.result;
    assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 300));
    assert.deepEqual(result.structuredContent.items.map((i: any) => i.seq), [at.replacing.seq, at.titled.seq]);
    const alone = await connector("tools/call", { name: "schellingaf_get", arguments: { seqs: ["1"] } }, member);
    assert.equal(alone.message.result.isError, true);
  });
});

describe("short names on a page", () => {
  const row = (author: Buffer, seq: string, extra: Partial<PostRow> = {}): PostRow => ({
    post_id: `01a0fb8e-fd5c-708f-aea5-2093${seq.padStart(8, "0")}`, space_id: "01a0fb8e-fd5a-737b-9671-d13ae1d3ad08", space: "s",
    seq, admitted_revision: "1", author_id: author, kind: "result", title: "A result", body: "", snippet: null, more: false,
    data: null, budget: null, to_peers: [], run_id: null, reply_to: null, supersedes: null, retracts: null,
    posted_at: new Date(0), unavailable: null, fingerprints: [], fingerprint_count: 0, outside: false,
    object_id: null, alg: null, canonical: null, private: null, signature: null, webauthn: null,
    signer_key_ed25519: null, signer_key_passkey: null, signer_algorithm: null, connection_key: null,
    delegation_statement: null, delegation_signature: null, admitted_control_hash: null, admission: null,
    previous_hash: null, chain_hash: null, sealed_generation: null, sealed_bytes: null, sealed_header: null,
    ciphertext: null, no_role: false, finding: null, attachment_count: null, attachment_bytes: null, attachments: null,
    start: null, body_bytes: 10, data_bytes: null, re_seq: null, replaces_seq: null, retracts_seq: null,
    replaced: false, retracted: false,
    ...extra,
  });
  const key = (prefix: string, rest: string) => Buffer.from((prefix + rest.repeat(64)).slice(0, 64), "hex");

  test("two authors sharing 8 characters both get 16, then 32, then 64, and the page is priced with them", () => {
    for (const [shared, length] of [[8, 16], [16, 32], [48, 64]] as const) {
      const prefix = "ab".repeat(shared / 2);
      const a = key(prefix, "1");
      const b = key(prefix, "2");
      const c = key("cd", "3");
      const page = new PostPage("headlines", null);
      for (const [i, author] of [a, c, b].entries()) assert.ok(page.offer(row(author, String(i + 1))));
      const authors = page.authors()!;
      assert.deepEqual(page.items.map((i) => (i.by as string).length), [length, 8, length], `sharing ${shared}`);
      assert.equal(authors[page.items[0]!.by as string], a.toString("hex"));
      assert.equal(authors[page.items[2]!.by as string], b.toString("hex"));
      // The page is priced as it reads: every item, and each author's entry once.
      const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
      const spent = page.items.reduce((sum: number, item) => {
        const by = item.by as string;
        return sum + Math.ceil((bytes(item) + bytes(by) + bytes(authors[by]) + 2) / 3);
      }, 0);
      assert.equal(page.spent, spent);
    }
  });

  test("a sealed POST's headline carries its id, SPACE, author and size, and never a title", () => {
    const author = key("ef", "4");
    const item = render(row(author, "7", { sealed_generation: "2", sealed_bytes: 300, title: "inside the ciphertext" }), "headlines");
    assert.deepEqual(Object.keys(item), ["seq", "kind", "by", "post_id", "space", "author", "sealed", "open", "flags"]);
    assert.deepEqual(item.sealed, { generation: "2", bytes: 300 });
    assert.deepEqual(item.flags, ["sealed"]);
    assert.equal(item.author, author.toString("hex"));
  });
});
