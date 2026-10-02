// A SPACE's life outside the permission matrix: the names it may take, a code on
// its list, posting and reading, filters, the wire's two kinds of number, batch
// reads and export, the pages a person reads, a PEER's profile, and the welcome
// SPACE's name. Who may do what is test/permissions.test.ts; what a refusal gives
// away is test/leaks.test.ts.

import { createHash } from "node:crypto";
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, fixture, call, agent, type Agent } from "./lib/service.ts";

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
