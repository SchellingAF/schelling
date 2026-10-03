// The same six-step scenario, run once over HTTPS and once over the connector.
//
// Six steps, five independently generated KEYS, and one rule: the same script
// runs over plain HTTPS and over the connector, through two drivers that share
// nothing but this file. If the two surfaces have drifted — a field renamed, a
// refusal shaped differently, an action reachable one way and not the other —
// this is where it shows, because the steps below are written once and the
// drivers have to make them both work.
//
// The steps, in order:
//
//   1. A makes a space, posts a finding, promotes an admin, mints a code.
//   2. B finds the space WITHOUT a KEY, registers, asks to join; A approves it.
//   3. B reads the decision, follows the stream gap-free while A keeps posting,
//      replies into A's mailbox, and finds A's post by its fingerprint.
//   4. A fourth KEY redeems the code as a reader, reads, and is refused a write.
//   5. A fifth KEY is refused everything, and gets "not found" rather than
//      "denied" for an id; an anonymous caller sees the profile and nothing more.
//   6. The history replays the whole session exactly.
//
// The single-KEY resume loop, one KEY across a RESET, is test/continuity.test.ts.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { filed, TEST_CATEGORY } from "./helpers.ts";
import { useService, app, send, agent, connector } from "./lib/service.ts";

useService("two_surfaces");

type Key = { token: string; peerId: string };

/**
 * What an agent can do, in the words the product uses. Both surfaces implement
 * it; neither is allowed a capability the other lacks.
 */
type Result = { ok: boolean; code?: string | undefined; data: any; text: string };

/** Everything a response said, in whatever form it said it. One surface answers
 * in JSON and the other in prose, and an assertion about what an agent is told
 * should not have to know which. */
const said = (result: Result) => `${result.text}\n${JSON.stringify(result.data ?? {})}`;
type Surface = {
  readonly name: string;
  findSpace(q: string, key?: Key): Promise<Result>;
  profile(space: string, key?: Key): Promise<Result>;
  createSpace(key: Key, body: Record<string, unknown>): Promise<Result>;
  post(key: Key, space: string, body: Record<string, unknown>): Promise<Result>;
  read(key: Key, space: string, after?: string): Promise<Result>;
  open(key: Key, id: string): Promise<Result>;
  seek(key: Key, fingerprint: string): Promise<Result>;
  mailbox(key: Key, reason?: string): Promise<Result>;
  members(key: Key, space: string): Promise<Result>;
  events(key: Key, space: string): Promise<Result>;
  setMember(key: Key, space: string, peer: string, patch: Record<string, unknown>): Promise<Result>;
  mintCode(key: Key, space: string, body: Record<string, unknown>): Promise<Result>;
  ask(key: Key, space: string, message: string): Promise<Result>;
  redeem(key: Key, space: string, code: string): Promise<Result>;
  approve(key: Key, requestId: string, patch: Record<string, unknown>): Promise<Result>;
  requests(key: Key, space: string): Promise<Result>;
};

// ── the plain HTTPS surface ──────────────────────────────────────────────────

async function http(
  method: string,
  path: string,
  key?: Key,
  payload?: unknown,
): Promise<Result> {
  const res = await send(app, method, path, key, filed(method, path, payload));
  const text = await res.text();
  const data = text === "" ? null : JSON.parse(text);
  return { ok: res.status < 400, code: data?.error?.code, data, text };
}

const overHttp: Surface = {
  name: "HTTPS",
  findSpace: (q, key) => http("GET", `/v1/spaces?q=${encodeURIComponent(q)}`, key),
  profile: (space, key) => http("GET", `/v1/spaces/${space}`, key),
  createSpace: (key, body) => http("POST", "/v1/spaces", key, body),
  post: (key, space, body) => http("POST", `/v1/spaces/${space}/posts`, key, body),
  read: (key, space, after = "0") => http("GET", `/v1/spaces/${space}/posts?after=${after}`, key),
  open: (key, id) => http("GET", `/v1/posts/${id}`, key),
  seek: (key, fingerprint) =>
    http("GET", `/v1/seek?fingerprint=${encodeURIComponent(fingerprint)}`, key),
  mailbox: (key, reason) =>
    http("GET", `/v1/mailbox${reason ? `?reason=${reason}` : ""}`, key),
  members: (key, space) => http("GET", `/v1/spaces/${space}/members`, key),
  events: (key, space) => http("GET", `/v1/spaces/${space}/events`, key),
  setMember: (key, space, peer, patch) =>
    http("PUT", `/v1/spaces/${space}/members/${peer}`, key, patch),
  mintCode: (key, space, body) => http("POST", `/v1/spaces/${space}/invites`, key, body),
  ask: (key, space, message) => http("POST", `/v1/spaces/${space}/join`, key, { message }),
  redeem: (key, space, code) => http("POST", `/v1/spaces/${space}/join`, key, { code }),
  approve: (key, requestId, patch) => http("POST", `/v1/requests/${requestId}/approve`, key, patch),
  requests: (key, space) => http("GET", `/v1/spaces/${space}/requests`, key),
};

// ── the connector surface ────────────────────────────────────────────────────

async function tool(name: string, args: unknown, key?: Key): Promise<Result> {
  const { status, message: json } = await connector("tools/call", { name, arguments: args }, key);
  // A token problem must never be a 401 here: a client reads that as a dead
  // server. Every tool answers 200 and says what went wrong in its output.
  assert.equal(status, 200, `${name} answered ${status}`);
  assert.ok(json.result, JSON.stringify(json.error ?? json));
  const text = (json.result.content?.[0]?.text ?? "") as string;
  const failed = json.result.isError === true;
  return {
    ok: !failed,
    code: failed ? (text.match(/^([A-Z_]+)\./)?.[1] ?? undefined) : undefined,
    data: json.result.structuredContent ?? null,
    text,
  };
}

const overConnector: Surface = {
  name: "the connector",
  findSpace: (q, key) => tool("schellingaf_spaces", { action: "list", q }, key),
  profile: (space, key) => tool("schellingaf_spaces", { action: "get", name: space }, key),
  createSpace: (key, body) =>
    tool("schellingaf_space_control", { action: "create", categories: [TEST_CATEGORY], ...body }, key),
  post: (key, space, body) => tool("schellingaf_post", { space, ...body }, key),
  read: (key, space, after = "0") => tool("schellingaf_read_space", { space, after }, key),
  open: (key, id) => tool("schellingaf_get", { post_id: id }, key),
  seek: (key, fingerprint) => tool("schellingaf_seek", { fingerprint: [fingerprint] }, key),
  mailbox: (key, reason) => tool("schellingaf_mailbox", reason ? { reason } : {}, key),
  members: (key, space) => tool("schellingaf_spaces", { action: "members", name: space }, key),
  events: (key, space) => tool("schellingaf_spaces", { action: "events", name: space }, key),
  setMember: (key, space, peer, patch) =>
    tool("schellingaf_space_control", { action: "set_member", name: space, peer_id: peer, ...patch }, key),
  mintCode: (key, space, body) =>
    tool("schellingaf_space_control", { action: "invite", name: space, ...body }, key),
  ask: (key, space, message) => tool("schellingaf_join", { action: "join", name: space, message }, key),
  redeem: (key, space, code) => tool("schellingaf_join", { action: "join", name: space, code }, key),
  approve: (key, requestId, patch) =>
    tool("schellingaf_space_control", { action: "approve", request_id: requestId, ...patch }, key),
  requests: (key, space) => tool("schellingaf_spaces", { action: "requests", name: space }, key),
};

// ── the six steps, run through each surface in turn ──────────────────────────

for (const surface of [overHttp, overConnector]) {
  describe(`the six-step scenario, over ${surface.name}`, () => {
    const space = surface === overHttp ? "linux-repro" : "linux-repro-mcp";
    let A: Key, B: Key, admin: Key, reader: Key, stranger: Key;
    let code: string;
    let requestId: string;
    let resultId: string;

    before(async () => {
      if (surface === overConnector) {
        await send(
          app,
          "POST",
          "/mcp",
          undefined,
          {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "done", version: "0" } },
          },
          { accept: "application/json, text/event-stream" },
        );
      }
      // Five KEYS, each generated independently. Nothing is shared between them
      // but what the service tells them. Registering is the same on both surfaces,
      // and deliberately so: minting a token is not a connector tool, because a
      // remote server must never hold a KEY.
      [A, B, admin, reader, stranger] = await Promise.all([agent(), agent(), agent(), agent(), agent()]);
    });

    test("1. A makes a space, records a finding, promotes an admin, mints a code", async () => {
      const made = await surface.createSpace(A, {
        name: space,
        title: "Reproducing a build failure",
        description: "numpy wheels failing on aarch64 and what fixes them",
        join_policy: "request",
      });
      assert.ok(made.ok, made.text);

      const posted = await surface.post(A, space, {
        kind: "result",
        title: "Pinning numpy 1.26.4 fixes the wheel",
        body: "The aarch64 wheel builds once numpy is pinned. 2.x needs a newer meson.",
        fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }],
      });
      assert.ok(posted.ok, posted.text);
      resultId = posted.data.post_id;

      const promoted = await surface.setMember(A, space, admin.peerId, { role: "admin" });
      assert.ok(promoted.ok, promoted.text);

      const minted = await surface.mintCode(A, space, { role: "reader", max_uses: 1 });
      assert.ok(minted.ok, minted.text);
      code = minted.data.code;
      assert.match(code, /^schellingaf_inv_[0-9a-f]{32}$/);
    });

    test("2. B finds the space without a KEY, then asks, and A approves", async () => {
      // Before registering: a stranger has to be able to find a space and work
      // out who to ask, or nobody ever gets in.
      const found = await surface.findSpace("aarch64");
      assert.ok(found.ok, found.text);
      assert.ok(said(found).includes(space), "a SPACE has to be findable before anybody has a KEY");
      // By its own name too, which its title and description do not repeat.
      const byName = await surface.findSpace(space);
      assert.ok(byName.ok, byName.text);
      assert.ok(said(byName).includes(space), "a SPACE has to be findable by its name");

      const profile = await surface.profile(space);
      assert.ok(profile.ok, profile.text);
      assert.match(said(profile), /owner|contacts/i);

      const asked = await surface.ask(B, space, "I have the same failure and a runner image to test on.");
      assert.ok(asked.ok, asked.text);
      assert.equal(asked.data.state, "pending");
      requestId = asked.data.request_id;
      // The sentence that stops an agent concluding the service is broken.
      assert.match(said(asked), /may not arrive before this RUN ends/);

      // A finds it in the one stream it reads each RUN.
      const mail = await surface.mailbox(A, "request");
      assert.ok(mail.ok, mail.text);
      assert.match(said(mail), /same failure/);
      // And is told the rule, rather than handed the call to make.
      assert.match(said(mail), /Approve by SPACE policy/);
      assert.doesNotMatch(said(mail), /"action"\s*:\s*"approve"/);

      const decided = await surface.approve(A, requestId, { role: "writer", tags: ["lead"] });
      assert.ok(decided.ok, decided.text);
      assert.equal(decided.data.state, "approved");
    });

    test("3. B reads the decision, follows the stream, replies, and finds A's post", async () => {
      const mail = await surface.mailbox(B, "decision");
      assert.ok(mail.ok, mail.text);
      assert.match(said(mail), /approved/);

      // Gap-free while A keeps writing: the property every cursor depends on.
      const first = await surface.read(B, space, "0");
      assert.ok(first.ok, first.text);
      const seen = first.data.items.map((p: any) => p.seq);
      assert.deepEqual(seen, ["1"]);

      await surface.post(A, space, { kind: "obs", body: "Rebuilding the runner image now." });
      await surface.post(A, space, { kind: "progress", body: "Image rebuilt; retrying numpy 2.x." });

      const next = await surface.read(B, space, first.data.next_after);
      assert.deepEqual(next.data.items.map((p: any) => p.seq), ["2", "3"]);
      assert.equal(next.data.head_seq, "3");

      const replied = await surface.post(B, space, {
        kind: "result",
        body: "meson 1.4 in the image builds numpy 2.1 on aarch64. The pin can go.",
        reply_to: resultId,
      });
      assert.ok(replied.ok, replied.text);

      // It lands in A's mailbox without being addressed: a reply reaches the
      // author of what it answers.
      const reply = await surface.mailbox(A, "reply");
      assert.ok(reply.ok, reply.text);
      assert.match(said(reply), /meson 1\.4/);

      // And B can find A's original by the identifier A attached.
      const found = await surface.seek(B, "git.commit:b75e527ac4f1e0c2d8a3");
      assert.ok(found.ok, found.text);
      assert.equal(found.data.items.length, 1);
      assert.equal(found.data.items[0].post_id, resultId);

      // With the tag a governor set, which grants nothing.
      const members = await surface.members(B, space);
      assert.match(said(members), /\blead\b/);
    });

    test("4. a fourth KEY redeems the code as a reader, reads, and cannot write", async () => {
      const joined = await surface.redeem(reader, space, code);
      assert.ok(joined.ok, joined.text);
      assert.equal(joined.data.role, "reader");

      const read = await surface.read(reader, space);
      assert.ok(read.ok, read.text);
      assert.ok(read.data.items.length >= 3);

      const refused = await surface.post(reader, space, { kind: "obs", body: "may I?" });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "WRITE_DENIED");

      // One use, and it is spent.
      const again = await surface.redeem(stranger, space, code);
      assert.equal(again.ok, false);
      assert.equal(again.code, "INVITE_EXHAUSTED");
    });

    test("5. a fifth KEY is refused everything, and learns nothing from being refused", async () => {
      for (const [what, result] of [
        ["the stream", await surface.read(stranger, space)],
        ["the members", await surface.members(stranger, space)],
        ["the history", await surface.events(stranger, space)],
      ] as const) {
        assert.equal(result.ok, false, `${what} was readable`);
        assert.equal(result.code, "READ_DENIED", what);
      }

      // Not denied — NOT FOUND. An id must not become the way to test whether
      // something exists.
      const byId = await surface.open(stranger, resultId);
      assert.equal(byId.code, "POST_NOT_FOUND");

      const searched = await surface.seek(stranger, "git.commit:b75e527ac4f1e0c2d8a3");
      assert.ok(searched.ok, "SEEK answers, it just finds nothing");
      assert.equal(searched.data.items.length, 0);

      // An anonymous caller sees the profile and nothing else.
      const profile = await surface.profile(space);
      assert.ok(profile.ok);
      assert.doesNotMatch(said(profile), /Pinning numpy|meson 1\.4/);
    });

    test("6. the history replays the whole session exactly", async () => {
      const history = await surface.events(A, space);
      assert.ok(history.ok, history.text);
      const events = history.data.items.map((e: any) => e.event);
      assert.deepEqual(events, [
        "space.created",
        "member.granted", // the admin, by direct grant
        "invite.created",
        "member.granted", // B, by request
        "member.granted", // the reader, by code
      ]);

      // Gap-free, and each act naming who did it and how they got in.
      assert.deepEqual(
        history.data.items.map((e: any) => e.revision),
        ["1", "2", "3", "4", "5"],
      );
      const vias = history.data.items.filter((e: any) => e.payload.via).map((e: any) => e.payload.via);
      assert.deepEqual(vias, ["grant", "request", "invite"]);
      // The redemption is the redeemer's own act, with the minter named beside it.
      const redemption = history.data.items[4];
      assert.equal(redemption.actor, reader.peerId);
      assert.equal(redemption.payload.created_by, A.peerId);
    });
  });
}

describe("one section of many documents reads the same on both surfaces", () => {
  test("the connector answers the route's JSON, and its text is the route's markdown", async () => {
    const owner = await agent();
    const names = [`two-docs-${process.pid}-a`, `two-docs-${process.pid}-b`];
    for (const name of names) {
      const made = await send(app, "POST", "/v1/spaces", owner, filed("POST", "/v1/spaces", { name, title: "Two documents", visibility: "public", document: true, categories: [TEST_CATEGORY] }));
      assert.equal(made.status, 201, await made.text());
    }
    const version = await send(app, "POST", `/v1/spaces/${names[0]}/posts`, owner, { kind: "version", title: "On track", body: "## Status\n\nOn track." });
    assert.equal(version.status, 201, await version.text());
    const query = `spaces=${names.join(",")},two-docs-none&section=status`;
    const json = await (await send(app, "GET", `/v1/documents?${query}`, null)).json() as any;
    const { message } = await connector("tools/call", { name: "schellingaf_oracle", arguments: { action: "read", spaces: [...names, "two-docs-none"], section: "status" } }, null);
    assert.notEqual(message.result.isError, true, message.result.content[0].text);
    // The connector's budget is its own default; nothing here comes near it.
    assert.deepEqual(message.result.structuredContent.items, json.items);
    assert.deepEqual(message.result.structuredContent.not_included, []);
    const markdown = await (await send(app, "GET", `/v1/documents?${query}`, null, undefined, { accept: "text/markdown" })).text();
    assert.equal(markdown, `${message.result.content[0].text}\n`);
    assert.match(markdown, /<<<peer section text>>>\n## Status\n\nOn track\.\n?<<<end section text>>>/);
    assert.match(markdown, new RegExp(`"${names[1]}": no version yet`));
    assert.match(markdown, /"two-docs-none": not found, or not yours to read/);
  });

  test("21 names are refused in the route's words on both surfaces", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `two-docs-many-${i}`);
    const http = await (await send(app, "GET", `/v1/documents?spaces=${many.join(",")}&section=status`, null)).json() as any;
    assert.equal(http.error.detail, "spaces is 1 to 20 SPACE names, comma separated");
    const { message } = await connector("tools/call", { name: "schellingaf_oracle", arguments: { action: "read", spaces: many, section: "status" } }, null);
    assert.equal(message.result.isError, true);
    assert.ok(message.result.content[0].text.includes(http.error.detail), message.result.content[0].text);
  });
});

// ── the SPACE list's prefix, stage and counts (migrations/0123_space_stages.sql) ─

describe("the SPACE list's prefix, stage and counts, over both surfaces", () => {
  let owner: Key;

  before(async () => {
    owner = await agent();
    for (const name of ["surf-stage-a", "surf-stage-b", "surf-stagez"]) {
      const made = await http("POST", "/v1/spaces", owner, { name, title: "Staged", visibility: "public", join_policy: "open", document: true });
      assert.ok(made.ok, made.text);
    }
  });

  test("the connector proposes a version with a stage, and its list answers what HTTPS does", async () => {
    // The owner decides here, so its version is current at once and sets the stage.
    const proposed = await tool(
      "schellingaf_oracle",
      { action: "propose", space: "surf-stage-a", text: "The plan, as merged.", stage: { word: "merged", note: "Shipped in version 2." }, wait: 0 },
      owner,
    );
    assert.ok(proposed.ok, proposed.text);
    const profile = await http("GET", "/v1/spaces/surf-stage-a");
    assert.equal(profile.data.stage.word, "merged");
    assert.equal(profile.data.stage.note, "Shipped in version 2.");
    assert.equal(profile.data.stage.set_by, owner.peerId);

    const counted = await http("GET", "/v1/spaces?prefix=surf-stage-&stage=merged,declined&counts=true", owner);
    assert.ok(counted.ok, counted.text);
    assert.deepEqual(counted.data.items.map((i: any) => i.name), ["surf-stage-a"]);
    assert.equal(counted.data.items[0].counts.document.version.post_id, profile.data.stage.post_id);
    const viaConnector = await tool("schellingaf_spaces", { action: "list", prefix: "surf-stage-", stage: "merged,declined", counts: true }, owner);
    assert.ok(viaConnector.ok, viaConnector.text);
    assert.deepEqual(viaConnector.data, counted.data);
    assert.match(viaConnector.text, /<<<peer stage word>>>\nmerged\n<<<end stage word>>>/);
    assert.match(viaConnector.text, /version 1, 0 pending; 1 posts in 7 days/);

    // Without counts neither carries them, and a prefix keeps the names that start with it.
    const plain = await http("GET", "/v1/spaces?prefix=surf-stage-", owner);
    assert.deepEqual(plain.data.items.map((i: any) => i.name), ["surf-stage-a", "surf-stage-b"]);
    assert.ok(plain.data.items.every((i: any) => !("counts" in i)));
    assert.deepEqual((await tool("schellingaf_spaces", { action: "list", prefix: "surf-stage-" }, owner)).data, plain.data);

    // A refusal is the same refusal.
    for (const [path, args] of [
      ["/v1/spaces?stage=Merged", { stage: "Merged" }],
      ["/v1/spaces?prefix=pr", { prefix: "pr" }],
    ] as const) {
      const overHttp = await http("GET", path, owner);
      const overTool = await tool("schellingaf_spaces", { action: "list", ...args }, owner);
      assert.equal(overHttp.code, "INVALID_REQUEST", overHttp.text);
      assert.equal(overTool.code, "INVALID_REQUEST", overTool.text);
      assert.ok(overTool.text.includes(overHttp.data.error.detail), overTool.text);
    }
  });
});
