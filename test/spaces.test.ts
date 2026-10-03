// A SPACE's life outside the permission matrix: the names it may take, a code on
// its list, posting and reading, filters, the wire's two kinds of number, batch
// reads and export, the pages a person reads, a PEER's profile, and the welcome
// SPACE's name. Who may do what is test/permissions.test.ts; what a refusal gives
// away is test/leaks.test.ts.

import { createHash } from "node:crypto";
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, db, fixture, call, agent, type Agent } from "./lib/service.ts";
import type { Sql } from "postgres";
import { appendPost } from "../src/http/append.ts";
import { publicSeekablePerDay } from "../src/http/postview.ts";
import { LIMITS, OPEN_POSTS_PER_SPACE_PER_DAY, OWN, type Bucket } from "../src/http/ratelimit.ts";
import { CREATE_MEMBERS, FINISHED_STAGES, ORACLE_LIMITS, STAGE_LIMITS, STAGE_WORD, TASK_LIMITS } from "../src/surface/vocabulary.ts";

useService("spaces");

describe("creating a SPACE", () => {
  test("a name the service keeps is refused, whoever asks first", async () => {
    // Names that would let an agent pass as the service, its operator or its money,
    // and the names a welcome SPACE may take, which the registration grant finds by
    // name (see "the welcome SPACE's name cannot be taken" below).
    const a = await agent();
    for (const name of [
      "payments", "admin", "schellingaf-internal", "operator", "credits",
      "welcome", "hello", "intro", "readme", "start", "my-work",
    ]) {
      const out = await call("POST", "/v1/spaces", a, { name, title: "mine now" });
      assert.equal(out.body.error?.code, "NAME_RESERVED", `an agent created "${name}"`);
    }
  });

  test("a name that is taken says so, rather than failing as a database error", async () => {
    const a = await agent();
    assert.equal((await call("POST", "/v1/spaces", a, { name: "taken-name", title: "T" })).status, 201);
    const again = await call("POST", "/v1/spaces", await agent(), { name: "taken-name", title: "T" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "SPACE_NAME_TAKEN");
  });
});

describe("a code works in its own SPACE, and the list never shows it again", () => {
  let owner: Agent;
  let outsider: Agent;
  let code: string;

  before(async () => {
    owner = await agent();
    outsider = await agent();
    await call("POST", "/v1/spaces", owner, { name: "code-space", title: "Codes", join_policy: "invite" });
  });

  test("the code appears exactly once: the list returns neither it nor its hash", async () => {
    const out = await call("POST", "/v1/spaces/code-space/invites", owner, {
      role: "writer",
      max_uses: 2,
      label: "for the second session",
    });
    assert.equal(out.status, 201);
    code = out.body.code;

    const listed = await call("GET", "/v1/spaces/code-space/invites", owner);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].code, undefined);
    assert.equal(listed.body.items[0].code_hash, undefined);
    assert.equal(listed.body.items[0].active, true);
    assert.equal(listed.body.items[0].label, "for the second session");
  });

  test("a revoked code is refused, and the list says why it is dead", async () => {
    const minted = await call("POST", "/v1/spaces/code-space/invites", owner, { role: "reader" });
    await call("DELETE", `/v1/invites/${minted.body.invite_id}`, owner);

    const out = await call("POST", "/v1/spaces/code-space/join", outsider, { code: minted.body.code });
    assert.equal(out.body.error.code, "INVITE_REVOKED");

    const listed = await call("GET", "/v1/spaces/code-space/invites", owner);
    const dead = listed.body.items.find((i: any) => i.invite_id === minted.body.invite_id);
    assert.equal(dead.active, false);
    assert.equal(dead.inactive_reason, "revoked");
  });

  test("a code for one SPACE is not a code for another", async () => {
    await call("POST", "/v1/spaces", owner, { name: "other-space", title: "Other" });
    const out = await call("POST", "/v1/spaces/other-space/join", outsider, { code });
    // Uniform with an unknown code: an outsider must not learn that a code
    // exists somewhere else.
    assert.equal(out.body.error.code, "INVITE_INVALID");
  });
});

describe("posting and reading", () => {
  let owner: Agent;
  let writer: Agent;
  let reader: Agent;
  let firstPost: string;

  before(async () => {
    owner = await agent();
    writer = await agent();
    reader = await agent();
    await call("POST", "/v1/spaces", owner, { name: "work-space", title: "Work" });
    await call("PUT", `/v1/spaces/work-space/members/${writer.peerId}`, owner, { role: "writer" });
    await call("PUT", `/v1/spaces/work-space/members/${reader.peerId}`, owner, { role: "reader" });
  });

  test("a post answers with its position", async () => {
    const out = await call("POST", "/v1/spaces/work-space/posts", owner, {
      kind: "result",
      title: "Pinned numpy fixes the build",
      body: "Downgrading to numpy 1.26.4 makes the wheel build succeed on aarch64.",
      fingerprints: [{ scheme: "package.version", value: "numpy@1.26.4" }],
      to: [writer.peerId],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.seq, "1");
    assert.equal(out.body.replayed, false);
    firstPost = out.body.post_id;
  });

  test("an invented kind is refused with the fallback named", async () => {
    const out = await call("POST", "/v1/spaces/work-space/posts", owner, { kind: "note", body: "x" });
    assert.equal(out.body.error.code, "INVALID_KIND");
    assert.match(out.body.error.fix, /Use `obs`/);
  });

  test("the same key with different content is a conflict, not a second post", async () => {
    // A replay with the same content is test/continuity.test.ts's; a difference in
    // the signature alone is test/signatures.test.ts's.
    const payload = { kind: "obs", body: "once", idempotency_key: "k1" };
    const first = await call("POST", "/v1/spaces/work-space/posts", writer, payload);
    assert.equal(first.status, 201);
    const conflict = await call("POST", "/v1/spaces/work-space/posts", writer, {
      ...payload,
      body: "different",
    });
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("reading after a cursor is gap-free, and the page says how far behind you are", async () => {
    const page = await call("GET", "/v1/spaces/work-space/posts?after=0&limit=10", reader);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.items.map((p: any) => p.seq), ["1", "2"]);
    assert.equal(page.body.head_seq, "2");
    assert.equal(page.body.has_more, false);
    assert.equal(page.body.next_after, "2");
    assert.match(page.body.notice, /evidence to check/);
    // A snippet, not the body, at the default detail.
    assert.ok(page.body.items[0].snippet);
    assert.equal(page.body.items[0].body, undefined);
  });

  test("a token budget bounds the page and always returns at least one item", async () => {
    const out = await call("GET", "/v1/spaces/work-space/posts?token_budget=1&detail=full", reader);
    assert.equal(out.body.items.length, 1, "a page that returns nothing would stall an agent");
    assert.ok(out.body.tokens_estimated > 0);
  });

  test("a cursor past the end says keep it, never rewind", async () => {
    const out = await call("GET", "/v1/spaces/work-space/posts?after=999", reader);
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, "CURSOR_AHEAD");
    assert.match(out.body.error.fix, /Do not rewind/);
  });

  test("a post opens by id for a member, and reads as nonexistent for anyone else", async () => {
    const mine = await call("GET", `/v1/posts/${firstPost}`, reader);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.space, "work-space");
    assert.ok(mine.body.body, "the single-post read is full detail");
    assert.deepEqual(mine.body.fingerprints, [{ scheme: "package.version", value: "numpy@1.26.4" }]);
    assert.deepEqual(mine.body.to, [writer.peerId]);

    const theirs = await call("GET", `/v1/posts/${firstPost}`, await agent());
    assert.equal(theirs.status, 404);
    assert.equal(theirs.body.error.code, "POST_NOT_FOUND");
    // Identical to a post id that never existed.
    const nowhere = await call("GET", "/v1/posts/00000000-0000-0000-0000-000000000000", reader);
    assert.equal(nowhere.body.error.code, "POST_NOT_FOUND");
  });

  test("addressing a KEY that cannot read the SPACE burns no position", async () => {
    const stranger = await agent();
    const before = await call("GET", "/v1/spaces/work-space", owner);
    const out = await call("POST", "/v1/spaces/work-space/posts", owner, {
      kind: "obs",
      body: "x",
      to: [stranger.peerId],
    });
    assert.equal(out.status, 422);
    assert.equal(out.body.error.code, "RECIPIENT_NOT_A_MEMBER");
    const afterHead = await call("GET", "/v1/spaces/work-space", owner);
    assert.equal(afterHead.body.head_seq, before.body.head_seq, "a refused post must not move the counter");
  });
});

describe("filters that are offered must actually filter", () => {
  // A query parameter the reference names and the connector tool offers, but
  // which the route ignores, is worse than one that errors: an agent asking for
  // one thread quietly receives the whole SPACE and cannot tell.
  test("reply_to narrows a read to one thread, and a bad one is refused", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, { name: "thread-space", title: "Threads" });
    const root = await call("POST", "/v1/spaces/thread-space/posts", owner, {
      kind: "question",
      body: "Which meson does the runner have?",
    });
    await call("POST", "/v1/spaces/thread-space/posts", owner, {
      kind: "result",
      body: "1.2, which is too old.",
      reply_to: root.body.post_id,
    });
    await call("POST", "/v1/spaces/thread-space/posts", owner, {
      kind: "obs",
      body: "unrelated to the thread",
    });

    const all = await call("GET", "/v1/spaces/thread-space/posts", owner);
    assert.equal(all.body.items.length, 3);

    const thread = await call(
      `GET`,
      `/v1/spaces/thread-space/posts?reply_to=${root.body.post_id}`,
      owner,
    );
    assert.equal(thread.body.items.length, 1);
    assert.equal(thread.body.items[0].reply_to, root.body.post_id);

    const bad = await call("GET", "/v1/spaces/thread-space/posts?reply_to=not-a-post", owner);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.detail, /reply_to is a post id/);
  });
});

describe("the wire's two kinds of number", () => {
  // A stream position is a 64-bit number and a JSON number would lose it, so it
  // is a decimal string. A count is small and an agent will do arithmetic on it,
  // so it is a number. Mixing them is how an agent ends up comparing "10" to 9.
  test("positions are strings and counts are numbers, everywhere", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, { name: "number-space", title: "Numbers" });
    const posted = await call("POST", "/v1/spaces/number-space/posts", owner, {
      kind: "obs",
      body: "one",
      fingerprints: [
        { scheme: "git.commit", value: "aaaaaaaaaaaa" },
        { scheme: "sha256.file", value: "b".repeat(64) },
      ],
    });
    await call("POST", "/v1/spaces/number-space/posts", owner, {
      kind: "obs",
      body: "a reply",
      reply_to: posted.body.post_id,
    });

    const page = await call("GET", "/v1/spaces/number-space/posts", owner);
    assert.equal(typeof page.body.head_seq, "string");
    assert.equal(typeof page.body.items[0].seq, "string");
    assert.equal(typeof page.body.items[0].fingerprint_count, "number");
    assert.equal(page.body.items[0].fingerprint_count, 2);

    const one = await call("GET", `/v1/posts/${posted.body.post_id}`, owner);
    assert.equal(typeof one.body.reply_count, "number");
    assert.equal(one.body.reply_count, 1);
    assert.equal(typeof one.body.admitted_revision, "string");

    const mailbox = await call("GET", "/v1/mailbox", owner);
    assert.equal(typeof mailbox.body.head_seq, "string");

    const profile = await call("GET", "/v1/spaces/number-space", owner);
    assert.equal(typeof profile.body.head_seq, "string");
    assert.equal(typeof profile.body.member_count, "number");
  });
});

describe("opening several posts at once, and taking a copy", () => {
  let owner: Agent;
  let outsider: Agent;
  let ids: string[];

  before(async () => {
    owner = await agent();
    outsider = await agent();
    await call("POST", "/v1/spaces", owner, { name: "copy-space", title: "Copies" });
    ids = [];
    for (let i = 0; i < 5; i++) {
      const posted = await call("POST", "/v1/spaces/copy-space/posts", owner, {
        kind: i === 2 ? "dossier" : "obs",
        title: `Post ${i}`,
        body: `body ${i}, long enough to be worth opening`.padEnd(300, " ."),
        fingerprints: [{ scheme: "task.reference", value: `copy-${i}` }],
        data: { attribution: [] },
      });
      ids.push(posted.body.post_id);
    }
  });

  test("a batch read returns them in the order asked for", async () => {
    const wanted = [ids[3]!, ids[0]!, ids[4]!];
    const out = await call("GET", `/v1/posts?ids=${wanted.join(",")}`, owner);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items.map((p: any) => p.post_id), wanted);
    assert.deepEqual(out.body.not_found, []);
    assert.ok(out.body.items[0].body, "a batch read is full detail by default");
  });

  test("a budget too small still returns one, and names what it left out", async () => {
    // Two lists, because the fixes differ: ask again with a larger budget, or
    // stop asking for an id that is not yours.
    const out = await call("GET", `/v1/posts?ids=${ids.join(",")}&token_budget=1`, owner);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.not_included.length, 4);
    assert.deepEqual(out.body.not_found, []);
  });

  test("more than twenty ids is refused rather than silently cut", async () => {
    const many = Array.from({ length: 21 }, () => ids[0]!).join(",");
    const out = await call(`GET`, `/v1/posts?ids=${many}`, owner);
    assert.equal(out.status, 400);
    assert.match(out.body.error.detail, /1 to 20/);
  });

  test("export is one JSON object per line, ending in a versioned trailer", async () => {
    const res = await app.request("/v1/spaces/copy-space/posts?after=0", {
      headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/x-ndjson" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

    const raw = (await res.text()).trim().split("\n");
    const lines = raw.map((l) => JSON.parse(l));
    assert.equal(lines.length, 6, "five posts and a trailer");

    // Lossless: a mirror built from snippets would drop bodies, and fingerprints
    // nine to thirty-two would be write-only forever.
    for (const item of lines.slice(0, 5)) {
      assert.ok(item.body, "every exported line carries its body");
      assert.ok(item.space_id, "and the identifiers a mirror needs");
      assert.ok(item.fingerprints.length > 0);
      assert.equal(item.cursor, undefined, "an item line never carries a cursor key");
    }

    // Version 2: every line carries the proof a mirror verifies it by, and the
    // trailer hashes the lines, so a line altered in transit or at rest shows.
    for (const item of lines.slice(0, 5)) {
      assert.match(item.proof.object_id, /^[0-9a-f]{64}$/, "every exported line carries its object id");
      assert.ok(item.proof.canonical, "and the object's bytes");
      assert.match(item.proof.chain.chain_hash, /^[0-9a-f]{64}$/, "and its link");
    }
    for (let i = 1; i < 5; i++) {
      assert.equal(lines[i].proof.chain.previous_hash, lines[i - 1].proof.chain.chain_hash, "each link names the one before it");
    }
    const trailer = lines[5];
    assert.equal(trailer.export.format, "schellingaf-ndjson");
    assert.equal(trailer.export.version, 2);
    assert.equal(trailer.export.name, "copy-space");
    assert.equal(trailer.export.signatures, "per-post");
    const body = raw.slice(0, 5).map((l) => `${l}\n`).join("");
    assert.equal(trailer.export.segment_sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(trailer.cursor.head_seq, "5");
    assert.equal(trailer.cursor.has_more, false);
    assert.match(trailer.notice, /without this trailer was truncated/);
  });

  test("export honours the cursor and the kind filter", async () => {
    const res = await app.request("/v1/spaces/copy-space/posts?after=2&kind=dossier", {
      headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/x-ndjson" },
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, "dossier");
    assert.equal(lines[0].seq, "3");
  });

  test("a page kept to one kind says there is more only when there may be", async () => {
    // Not whenever its last post is below the head, which counts every kind: the
    // last page of one kind would lead to an empty one.
    const read = async (q: string) => (await (await app.request(`/v1/spaces/copy-space/posts?${q}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })).json()) as any;
    const every = await read("kind=dossier");
    assert.ok(every.items.length >= 1);
    assert.equal(every.has_more, false, "the whole of one kind said there was more");
    const full = await read(`kind=dossier&limit=${every.items.length}`);
    assert.equal(full.has_more, true, "a full page may have more");
    const unnarrowed = await read("limit=1");
    assert.equal(unnarrowed.has_more, true);
  });

  test("export refuses the parameters that would make it lossy", async () => {
    for (const query of ["detail=snippets", "token_budget=100", `reply_to=${ids[0]}`, "order=desc"]) {
      const res = await app.request(`/v1/spaces/copy-space/posts?${query}`, {
        headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/x-ndjson" },
      });
      assert.equal(res.status, 400, query);
    }
  });

  test("a stranger exports nothing, by the same refusal as a read", async () => {
    const res = await app.request("/v1/spaces/copy-space/posts", {
      headers: { Authorization: `Bearer ${outsider.token}`, Accept: "application/x-ndjson" },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as any).error.code, "READ_DENIED");
  });
});

describe("the same pages, as text a person can read", () => {
  // This service has no interface, which is right for agents. It must not mean
  // the person who runs it has no way to see what happened, and the honest
  // answer to "what did my agents do yesterday" should not be a JSON blob.
  let owner: Agent;
  let outsider: Agent;

  async function markdown(path: string, who?: Agent) {
    const res = await app.request(path, {
      headers: {
        Accept: "text/markdown",
        ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
      },
    });
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
  }

  before(async () => {
    owner = await agent();
    outsider = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "readable-space",
      title: "What my agents did",
      description: "a space to read with curl",
    });
    await call("POST", "/v1/spaces/readable-space/posts", owner, {
      kind: "result",
      title: "The pin fixes the build",
      body: "numpy 1.26.4 on aarch64.",
      fingerprints: [{ scheme: "git.commit", value: "aabbccddeeff" }],
    });
  });

  test("a space's stream reads as prose, with what agents wrote fenced", async () => {
    const out = await markdown("/v1/spaces/readable-space/posts", owner);
    assert.equal(out.status, 200);
    assert.match(out.type, /text\/markdown/);
    assert.match(out.text, /^reading as [0-9a-f]{64}/);
    assert.match(out.text, /\[1\] RESULT by [0-9a-f]{64}/);
    // The fences are as useful to a person judging a claim as to a model.
    assert.match(out.text, /<<<peer title>>>\nThe pin fixes the build\n<<<end title>>>/);
    assert.match(out.text, /<<<peer fingerprints>>>\ngit\.commit:aabbccddeeff/);
  });

  test("every read that has a rendering offers one", async () => {
    for (const path of [
      "/v1/spaces?q=agents",
      "/v1/spaces/readable-space",
      "/v1/spaces/readable-space/posts",
      "/v1/spaces/readable-space/members",
      "/v1/spaces/readable-space/events",
      "/v1/spaces/readable-space/invites",
      "/v1/spaces/readable-space/requests",
      "/v1/mailbox",
      "/v1/seek?q=numpy",
    ]) {
      const out = await markdown(path, owner);
      assert.match(out.type, /text\/markdown/, `${path} did not render`);
      assert.doesNotMatch(out.text, /^\{/, `${path} returned JSON`);
    }
  });

  test("without the header it is still JSON, and nothing changed", async () => {
    const json = await call("GET", "/v1/spaces/readable-space/posts", owner);
    assert.equal(json.body.items.length, 1);
    assert.equal(json.body.head_seq, "1");
  });

  test("a refusal stays JSON, because a code is what an agent acts on", async () => {
    const out = await markdown("/v1/spaces/readable-space/posts", outsider);
    assert.equal(out.status, 403);
    assert.match(out.type, /application\/json/);
    assert.match(out.text, /READ_DENIED/);
  });

  test("it renders what the caller may see, and no more", async () => {
    // The rendering runs on the response the route built, so it cannot widen
    // what a route decided. Worth stating as a test all the same.
    const out = await markdown("/v1/spaces/readable-space", outsider);
    assert.equal(out.status, 200);
    assert.match(out.text, /reading as [0-9a-f]{64}/);
    assert.doesNotMatch(out.text, /The pin fixes the build/);
    assert.doesNotMatch(out.text, /head \d/, "a stranger must not see the counters");
  });
});

describe("a list hands back a cursor only while there may be more", () => {
  test("a full page names where it ended, and the last page names nothing", async () => {
    const owner = await agent();
    for (const name of ["pagedlist-one", "pagedlist-two"]) {
      const made = await call("POST", "/v1/spaces", owner, { name, title: "pagedlistword", join_policy: "request" });
      assert.equal(made.status, 201, JSON.stringify(made.body));
    }
    for (const role of ["writer", "reader"]) {
      await call("PUT", `/v1/spaces/pagedlist-one/members/${(await agent()).peerId}`, owner, { role });
    }
    for (let i = 0; i < 2; i++) {
      assert.equal((await call("PUT", `/v1/spaces/pagedlist-one/blocks/${(await agent()).peerId}`, owner)).status, 200);
      assert.equal((await call("POST", "/v1/spaces/pagedlist-one/invites", owner, { role: "reader" })).status, 201);
      assert.equal((await call("POST", "/v1/spaces/pagedlist-one/join", await agent(), { message: "may I" })).status, 202);
    }

    // Each list, the key its cursor is named by, and the field each item carries it in.
    const lists: [string, "next_after" | "next_before", (item: any) => string][] = [
      ["/v1/spaces?q=pagedlistword", "next_after", (s) => s.name],
      ["/v1/spaces?q=pagedlistword&order=recent", "next_before", (s) => s.name],
      ["/v1/spaces/pagedlist-one/members", "next_after", (m) => m.peer_id],
      ["/v1/spaces/pagedlist-one/blocks", "next_after", (b) => b.peer_id],
      ["/v1/spaces/pagedlist-one/invites", "next_after", (i) => i.invite_id],
      ["/v1/spaces/pagedlist-one/requests", "next_after", (r) => r.request_id],
    ];
    for (const [path, key, id] of lists) {
      const glue = path.includes("?") ? "&" : "?";
      const full = await call("GET", `${path}${glue}limit=1`, owner);
      assert.equal(full.status, 200, `${path}: ${JSON.stringify(full.body)}`);
      assert.equal(full.body.has_more, true, path);
      assert.ok(String(full.body[key]).endsWith(id(full.body.items[0])), `${path}: a full page names where it ended`);
      const last = await call("GET", `${path}${glue}limit=200`, owner);
      assert.equal(last.body.items.length, 2, path);
      assert.deepEqual([last.body.has_more, last.body[key]], [false, null], `${path}: the last page names nothing`);
    }
  });
});

describe("who a PEER is", () => {
  test("its key and the SPACES it owns, and nothing about what it has done", async () => {
    const subject = await agent();
    const asker = await agent();
    await call("POST", "/v1/spaces", subject, { name: "owned-space", title: "Owned" });
    // A private space the asker cannot see, which must not appear.
    const elsewhere = await agent();
    await call("POST", "/v1/spaces", elsewhere, { name: "hidden-space", title: "Hidden" });
    await call("PUT", `/v1/spaces/hidden-space/members/${subject.peerId}`, elsewhere, { role: "writer" });
    await call("POST", "/v1/spaces/hidden-space/posts", subject, { kind: "obs", body: "private work" });

    const out = await call(`GET`, `/v1/peers/${subject.peerId}`, asker);
    assert.equal(out.status, 200);
    assert.equal(out.body.peer_id, subject.peerId);
    assert.match(out.body.public_key, /^[0-9a-f]{64}$/);
    assert.deepEqual(out.body.spaces_owned, ["owned-space"]);
    assert.equal(out.body.blocked, false);
    // The SPACES it owns come a page at a time, by name, and after names where the last
    // page ended.
    assert.equal(out.body.has_more, false);
    assert.equal(out.body.next_after, null);
    const past = await call("GET", `/v1/peers/${subject.peerId}?after=owned-space`, asker);
    assert.deepEqual(past.body.spaces_owned, []);
    assert.equal((await call("GET", `/v1/peers/${subject.peerId}?after=NOT_A_NAME`, asker)).body.error.code, "INVALID_REQUEST");

    // The memberships are the leak this route would be: they would say which
    // private spaces a KEY is in, to anybody holding its id.
    assert.equal(JSON.stringify(out.body).includes("hidden-space"), false);
    for (const key of ["memberships", "spaces", "last_post_at", "post_count", "active", "tokens"]) {
      assert.equal(out.body[key], undefined, `a peer profile reported ${key}`);
    }
  });

  test("a SPACE it closed leaves the listing and the profile together", async () => {
    // Discovery, search and the owner's public profile agree about a closed
    // SPACE, so it is not enumerable through anybody's id. What closing takes
    // away is being listed; the SPACE's own profile is still served by name.
    const subject = await agent();
    const asker = await agent();
    await call("POST", "/v1/spaces", subject, { name: "retired-space", title: "Retired" });
    await call("POST", "/v1/spaces", subject, { name: "live-space", title: "Live" });
    // The only way in: no HTTP path closes a SPACE, by design. This is what
    // runbooks/restore.md section 5 does.
    await fixture.owner`update schellingaf.spaces set status = 'closed' where name = 'retired-space'`;

    const listed = await call("GET", "/v1/spaces?limit=200", asker);
    const names = listed.body.items.map((i: any) => i.name);
    assert.equal(names.includes("live-space"), true);
    assert.equal(names.includes("retired-space"), false, "a closed SPACE was still listed");

    const profile = await call("GET", `/v1/peers/${subject.peerId}`, asker);
    assert.deepEqual(
      profile.body.spaces_owned,
      ["live-space"],
      "a closed SPACE stayed enumerable through its owner's profile",
    );

    // Still there for anybody who knows the name, complete with its status.
    const named = await call("GET", "/v1/spaces/retired-space", asker);
    assert.equal(named.status, 200);
    assert.equal(named.body.status, "closed");

    // And its owner keeps seeing it, because it is the owner's own space.
    const mine = await call("GET", "/v1/me", subject);
    assert.equal(mine.body.spaces_owned.includes("retired-space"), true, "the owner lost sight of its own space");
  });

  test("a SPACE the operator withheld leaves the profile too, and comes back when released", async () => {
    // The listing and the owner's profile agree about a withheld SPACE, whose own
    // profile keeps nothing but the name. This profile is rendered on a page
    // search engines list.
    const subject = await agent();
    const asker = await agent();
    await call("POST", "/v1/spaces", subject, { name: "withheld-space", title: "Withheld" });
    await call("POST", "/v1/spaces", subject, { name: "kept-space", title: "Kept" });
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select space_id, 'abuse', 'test' from schellingaf.spaces where name = 'withheld-space'`;

    const listed = await call("GET", "/v1/spaces?limit=200", asker);
    assert.equal(listed.body.items.some((i: any) => i.name === "withheld-space"), false);
    const profile = await call("GET", `/v1/peers/${subject.peerId}`, asker);
    assert.deepEqual(profile.body.spaces_owned, ["kept-space"], "a withheld SPACE stayed named on its owner's profile");

    await fixture.owner`
      update schellingaf.withheld_spaces set released_at = now()
       where space_id = (select space_id from schellingaf.spaces where name = 'withheld-space')`;
    const released = await call("GET", `/v1/peers/${subject.peerId}`, asker);
    assert.deepEqual(released.body.spaces_owned, ["kept-space", "withheld-space"]);
  });

  test("a KEY that does not exist, and a malformed id, answer the same", async () => {
    const asker = await agent();
    const missing = await call(`GET`, `/v1/peers/${"ab".repeat(32)}`, asker);
    const malformed = await call("GET", "/v1/peers/not-a-peer-id", asker);
    assert.equal(missing.body.error.code, "PEER_NOT_FOUND");
    assert.equal(malformed.body.error.code, "PEER_NOT_FOUND");
  });

  test("it needs a KEY, like every other content read", async () => {
    const out = await call(`GET`, `/v1/peers/${"ab".repeat(32)}`, null as never);
    assert.equal(out.status, 401);
  });
});

describe("the welcome SPACE's name cannot be taken", () => {
  // register_peer grants every KEY that registers `reader` on the SPACE named by
  // WELCOME_SPACE, and finds that SPACE by name, so whoever holds the name holds
  // the grant: a SPACE every KEY silently joins, somewhere to write to every agent,
  // a way into any KEY's mailbox as a co-member, and the roster of everyone
  // registered. A welcome SPACE would be filled through the public API, so the
  // service is live and registering KEYS before that SPACE exists. The names it
  // may take are therefore reserved ("a name the service keeps is refused" above),
  // and the service refuses to start pointed at any other.
  test("the service will not start pointed at a name an agent could have", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const before = { ...process.env };
    try {
      // Everything loadConfig demands before it reaches the welcome SPACE, so
      // the failure under test is the one that fires.
      process.env.API_HOST = "api.schellingaf.test";
      process.env.PUBLIC_ORIGIN = "https://api.schellingaf.test";
      process.env.CHALLENGE_KEY = "a-test-challenge-key-not-a-secret";
      process.env.WELCOME_SPACE = "a-name-anyone-could-create";
      assert.throws(
        () => loadConfig(),
        /not a reserved SPACE name/,
        "the service started with a welcome SPACE any agent could have claimed first",
      );
      process.env.WELCOME_SPACE = "welcome";
      // Reserved: this one is allowed through, whatever else loadConfig needs.
      try {
        loadConfig();
      } catch (error) {
        assert.doesNotMatch(String((error as Error).message), /reserved SPACE name/);
      }
    } finally {
      for (const key of ["API_HOST", "PUBLIC_ORIGIN", "CHALLENGE_KEY", "WELCOME_SPACE"]) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });
});

describe("a ready SPACE in one call: members, the document's first version and tasks", () => {
  let n = 0;
  const unique = (prefix: string) => `${prefix}-${process.pid}-${n++}`;
  const DOCUMENT = "# Ready\n\n## Problem\nAgents make a space in ten calls.\n\n## Status\nproposed; the owner of [[proposals]] decides\n";

  /** proposal-many-spaces-at-once's eleven tasks, by key, tag and after, as one batch. */
  const ELEVEN: [string, string, string[]][] = [
    ["t1", "discussion", []], ["t2", "measure", []], ["t3", "specify", ["t1"]], ["t4", "specify", ["t1"]],
    ["t5", "specify", ["t1"]], ["t6", "specify", ["t1"]], ["t7", "privacy", ["t3", "t4", "t5", "t6"]],
    ["t8", "implement", ["t3", "t7"]], ["t9", "implement", ["t4", "t6", "t7"]], ["t10", "implement", ["t5", "t7"]],
    ["t11", "measure", ["t2", "t8", "t9"]],
  ];
  const eleven = () => ELEVEN.map(([key, tag, after]) => ({ key, tag, title: `Task ${key}`, body: `Do ${key}.`, after }));

  /** The rows a create writes, in every table it writes, counted over the whole database. */
  const TABLES = [
    "spaces", "space_events", "space_categories", "memberships", "posts", "post_objects", "post_fingerprints",
    "oracle_versions", "oracle_links", "tasks", "task_adds", "mailbox_deliveries",
  ];
  async function rows(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      const [row] = await fixture.owner.unsafe(`select count(*)::int as n from schellingaf.${table}`);
      out[table] = row!.n;
    }
    return out;
  }
  async function bucket(key: string): Promise<number | null> {
    const [row] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
    return row ? row.tokens : null;
  }
  /** A KEY's four buckets a create spends from, each set to `to`, and then what each spent
   *  since: its balance against what it held, less what refilled between the two writes. */
  async function allowances(who: Agent, to: number) {
    const buckets: Record<string, Bucket> = {
      writes: LIMITS.peerWrites(who.peerId), creations: LIMITS.spaceCreation(who.peerId),
      control: OWN.control(who.peerId), proposals: LIMITS.proposals(who.peerId, true),
    };
    const read = async (b: Bucket) => (await fixture.owner<{ tokens: number; at: number }[]>`
      select tokens, extract(epoch from updated_at)::float8 as at from schellingaf.rate_buckets where key = ${b.key}`)[0]!;
    const set: Record<string, { tokens: number; at: number }> = {};
    for (const [k, b] of Object.entries(buckets)) {
      await fixture.setBucket(b.key, to);
      set[k] = await read(b);
    }
    return async () => {
      const spent: Record<string, number> = {};
      for (const [k, b] of Object.entries(buckets)) {
        const now = await read(b);
        spent[k] = Math.round((Math.min(b.capacity, to + b.refillPerSec * (now.at - set[k]!.at)) - now.tokens) * 1000) / 1000;
      }
      return spent;
    };
  }

  test("the eleven tasks, the index's owner as admin and the version make one ready SPACE", async () => {
    const owner = await agent();
    const keeper = await agent();
    const name = unique("ready-eleven");
    const out = await call("POST", "/v1/spaces", owner, {
      name, title: "See many spaces at once", visibility: "public", join_policy: "open",
      members: [{ peer_id: keeper.peerId, role: "admin" }],
      version: { title: "Version 1: See many spaces at once", body: DOCUMENT, fingerprints: [{ scheme: "subject", value: "ready" }] },
      tasks: eleven(),
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.document, true, "a version gives a work space its document");
    assert.deepEqual(out.body.members, [{ peer_id: keeper.peerId, role: "admin", tags: [] }]);
    assert.equal(out.body.version.seq, "1");
    assert.equal(out.body.version.oracle.state, "current");
    assert.equal(out.body.version.space_id, undefined, "the create's own space_id is the version's");
    assert.equal(out.body.version.space, undefined);
    assert.deepEqual(out.body.tasks.map((t: any) => [t.key, t.number, t.state]), ELEVEN.map(([key], i) => [key, i + 1, "open"]));
    assert.deepEqual(Object.keys(out.body.tasks[0]).sort(), ["key", "number", "state", "task_id"]);

    const profile = (await call("GET", `/v1/spaces/${name}`, owner)).body;
    assert.equal(profile.document.version.seq, "1");
    const doc = (await call("GET", `/v1/spaces/${name}/document`, owner)).body;
    assert.equal(doc.version.author, owner.peerId);
    assert.deepEqual(doc.version.fingerprints.map((f: any) => `${f.scheme}:${f.value}`), ["subject:ready"]);
    const roster = (await call("GET", `/v1/spaces/${name}/members`, owner)).body.items;
    assert.deepEqual(roster.filter((m: any) => m.peer_id === keeper.peerId).map((m: any) => [m.role, m.via]), [["admin", "grant"]]);
    // Each after, read whole, is the task_ids of the earlier tasks it named.
    const ids = new Map<string, string>(out.body.tasks.map((t: any) => [t.key, t.task_id]));
    const listed = (await call("GET", `/v1/spaces/${name}/tasks?detail=full&limit=50`, owner)).body.items as any[];
    for (const [key, , after] of ELEVEN) {
      const task = listed.find((t) => t.task_id === ids.get(key))!;
      assert.deepEqual(task.after, after.map((k) => ids.get(k)), key);
    }
  });

  test("the audit log reads created, the document, then one grant a member, and the revision is the last", async () => {
    const owner = await agent();
    const [a, b] = [await agent(), await agent()];
    const name = unique("ready-log");
    const out = await call("POST", "/v1/spaces", owner, {
      name, title: "Logged", members: [{ peer_id: a.peerId, role: "writer" }, { peer_id: b.peerId, role: "reader", tags: ["checker"] }],
      version: { body: DOCUMENT },
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const events = (await call("GET", `/v1/spaces/${name}/events`, owner)).body.items as any[];
    assert.deepEqual(events.map((e) => e.event), ["space.created", "space.updated", "member.granted", "member.granted"]);
    assert.deepEqual(events.slice(2).map((e) => e.payload.peer_id).sort(), [a.peerId, b.peerId].sort());
    assert.equal(out.body.revision, String(events.at(-1).revision));
    assert.deepEqual(out.body.members, [
      { peer_id: a.peerId, role: "writer", tags: [] }, { peer_id: b.peerId, role: "reader", tags: ["checker"] },
    ], "the members in the order sent, as set");
  });

  test("each role below owner is granted, and the caller or owner is refused before anything is spent", async () => {
    const owner = await agent();
    const keys = [await agent(), await agent(), await agent(), await agent()];
    const roles = ["admin", "coordinator", "writer", "reader"];
    const name = unique("ready-roles");
    const out = await call("POST", "/v1/spaces", owner, {
      name, title: "Roles", members: keys.map((k, i) => ({ peer_id: k.peerId, role: roles[i] })),
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.members.map((m: any) => m.role), roles);
    const roster = (await call("GET", `/v1/spaces/${name}/members`, owner)).body.items as any[];
    assert.deepEqual(keys.map((k) => roster.find((m) => m.peer_id === k.peerId)?.role), roles);

    const before = await bucket(`peer:${owner.peerId}`);
    const self = await call("POST", "/v1/spaces", owner, { name: unique("ready-self"), title: "x", members: [{ peer_id: owner.peerId, role: "admin" }] });
    assert.deepEqual([self.status, self.body.error.code, self.body.error.detail], [409, "OWNER_IS_NOT_A_MEMBER", "members[0]"]);
    const asOwner = await call("POST", "/v1/spaces", owner, { name: unique("ready-owner"), title: "x", members: [{ peer_id: keys[0]!.peerId, role: "owner" }] });
    assert.deepEqual([asOwner.body.error.code, asOwner.body.error.detail], ["INVALID_ROLE", "members[0]"]);
    assert.equal(await bucket(`peer:${owner.peerId}`), before, "a refused member spent the write allowance");
  });

  test("members, version and tasks are each read whole before anything is spent", async () => {
    const owner = await agent();
    const other = await agent();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ members: "x" }, "INVALID_REQUEST", `members is a list of up to ${CREATE_MEMBERS} KEYS, each with peer_id, role and tags`],
      [{ members: Array.from({ length: CREATE_MEMBERS + 1 }, () => ({ peer_id: other.peerId, role: "reader" })) }, "INVALID_REQUEST", `members is a list of up to ${CREATE_MEMBERS} KEYS, each with peer_id, role and tags`],
      [{ members: [{ peer_id: other.peerId, role: "reader", note: "x" }] }, "INVALID_REQUEST", `members is a list of up to ${CREATE_MEMBERS} KEYS, each with peer_id, role and tags`],
      [{ members: [{ peer_id: "ABC", role: "reader" }] }, "INVALID_REQUEST", "members[0]: peer_id is 64 lowercase hex characters"],
      [{ members: [{ peer_id: other.peerId }] }, "INVALID_ROLE", "members[0]"],
      [{ members: [{ peer_id: other.peerId, role: "reader", tags: ["admin"] }] }, "TAG_RESERVED", "members[0]: admin"],
      [{ members: [{ peer_id: other.peerId, role: "reader" }, { peer_id: other.peerId, role: "writer" }] }, "INVALID_REQUEST", "members[1]: peer_id is already the peer_id of members[0]: each KEY once"],
      [{ version: "text" }, "INVALID_REQUEST", "version takes title, body, data and fingerprints"],
      [{ version: { body: "x", supersedes: "y" } }, "INVALID_REQUEST", "version takes title, body, data and fingerprints"],
      [{ version: { title: "x" } }, "INVALID_REQUEST", "version.body is the text of the document"],
      [{ version: { body: "" } }, "INVALID_REQUEST", "version.body is the text of the document"],
      [{ version: { body: "x".repeat(65537) } }, "TOO_LARGE", "version.body"],
      [{ version: { title: "x".repeat(513), body: "x" } }, "INVALID_REQUEST", "version.title"],
      [{ version: { body: "x", data: { x: "y".repeat(16385) } } }, "TOO_LARGE", "version.data"],
      [{ version: { body: "x", fingerprints: "subject:x" } }, "INVALID_REQUEST", "version.fingerprints"],
      [{ version: { body: "x", data: { sources: ["1"] } } }, "SOURCE_NOT_FOUND", "version: 1"],
      [{ version: { body: "x", data: { stage: { word: "Merged" } } } }, "INVALID_REQUEST", `version.data.stage is word and note: word is one lowercase word of up to ${STAGE_LIMITS.wordCharacters} of a-z, 0-9, _, . and -, starting with a letter or digit; note is optional, one line of up to ${STAGE_LIMITS.noteCharacters} characters`],
      [{ tasks: [{ key: "a", title: "A" }, { key: "b", title: "B", after: [1] }] }, "INVALID_REQUEST", "tasks[1] (b): in a create, after takes only the key of an earlier task"],
      [{ tasks: [{ key: "a", title: "A", after: ["b"] }, { key: "b", title: "B" }] }, "INVALID_REQUEST", "tasks[0] (a): after[0] b is the key of no earlier task in this batch"],
      [{ tasks: Array.from({ length: TASK_LIMITS.batch + 1 }, (_, i) => ({ title: `T${i}` })) }, "INVALID_REQUEST", `tasks is a list of 1 to ${TASK_LIMITS.batch} tasks`],
      [{ visibility: "sealed", members: [{ peer_id: other.peerId, role: "reader" }] }, "INVALID_REQUEST", "a sealed SPACE takes no members, version or tasks in create: add members and tasks once it exists"],
      [{ visibility: "sealed", version: { body: "x" } }, "INVALID_REQUEST", "a sealed SPACE takes no members, version or tasks in create: add members and tasks once it exists"],
      [{ visibility: "sealed", tasks: [{ title: "T" }] }, "INVALID_REQUEST", "a sealed SPACE takes no members, version or tasks in create: add members and tasks once it exists"],
      [{ oracle: true, tasks: [{ title: "T" }] }, "ORACLE_HAS_NO_TASKS", "tasks"],
      [{ signed_only: true, version: { body: "x" } }, "SIGNATURE_REQUIRED", "version: a signed-only SPACE takes its first version as a signed POST once it exists"],
      [{ document: false, version: { body: "x" } }, "INVALID_REQUEST", "version needs document true in a work space"],
    ];
    const spent = await bucket(`peer:${owner.peerId}`);
    const made = await rows();
    for (const [fields, code, detail] of cases) {
      const name = unique("ready-refused");
      const out = await call("POST", "/v1/spaces", owner, { name, title: "Refused", ...fields });
      assert.deepEqual([out.body.error?.code, out.body.error?.detail], [code, detail], JSON.stringify(fields).slice(0, 200));
    }
    assert.equal(await bucket(`peer:${owner.peerId}`), spent, "a refused create spent the write allowance");
    assert.deepEqual(await rows(), made, "a refused create wrote a row");
  });

  test("signed-only takes members and tasks, and an oracle space its version, current at once", async () => {
    const owner = await agent();
    const other = await agent();
    const signed = await call("POST", "/v1/spaces", owner, {
      name: unique("ready-signed"), title: "Signed", signed_only: true,
      members: [{ peer_id: other.peerId, role: "writer" }], tasks: [{ title: "T" }],
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal(signed.body.signed_only, true);
    assert.equal(signed.body.tasks.length, 1);
    const name = unique("ready-oracle");
    const oracle = await call("POST", "/v1/spaces", owner, { name, title: "An oracle", oracle: true, version: { body: DOCUMENT } });
    assert.equal(oracle.status, 201, JSON.stringify(oracle.body));
    assert.equal(oracle.body.oracle, true);
    assert.equal(oracle.body.document, undefined, "an oracle space is one document already");
    assert.equal(oracle.body.version.oracle.state, "current");
    assert.equal((await call("GET", `/v1/spaces/${name}/document`)).body.version.seq, "1");
  });

  test("a first version's data.stage sets the SPACE's stage, as the same version POSTed does", async () => {
    const owner = await agent();
    const stage = { word: "proposed", note: "First draft." };
    const made = unique("ready-staged");
    const out = await call("POST", "/v1/spaces", owner, { name: made, title: "Staged", visibility: "public", version: { body: DOCUMENT, data: { stage } } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.version.stage_set, undefined, "a version is not a go");
    assert.equal(out.body.version.hint, undefined);
    const posted = unique("ready-staged-post");
    assert.equal((await call("POST", "/v1/spaces", owner, { name: posted, title: "Staged", visibility: "public", document: true })).status, 201);
    const version = await call("POST", `/v1/spaces/${posted}/posts`, owner, { kind: "version", body: DOCUMENT, data: { stage } });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    const [a, b] = [(await call("GET", `/v1/spaces/${made}`)).body.stage, (await call("GET", `/v1/spaces/${posted}`)).body.stage];
    assert.deepEqual([a.word, a.note, a.post_id, a.set_by], [stage.word, stage.note, out.body.version.post_id, owner.peerId]);
    assert.deepEqual({ ...a, post_id: 0, set_at: 0 }, { ...b, post_id: 0, set_at: 0 });
    assert.equal(b.post_id, version.body.post_id);
    // Listed by its stage, as any SPACE a version staged.
    const listed = (await call("GET", `/v1/spaces?prefix=${made}&stage=proposed`)).body.items;
    assert.deepEqual(listed.map((i: { name: string }) => i.name), [made]);
  });

  test("a create spends what each part spends alone, and the write allowance falls by every part", async () => {
    const owner = await agent();
    const [a, b] = [await agent(), await agent()];
    const spent = await allowances(owner, 20);
    const out = await call("POST", "/v1/spaces", owner, {
      name: unique("ready-spend"), title: "Spent", members: [{ peer_id: a.peerId, role: "writer" }, { peer_id: b.peerId, role: "reader" }],
      version: { body: DOCUMENT }, tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    // Writes: 1 for the SPACE, 2 members, 1 version, 3 tasks. A creation, a control a member,
    // and a proposal for the version.
    assert.deepEqual(await spent(), { writes: 7, creations: 1, control: 2, proposals: 1 });

    // A create one allowance cannot pay spends none of them.
    await fixture.setBucket(`peer:${owner.peerId}`, 60);
    await fixture.setBucket(`proposal:${owner.peerId}`, 0);
    const space = await bucket(`space:${owner.peerId}`);
    const poor = await call("POST", "/v1/spaces", owner, { name: unique("ready-poor"), title: "Poor", version: { body: DOCUMENT } });
    assert.equal(poor.status, 429, JSON.stringify(poor.body));
    assert.ok(Number(poor.headers.get("retry-after")) >= 1);
    assert.ok((await bucket(`peer:${owner.peerId}`))! >= 60, "a create refused for its proposal allowance spent writes");
    assert.ok((await bucket(`space:${owner.peerId}`))! >= space!, "a create refused for its proposal allowance spent a creation");
  });

  test("a member refused inside the transaction leaves nothing, and the allowances moved by what was stated", async () => {
    const owner = await agent();
    const crowded = await agent();
    const filler = await agent();
    // The crowded KEY holds as many granted SPACES as it may: private filler SPACES and its
    // grants, written straight in, as test/schema.test.ts does to reach the cap.
    const [cap] = await fixture.owner<{ grants: number }[]>`select schellingaf.cap('granted_spaces_per_key')::int as grants`;
    const fill = unique("fill");
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description)
      select ${fill} || '-' || g, ${Buffer.from(filler.peerId, "hex")}, 'Filler', 'filler'
        from generate_series(1, ${cap!.grants}) g`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select sp.space_id, ${Buffer.from(crowded.peerId, "hex")}, 'reader', 'grant', ${Buffer.from(filler.peerId, "hex")}, 1
        from schellingaf.spaces sp where sp.name like ${fill + "-%"}`;
    const other = await agent();
    const made = await rows();
    const spent = await allowances(owner, 5);
    const name = unique("ready-crowded");
    const out = await call("POST", "/v1/spaces", owner, {
      name, title: "Crowded", members: [{ peer_id: other.peerId, role: "writer" }, { peer_id: crowded.peerId, role: "reader" }],
      tasks: [{ title: "T" }],
    });
    assert.deepEqual([out.status, out.body.error?.code, out.body.error?.detail], [409, "SPACE_LIMIT", "members[1]"]);
    assert.match(out.body.error.fix, /A detail naming members\[i\] is that member's limit, not yours: leave it out of members\./);
    // Spent before the transaction and kept: 1 + 2 members + 1 task of the writes, a
    // creation, a control a member, no proposal.
    assert.deepEqual(await spent(), { writes: 4, creations: 1, control: 2, proposals: 0 });
    assert.deepEqual(await rows(), made, "the refused create left a row");
    // The name is free: another KEY makes it.
    assert.equal((await call("POST", "/v1/spaces", other, { name, title: "Mine now" })).status, 201);
  });

  test("an unknown member is refused before anything is spent, and the name stays free", async () => {
    const owner = await agent();
    const known = await agent();
    const spent = await bucket(`peer:${owner.peerId}`);
    const made = await rows();
    const name = unique("ready-unknown");
    const nobody = "ab".repeat(32);
    const out = await call("POST", "/v1/spaces", owner, {
      name, title: "Unknown", members: [{ peer_id: known.peerId, role: "writer" }, { peer_id: nobody, role: "reader" }],
      version: { body: DOCUMENT }, tasks: [{ title: "T" }],
    });
    assert.deepEqual([out.status, out.body.error?.code, out.body.error?.detail], [422, "PEER_NOT_REGISTERED", `members[1]: ${nobody}`]);
    assert.equal(await bucket(`peer:${owner.peerId}`), spent);
    assert.deepEqual(await rows(), made);
    assert.equal((await call("POST", "/v1/spaces", await agent(), { name, title: "Mine now" })).status, 201);
    // And a taken name is refused before anything is spent too.
    const taken = await call("POST", "/v1/spaces", owner, { name, title: "Again", tasks: [{ title: "T" }] });
    assert.equal(taken.body.error.code, "SPACE_NAME_TAKEN");
    assert.equal(await bucket(`peer:${owner.peerId}`), spent);
  });

  test("when its last statement fails, everything the earlier ones wrote is gone", async () => {
    const owner = await agent();
    const member = await agent();
    // Installed by the test as the database's owner: the tasks' insert refuses one title.
    await fixture.owner.unsafe(`
      create function schellingaf.test_refuse_task() returns trigger language plpgsql as $$
      begin
        if new.title = 'refuse me' then raise exception 'INVALID_REQUEST' using detail = 'refused by the test'; end if;
        return new;
      end $$`);
    await fixture.owner.unsafe(`create trigger test_refuse_task before insert on schellingaf.tasks for each row execute function schellingaf.test_refuse_task()`);
    try {
      const made = await rows();
      const name = unique("ready-last");
      const out = await call("POST", "/v1/spaces", owner, {
        name, title: "Last", visibility: "public", members: [{ peer_id: member.peerId, role: "admin" }],
        version: { body: DOCUMENT }, tasks: [{ title: "fine" }, { title: "refuse me" }],
      });
      assert.deepEqual([out.status, out.body.error?.code, out.body.error?.detail], [400, "INVALID_REQUEST", "refused by the test"]);
      assert.deepEqual(await rows(), made, "the space, its document, its member, its version or a task outlived the refusal");
      assert.equal((await call("POST", "/v1/spaces", member, { name, title: "Mine now" })).status, 201);
    } finally {
      await fixture.owner.unsafe("drop trigger test_refuse_task on schellingaf.tasks");
      await fixture.owner.unsafe("drop function schellingaf.test_refuse_task()");
    }
  });

  test("two creates of one name at once: one is made whole, the other is SPACE_NAME_TAKEN and leaves nothing", async () => {
    const [a, b] = [await agent(), await agent()];
    const [ma, mb] = [await agent(), await agent()];
    const name = unique("ready-race");
    const made = await rows();
    const body = (member: Agent) => ({
      name, title: "Race", members: [{ peer_id: member.peerId, role: "writer" }], version: { body: DOCUMENT }, tasks: [{ title: "T" }, { title: "U" }],
    });
    const outs = await Promise.all([call("POST", "/v1/spaces", a, body(ma)), call("POST", "/v1/spaces", b, body(mb))]);
    assert.deepEqual(outs.map((o) => o.status).sort(), [201, 409], JSON.stringify(outs.map((o) => o.body)));
    const lost = outs.find((o) => o.status === 409)!;
    assert.equal(lost.body.error.code, "SPACE_NAME_TAKEN");
    const won = outs.findIndex((o) => o.status === 201);
    const after = await rows();
    assert.equal(after.spaces! - made.spaces!, 1);
    assert.equal(after.memberships! - made.memberships!, 1);
    assert.equal(after.posts! - made.posts!, 1);
    assert.equal(after.tasks! - made.tasks!, 2);
    const roster = (await call("GET", `/v1/spaces/${name}/members`, won === 0 ? a : b)).body.items as any[];
    assert.deepEqual(roster.map((m) => m.peer_id), [(won === 0 ? ma : mb).peerId]);
  });

  test("the version is written with the statement the posts route sends, unchanged by the lift", () => {
    // The posts route's statement before it moved to src/http/append.ts, each value a $.
    const STATEMENT =
      "\n      select schellingaf.append_post(\n        $, $, $, $, $,\n        $, $, $::bytea[],\n        $, $, $, $,\n" +
      "        $, $, $,\n        $, $, $,\n        $, $,\n        $::text[],\n        $::bytea,\n        $, $,\n        $::bytea[],\n" +
      "        $::bytea, $::bytea,\n        $, $, $::bytea) as receipt";
    let strings: readonly string[] = [];
    let values: unknown[] = [];
    const sql = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => {
      strings = s;
      values = v;
      return Promise.resolve([]);
    }, { array: (v: unknown) => ({ array: v }), json: (v: unknown) => ({ json: v }) }) as unknown as Sql;
    const author = Buffer.alloc(32, 7);
    void appendPost(sql, {
      name: "a-space", author, signed: null, links: ["space:proposals"], reviewer: null, quiet: [], sealed: null, openPostsPerDay: 9,
      post: {
        idempotencyKey: null, kind: "version", title: "V1", body: DOCUMENT, to: [], replyTo: null, supersedes: null, retracts: null,
        fingerprints: [], data: null, budget: null, runId: null,
      },
    });
    assert.equal(strings.join("$"), STATEMENT);
    assert.equal(values.length, 30);
    assert.deepEqual(values.slice(0, 5), ["a-space", author, "version", "V1", DOCUMENT]);
    assert.equal(values[14], publicSeekablePerDay());
    assert.deepEqual(values[20], { array: ["space:proposals"] });
    assert.deepEqual(values.slice(22, 24), [ORACLE_LIMITS.waitingPerKey, ORACLE_LIMITS.waitingPerSpace]);
    assert.deepEqual(values.slice(27), [9, OPEN_POSTS_PER_SPACE_PER_DAY, null]);
  });

  test("the largest create keeps to its latency budget", async () => {
    const owner = await agent();
    const members: { peer_id: string; role: string }[] = [];
    for (let i = 0; i < CREATE_MEMBERS; i++) members.push({ peer_id: (await agent()).peerId, role: i === 0 ? "admin" : "writer" });
    // The request cap of 256 KiB: a 64 KiB version, twenty tasks of 9,000 bytes, eight members.
    const sentence = "A sentence of the document, kept short. ";
    const version = { title: "Version 1: The largest", body: `# The largest\n\n${sentence.repeat(Math.floor((65536 - 20) / sentence.length))}` };
    const tasks = Array.from({ length: TASK_LIMITS.batch }, (_, i) => ({
      key: `t${i}`, title: `Task ${i}`, tag: "work", body: "Do it. ".repeat(1285), ...(i > 0 ? { after: [`t${i - 1}`] } : {}),
    }));
    const held: number[] = [];
    const begin = db.write.begin;
    (db.write as any).begin = async (...args: any[]) => {
      const started = performance.now();
      try {
        return await (begin as any).apply(db.write, args);
      } finally {
        held.push(performance.now() - started);
      }
    };
    const took: number[] = [];
    try {
      for (let run = 0; run < 11; run++) {
        const payload = { name: unique("ready-largest"), title: "The largest", visibility: "public", members, version, tasks };
        assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 256 * 1024, `the request is ${Buffer.byteLength(JSON.stringify(payload))} bytes`);
        const started = performance.now();
        const out = await call("POST", "/v1/spaces", owner, payload);
        took.push(performance.now() - started);
        assert.equal(out.status, 201, JSON.stringify(out.body).slice(0, 300));
        assert.equal(out.body.tasks.length, TASK_LIMITS.batch);
        await fixture.setBucket(`peer:${owner.peerId}`, 60);
        await fixture.setBucket(`space:${owner.peerId}`, 100);
        await fixture.setBucket(`ctl:${owner.peerId}`, 100);
        await fixture.setBucket(`proposal:${owner.peerId}`, 30);
      }
    } finally {
      (db.write as any).begin = begin;
    }
    // The first run warms the connections and the plans; the budget is for the rest.
    const sorted = (xs: number[]) => xs.slice(1).sort((x, y) => x - y);
    const [whole, hold] = [sorted(took), sorted(held)];
    const median = whole[Math.floor(whole.length / 2)]!;
    console.log(`the largest create: median ${median.toFixed(1)} ms, slowest ${whole.at(-1)!.toFixed(1)} ms; write connection held: median ${hold[Math.floor(hold.length / 2)]!.toFixed(1)} ms, slowest ${hold.at(-1)!.toFixed(1)} ms`);
    assert.ok(median <= 120, `the largest create took ${median.toFixed(1)} ms at the median, over its budget of 120`);
    // The slowest of ten swings with whatever else the machine runs: on a shared CI runner
    // it is logged above, never asserted, so a busy runner cannot fail a merge.
    if (process.env.CI === undefined) {
      assert.ok(whole.at(-1)! <= 300, `the slowest largest create took ${whole.at(-1)!.toFixed(1)} ms, over its budget of 300`);
      assert.ok(hold.at(-1)! <= 150, `a create held its write connection ${hold.at(-1)!.toFixed(1)} ms, over its budget of 150`);
    }
  });
});

// ── the SPACE list's stage, prefix and counts (migrations/0123_space_stages.sql) ─────

describe("the SPACE list's stage, prefix and counts", () => {
  let made = 0;
  /** A SPACE of `owner`'s, public unless `extra` says, named `name` or a new name. */
  async function space(owner: Agent, extra: Record<string, unknown> = {}, name = `listed-${process.pid}-${made++}`): Promise<string> {
    const out = await call("POST", "/v1/spaces", owner, { name, title: "Listed", visibility: "public", ...extra });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    return name;
  }
  async function grant(owner: Agent, name: string, who: Agent, role: string) {
    const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner, { role });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
  async function posted(who: Agent, name: string, body: Record<string, unknown>) {
    const out = await call("POST", `/v1/spaces/${name}/posts`, who, body);
    assert.ok(out.status === 201 || out.status === 200, JSON.stringify(out.body));
    return out.body;
  }
  async function item(name: string, query = "", who?: Agent) {
    const out = await call("GET", `/v1/spaces?prefix=${name}${query}`, who);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return out.body.items.find((i: { name: string }) => i.name === name);
  }
  /** Posts written straight in, oldest first, as append_post numbers them: seq on from
   *  the SPACE's last, and post_id and posted_at rising with it. */
  async function backdated(name: string, author: Agent, hoursAgo: number[], noRole = false): Promise<string[]> {
    const ids: string[] = [];
    for (const hours of hoursAgo) {
      const [row] = await fixture.owner<{ post_id: string }[]>`
        with s as (
          update schellingaf.spaces set last_seq = last_seq + 1 where name = ${name}
          returning space_id, last_seq)
        insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash, posted_at, no_role)
        select s.space_id, s.last_seq, 1, decode(${author.peerId}, 'hex'), 'obs', 'backdated',
               sha256(gen_random_uuid()::text::bytea), clock_timestamp() - make_interval(secs => ${hours * 3600}), ${noRole}
          from s
        returning post_id::text`;
      ids.push(row!.post_id);
    }
    return ids;
  }
  const hide = (postId: string) => fixture.owner`
    insert into schellingaf.space_hidden (post_id, space_id, hidden_by, revision)
    select p.post_id, p.space_id, s.owner_id, 1 from schellingaf.posts p
      join schellingaf.spaces s on s.space_id = p.space_id where p.post_id = ${postId}::uuid`;
  const withhold = (postId: string) => fixture.owner`
    insert into schellingaf.withheld (post_id, space_id, reason, note)
    select p.post_id, p.space_id, 'legal_order', 'test' from schellingaf.posts p where p.post_id = ${postId}::uuid`;

  test("counts: a passed claim reads open, open + claimed + done is open_tasks, and findings stand by status", async () => {
    const owner = await agent();
    const writers = [await agent(), await agent(), await agent(), await agent()];
    const name = await space(owner, { join_policy: "open" });
    for (const w of writers) await grant(owner, name, w, "writer");
    for (let i = 1; i <= 5; i++) assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner, { title: `task ${i}` })).status, 201);
    const take = async (w: Agent) => (await call("POST", `/v1/spaces/${name}/tasks/next`, w, {})).body.task.number as number;
    const finish = async (w: Agent, n: number) => {
      const result = await posted(w, name, { kind: "result", body: `Task ${n} done.` });
      assert.equal((await call("POST", `/v1/spaces/${name}/tasks/${n}/done`, w, { post_id: result.post_id })).status, 200);
    };
    assert.equal(await take(writers[0]!), 1);
    assert.equal(await take(writers[1]!), 2);
    assert.equal(await take(writers[2]!), 3);
    await finish(writers[2]!, 3);
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner, { task_confirmations: 0 })).status, 200);
    assert.equal(await take(writers[3]!), 4);
    await finish(writers[3]!, 4);
    // Task 2's claim passes: it reads open, as the task list shows it.
    await fixture.owner`
      update schellingaf.tasks t set claimed_until = now() - interval '1 minute'
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = 2`;

    const finding = (who: Agent, status: string, extra: Record<string, unknown> = {}) =>
      posted(who, name, { kind: "finding", body: "Measured.", data: { claim: `a claim ${status}`, status, confidence: "low" }, ...extra });
    await finding(owner, "proposed");
    const replaced = await finding(owner, "supported");
    await finding(owner, "disputed", { supersedes: replaced.post_id });
    const retracted = await finding(owner, "supported");
    await posted(owner, name, { kind: "obs", body: "Withdrawn: it did not hold.", retracts: retracted.post_id });
    const hidden = await finding(writers[0]!, "proposed");
    assert.equal((await call("PUT", `/v1/posts/${hidden.post_id}/hidden`, owner, {})).status, 200);

    const listed = await item(name, "&counts=true");
    assert.equal(listed.open_tasks, 4);
    assert.deepEqual(listed.counts.tasks, { open: 2, claimed: 1, done: 1, accepted: 1 });
    const t = listed.counts.tasks;
    assert.equal(t.open + t.claimed + t.done, listed.open_tasks);
    assert.deepEqual(listed.counts.findings, { proposed: 2, supported: 0, disputed: 1, withdrawn: 1 });
    // The counts kept as findings change are the findings' own, in every SPACE here.
    const [differ] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n
        from (select f.space_id,
                     count(*) filter (where f.retracted_by is null and f.status = 'proposed')::int as proposed,
                     count(*) filter (where f.retracted_by is null and f.status = 'supported')::int as supported,
                     count(*) filter (where f.retracted_by is null and f.status = 'disputed')::int as disputed,
                     count(*) filter (where f.retracted_by is not null)::int as withdrawn
                from schellingaf.findings f where f.superseded_by is null group by f.space_id) r
        full join schellingaf.space_finding_counts c on c.space_id = r.space_id
       where (coalesce(r.proposed, 0), coalesce(r.supported, 0), coalesce(r.disputed, 0), coalesce(r.withdrawn, 0))
             is distinct from (coalesce(c.proposed, 0), coalesce(c.supported, 0), coalesce(c.disputed, 0), coalesce(c.withdrawn, 0))`;
    assert.equal(differ!.n, 0, "a SPACE's kept count differs from its findings");
    assert.equal(listed.counts.document, null, "a work space that keeps none");
    // The task list agrees about which are open.
    const open = await call("GET", `/v1/spaces/${name}/tasks?state=open`, owner);
    assert.deepEqual(open.body.items.map((i: { number: number }) => i.number).sort(), [2, 5]);
    // Without counts=true, no counts; with it, every other field the same.
    const plain = await item(name);
    assert.equal("counts" in plain, false);
    const { counts: _counts, ...rest } = listed;
    assert.deepEqual(rest, plain);
  });

  test("counts: a document's current version and pending versions, as on the profile", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = await space(owner, { document: true });
    await grant(owner, name, writer, "writer");
    assert.deepEqual((await item(name, "&counts=true")).counts.document, { version: null, pending: 0 });
    const v1 = await posted(owner, name, { kind: "version", body: "v1" });
    await posted(writer, name, { kind: "version", body: "v2", supersedes: v1.post_id });
    const listed = await item(name, "&counts=true");
    const profile = await call("GET", `/v1/spaces/${name}`, owner);
    assert.deepEqual(listed.counts.document, profile.body.document);
    assert.deepEqual(listed.counts.document, { version: { post_id: v1.post_id, seq: v1.seq }, pending: 1 });
  });

  test("posts_7d is a row count of the last 168 hours, hidden and withheld posts left out, every author in", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await space(owner, { join_policy: "open" });
    // Written straight in, with the times they were posted: chains are not what this counts.
    const old = await backdated(name, owner, [400, 200, 168 + 1 / 60, 168 - 1 / 60, 100, 50, 10, 1]);
    // A hidden post on each side of the edge, a withheld one inside, and one both.
    await hide(old[1]!);
    await hide(old[4]!);
    await withhold(old[5]!);
    await hide(old[6]!);
    await withhold(old[6]!);
    // A KEY with no role in this open SPACE, and a post withheld and then released.
    await backdated(name, stranger, [0.5], true);
    const [released] = await backdated(name, owner, [0.1]);
    await withhold(released!);
    await fixture.owner`update schellingaf.withheld set released_at = now() where post_id = ${released!}::uuid`;

    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name = ${name} and p.posted_at >= now() - interval '168 hours'
         and not exists (select 1 from schellingaf.space_hidden h where h.post_id = p.post_id)
         and not exists (select 1 from schellingaf.withheld w where w.post_id = p.post_id and w.released_at is null)`;
    // Inside the window: 167.98, 100 (hidden), 50 (withheld), 10 (both), 1, the KEY with
    // no role's, and the one released.
    assert.equal(row!.n, 4);
    assert.equal((await item(name, "&counts=true")).counts.posts_7d, row!.n);
    assert.equal((await item(name, "&counts=true", stranger)).counts.posts_7d, row!.n, "the same for every reader");
    // A SPACE with nothing in the window counts 0.
    const quiet = await space(owner);
    await backdated(quiet, owner, [300, 200]);
    assert.equal((await item(quiet, "&counts=true")).counts.posts_7d, 0);
  });

  test("within a SPACE, post_id order is seq order, which posts_7d rests on", async () => {
    const owner = await agent();
    const writers = [await agent(), await agent(), await agent(), await agent()];
    const name = await space(owner);
    for (const w of writers) await grant(owner, name, w, "writer");
    await Promise.all(writers.flatMap((w) => Array.from({ length: 6 }, (_, i) => posted(w, name, { kind: "obs", body: `at once ${i}` }))));
    const [row] = await fixture.owner<{ n: number; out: number }[]>`
      select count(*)::int as n,
             count(*) filter (where x.prev is not null and (x.post_id < x.prev or x.posted_at < x.prev_at))::int as out
        from (select p.post_id, p.posted_at, lag(p.post_id) over (order by p.seq) as prev,
                     lag(p.posted_at) over (order by p.seq) as prev_at
                from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
               where s.name = ${name}) x`;
    assert.deepEqual(row, { n: 24, out: 0 });
    // And what posts_7d counts from the sequence is that row count, a hidden post left out.
    const [middle] = await fixture.owner<{ post_id: string }[]>`
      select p.post_id::text from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name = ${name} and p.seq = 12`;
    await hide(middle!.post_id);
    assert.equal((await item(name, "&counts=true")).counts.posts_7d, 23);
  });

  test("counts=true is refused in any other form, and stage is on every item and the profile", async () => {
    for (const value of ["false", "1", "", "TRUE"]) {
      const out = await call("GET", `/v1/spaces?counts=${value}`);
      assert.equal(out.status, 400, value);
      assert.equal(out.body.error.detail, "counts is true, or left out");
    }
    const owner = await agent();
    const name = await space(owner);
    const listed = await item(name);
    assert.deepEqual(Object.keys(listed), [
      "name", "title", "description", "visibility", "join_policy", "owner", "created_at", "categories",
      "head_seq", "member_count", "oracle", "last_written_at", "open_tasks", "stage",
    ]);
    assert.equal(listed.stage, null);
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.stage, null);
  });

  test("prefix keeps the names that start with it, byte for byte, in code-point order", async () => {
    const owner = await agent();
    for (const name of ["pro-a", "proa", "pro-z", "prob", "ab9", "ab9x", "aba", "abz", "abzz", "ac0"]) await space(owner, {}, name);
    const names = async (prefix: string) =>
      (await call("GET", `/v1/spaces?prefix=${prefix}`)).body.items.map((i: { name: string }) => i.name);
    assert.deepEqual(await names("pro-"), ["pro-a", "pro-z"]);
    // A prefix ending in a digit or in z: in byte order, whatever the database's collation.
    assert.deepEqual(await names("ab9"), ["ab9", "ab9x"]);
    assert.deepEqual(await names("abz"), ["abz", "abzz"]);
    for (const bad of ["pr", "Pro", "-pro", "pro_", "p".repeat(64)]) {
      const refused = await call("GET", `/v1/spaces?prefix=${bad}`);
      assert.equal(refused.status, 400, bad);
      assert.equal(refused.body.error.detail, "prefix is the start of a SPACE name: 3 to 63 of a-z, 0-9 and -, not starting with -");
    }
    // A cursor past the prefix: an empty page.
    const past = await call("GET", "/v1/spaces?prefix=pro-&after=pro-zz");
    assert.deepEqual([past.body.items, past.body.has_more], [[], false]);
  });

  test("stage is one to 8 words separated by commas, each counted as sent, and empty is left out", async () => {
    for (const bad of ["a,,b", "Merged", "a,b,c,d,e,f,g,h,i", "a,a,a,a,a,a,a,a,a", ",a", "a,", "x".repeat(33), "in progress"]) {
      const out = await call("GET", `/v1/spaces?stage=${encodeURIComponent(bad)}`);
      assert.equal(out.status, 400, bad);
      assert.equal(out.body.error.detail, "stage is one to 8 stage words, separated by commas");
    }
    assert.equal((await call("GET", "/v1/spaces?stage=a,a,a,a,a,a,a,a")).status, 200);
    const all = await call("GET", "/v1/spaces?limit=200");
    const empty = await call("GET", "/v1/spaces?stage=&limit=200");
    assert.deepEqual(empty.body, all.body);
  });

  test("every filter together pages with no gap and no repeat, by name and newest first", async () => {
    const base = `pg${process.pid}x`;
    const wanted: string[] = [];
    // Each kept SPACE: public, open, a document whose version set "merged", a task waiting,
    // and the word to search for.
    // A KEY's first day allows it five versions, so each SPACE has an owner of its own.
    for (let i = 0; i < 7; i++) {
      const owner = await agent();
      const name = await space(owner, { join_policy: "open", document: true, description: "zebrafish trials" }, `${base}-${i}`);
      await posted(owner, name, { kind: "version", body: "v1", data: { stage: { word: i % 2 ? "merged" : "accepted" } } });
      await call("POST", `/v1/spaces/${name}/tasks`, owner, { title: "waiting" });
      wanted.push(name);
    }
    // Each left out by one filter alone.
    const owner = await agent();
    const declined = await space(owner, { join_policy: "open", document: true, description: "zebrafish trials" }, `${base}-declined`);
    await posted(owner, declined, { kind: "version", body: "v1", data: { stage: { word: "declined" } } });
    await call("POST", `/v1/spaces/${declined}/tasks`, owner, { title: "waiting" });
    const other = await space(owner, { join_policy: "open", document: true, description: "zebrafish trials" }, `other${process.pid}x-0`);
    await posted(owner, other, { kind: "version", body: "v1", data: { stage: { word: "merged" } } });
    await call("POST", `/v1/spaces/${other}/tasks`, owner, { title: "waiting" });
    const idle = await space(owner, { join_policy: "open", document: true, description: "zebrafish trials" }, `${base}-idle`);
    await posted(owner, idle, { kind: "version", body: "v1", data: { stage: { word: "merged" } } });

    const filters = `prefix=${base}-&stage=merged,accepted&q=zebrafish&category=general&oracle=false&join_policy=open&open_tasks=true&counts=true&limit=2`;
    const byName: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const out = await call("GET", `/v1/spaces?${filters}${after ? `&after=${after}` : ""}`);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      byName.push(...out.body.items.map((i: { name: string }) => i.name));
      if (!out.body.has_more) break;
      after = out.body.next_after;
    }
    assert.deepEqual(byName, [...wanted].sort());
    const newest: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page++) {
      const out = await call("GET", `/v1/spaces?${filters}&order=recent${before ? `&before=${before}` : ""}`);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      newest.push(...out.body.items.map((i: { name: string }) => i.name));
      if (!out.body.has_more) break;
      before = out.body.next_before;
    }
    assert.deepEqual([...newest].sort(), [...wanted].sort());
    assert.equal(new Set(newest).size, newest.length);
    // stage= alone, and a word nobody set.
    const merged = await call("GET", `/v1/spaces?prefix=${base}-&stage=merged&limit=200`);
    assert.deepEqual(merged.body.items.map((i: { name: string }) => i.name), [...wanted.filter((_, i) => i % 2), `${base}-idle`].sort());
    assert.deepEqual((await call("GET", `/v1/spaces?prefix=${base}-&stage=in-progress`)).body.items, []);
  });

  test("finished=false leaves out a finished stage and finished=true keeps those alone, with stage=, open_tasks=true and both orders", async () => {
    const base = `fn${process.pid}x`;
    // Each SPACE: public, a document whose version set its word (or none), and a task waiting
    // in all but the one named idle. A KEY's first day allows it five versions, so each
    // SPACE has an owner of its own.
    const words: Record<string, string | null> = {
      merged: "merged", declined: "declined", done: "done", closed: "closed",
      accepted: "accepted", proposed: "proposed", none: null, idle: "merged",
    };
    for (const [suffix, word] of Object.entries(words)) {
      const owner = await agent();
      const name = await space(owner, { document: true }, `${base}-${suffix}`);
      if (word !== null) await posted(owner, name, { kind: "version", body: "v1", data: { stage: { word } } });
      if (suffix !== "idle") await call("POST", `/v1/spaces/${name}/tasks`, owner, { title: "waiting" });
    }
    const names = async (query: string) => {
      const out = await call("GET", `/v1/spaces?prefix=${base}-&limit=200${query}`);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return out.body.items.map((i: { name: string }) => i.name.slice(base.length + 1));
    };
    assert.deepEqual(await names("&finished=true"), ["closed", "declined", "done", "idle", "merged"]);
    assert.deepEqual(await names("&finished=false"), ["accepted", "none", "proposed"]);
    assert.deepEqual((await names("")).length, 8, "left out, every SPACE is listed");
    // Each item and the profile say whether its stage is finished; no stage is null.
    const all = (await call("GET", `/v1/spaces?prefix=${base}-&limit=200`)).body.items;
    const finished = Object.fromEntries(all.map((i: { name: string; stage: { finished: boolean } | null }) =>
      [i.name.slice(base.length + 1), i.stage === null ? null : i.stage.finished]));
    assert.deepEqual(finished, {
      accepted: false, closed: true, declined: true, done: true, idle: true, merged: true, none: null, proposed: false,
    });
    assert.equal((await call("GET", `/v1/spaces/${base}-merged`)).body.stage.finished, true);
    assert.equal((await call("GET", `/v1/spaces/${base}-accepted`)).body.stage.finished, false);
    // With the other filters: a SPACE must match every one.
    assert.deepEqual(await names("&finished=false&open_tasks=true"), ["accepted", "none", "proposed"]);
    assert.deepEqual(await names("&finished=true&open_tasks=true"), ["closed", "declined", "done", "merged"]);
    assert.deepEqual(await names("&finished=false&stage=merged,accepted"), ["accepted"]);
    assert.deepEqual(await names("&finished=true&stage=merged,accepted"), ["idle", "merged"]);
    assert.deepEqual(await names("&finished=true&stage=accepted"), []);
    assert.deepEqual(await names("&finished=false&counts=true&oracle=false&category=general"), ["accepted", "none", "proposed"]);
    // Newest first, paged two at a time, with no gap and no repeat.
    const newest: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page++) {
      const out = await call("GET", `/v1/spaces?prefix=${base}-&finished=true&order=recent&limit=2${before ? `&before=${before}` : ""}`);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      newest.push(...out.body.items.map((i: { name: string }) => i.name.slice(base.length + 1)));
      if (!out.body.has_more) break;
      before = out.body.next_before;
    }
    assert.deepEqual([...newest].sort(), ["closed", "declined", "done", "idle", "merged"]);
    assert.equal(new Set(newest).size, newest.length);
  });

  test("finished is true or false, or left out: anything else is refused", async () => {
    for (const bad of ["", "1", "0", "yes", "TRUE", "False", "true,false"]) {
      const out = await call("GET", `/v1/spaces?finished=${encodeURIComponent(bad)}`);
      assert.equal(out.status, 400, bad);
      assert.equal(out.body.error.code, "INVALID_REQUEST", bad);
      assert.equal(out.body.error.detail, "finished is true or false, or left out", bad);
    }
  });

  test("the capability document publishes the stage limits and the words that mark a SPACE finished", async () => {
    const caps = (await call("GET", "/v1/capabilities")).body;
    assert.deepEqual(caps.limits.stages, {
      word_characters: STAGE_LIMITS.wordCharacters,
      note_characters: STAGE_LIMITS.noteCharacters,
      filter_words: STAGE_LIMITS.filterWords,
      finished: [...FINISHED_STAGES],
    });
  });

  test("STAGE_LIMITS holds the database's checks", async () => {
    const checks = await fixture.owner<{ name: string; def: string }[]>`
      select c.conname as name, pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conname in ('space_stages_word_shape', 'space_stages_note_line',
                           'oracle_versions_stage_word_shape', 'oracle_versions_stage_note_line')
       order by c.conname`;
    assert.equal(checks.length, 4);
    for (const { name, def } of checks) {
      if (name.endsWith("word_shape")) {
        assert.ok(def.includes(`{0,${STAGE_LIMITS.wordCharacters - 1}}`), `${name}: ${def}`);
        assert.ok(def.includes(STAGE_WORD.source.slice(1, -1)), `${name}: ${def}`);
      } else {
        assert.match(def, new RegExp(`<= ${STAGE_LIMITS.noteCharacters}\\b`), `${name}: ${def}`);
      }
    }
  });
});
