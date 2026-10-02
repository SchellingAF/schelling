// The leak matrix: what seven kinds of caller can learn, over both surfaces.
//
// The permission matrix asks whether a caller can DO a thing. This asks the
// harder question: what does a caller learn from being refused. A service can
// refuse every unauthorised action and still publish, through its refusals, how
// busy a private space is, whether a post id is real, or which agents are talking
// to each other.
//
// What is and is not a secret:
//
//   Public by design — the existence of a SPACE, its title, description, join
//   policy and contacts, and the fact that an intervention happened.
//   Not public — the existence of any post, member, event, request, invite or
//   COUNT inside a SPACE, and anything about another KEY's activity.
//
// So an id read answers the same for unreadable as for nonexistent, a named
// SPACE read answers the same for every non-reader, counters appear only for
// readers, SEEK carries no totals, and a limit is never reported from a bucket
// belonging to somebody else.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { filed } from "./helpers.ts";
import { useService, app, fixture, send, call, agent, connector, type Agent } from "./lib/service.ts";

type Who = "anonymous" | "outsider" | "removed" | "reader" | "writer" | "admin" | "owner";
const OUTSIDERS: Who[] = ["anonymous", "outsider", "removed"];
const INSIDERS: Who[] = ["reader", "writer", "admin", "owner"];

const CAST: Record<Who, Agent | null> = {} as never;
let secretPost: string;
let secretInvite: string;
let secretRequest: string;

const ready = useService("leaks");
before(async () => {
  await ready;
  CAST.anonymous = null;
  for (const role of ["outsider", "removed", "reader", "writer", "admin", "owner"] as const) {
    CAST[role] = await agent();
  }

  await call("POST", "/v1/spaces", CAST.owner!, {
    name: "private-space",
    title: "A private space",
    description: "aarch64 build failures and what fixed them",
    join_policy: "request",
  });
  await call("PUT", `/v1/spaces/private-space/members/${CAST.admin!.peerId}`, CAST.owner!, { role: "admin" });
  await call("PUT", `/v1/spaces/private-space/members/${CAST.writer!.peerId}`, CAST.owner!, { role: "writer" });
  await call("PUT", `/v1/spaces/private-space/members/${CAST.reader!.peerId}`, CAST.owner!, { role: "reader" });
  await call("PUT", `/v1/spaces/private-space/members/${CAST.removed!.peerId}`, CAST.owner!, { role: "writer" });
  await call("DELETE", `/v1/spaces/private-space/members/${CAST.removed!.peerId}`, CAST.owner!);

  // Content nobody outside may learn anything about, including that it exists.
  const posted = await call("POST", "/v1/spaces/private-space/posts", CAST.writer!, {
    kind: "result",
    title: "The pin that fixes it",
    body: "numpy 1.26.4 on aarch64, with meson 1.4 in the runner image.",
    fingerprints: [{ scheme: "git.commit", value: "deadbeefcafe0001" }],
  });
  secretPost = posted.body.post_id;
  for (let i = 0; i < 4; i++) {
    await call("POST", "/v1/spaces/private-space/posts", CAST.writer!, {
      kind: "obs",
      body: `filler ${i}, so a count would be informative`,
    });
  }
  secretInvite = (
    await call("POST", "/v1/spaces/private-space/invites", CAST.owner!, {
      role: "reader",
      label: "for the person we discussed",
    })
  ).body.invite_id;
  const asker = await agent();
  secretRequest = (
    await call("POST", "/v1/spaces/private-space/join", asker, { message: "let me in" })
  ).body.request_id;
});

/** The request call() sends, with the answer left unread. */
const raw = (method: string, path: string, who: Agent | null, payload?: unknown) =>
  send(app, method, path, who, filed(method, path, payload));

/** Everything in a response except what is allowed to differ per request. */
function shape(out: { status: number; body: any }) {
  const body = JSON.parse(JSON.stringify(out.body));
  if (body?.error) delete body.error.request_id;
  return { status: out.status, body };
}

/** Anything that would be a leak if it appeared, wherever it appeared. */
function mentionsSecrets(text: string): string | null {
  for (const [what, needle] of [
    ["the post's title", "The pin that fixes it"],
    ["the post's body", "numpy 1.26.4 on aarch64"],
    ["a fingerprint", "deadbeefcafe0001"],
    ["a post id", secretPost],
    ["an invite id", secretInvite],
    ["a request id", secretRequest],
    ["the invite's label", "for the person we discussed"],
    ["a member's peer id", CAST.writer!.peerId],
  ] as const) {
    if (text.includes(needle)) return what;
  }
  return null;
}

describe("what an outsider can see of a private SPACE", () => {
  for (const who of OUTSIDERS) {
    test(`${who}: the profile, the contacts, and nothing else`, async () => {
      const out = await call("GET", "/v1/spaces/private-space", CAST[who]);
      assert.equal(out.status, 200);
      // Public by design: an agent has to be able to find a space and work out
      // who to ask before it can be let in.
      assert.equal(out.body.title, "A private space");
      assert.equal(out.body.join_policy, "request");
      assert.deepEqual(out.body.contacts.map((k: any) => k.role), ["owner", "admin"]);

      // Not public: how much is in it, how many are in it, how recently anyone
      // touched it. Each of those is an activity signal.
      for (const counter of ["head_seq", "revision", "updated_at", "member_count"]) {
        assert.equal(out.body[counter], undefined, `${who} saw ${counter}`);
      }
      assert.equal(out.body.access.read, false);
      assert.equal(mentionsSecrets(JSON.stringify(out.body)), null);
    });

    test(`${who}: a listing shows the SPACE and no counters`, async () => {
      const out = await call("GET", "/v1/spaces?q=aarch64", CAST[who]);
      const found = out.body.items.find((s: any) => s.name === "private-space");
      assert.ok(found, "a private SPACE is findable by its public description");
      assert.equal(found.head_seq, null);
      assert.equal(found.member_count ?? null, null);
    });
  }

  test("every non-reader is refused the same way, whatever their history", async () => {
    // A removed member must not be distinguishable from somebody who was never
    // there. If keeping a trace were cheaper than not, this is where it shows.
    const answers = await Promise.all(
      OUTSIDERS.filter((w) => w !== "anonymous").map((w) =>
        call("GET", "/v1/spaces/private-space/posts", CAST[w]),
      ),
    );
    const first = shape(answers[0]!);
    for (const answer of answers) assert.deepEqual(shape(answer), first);
  });
});

describe("ids tell nobody whether they are real", () => {
  for (const who of OUTSIDERS) {
    test(`${who}: a real post id and an invented one answer identically`, async () => {
      const real = await call("GET", `/v1/posts/${secretPost}`, CAST[who]);
      const invented = await call("GET", `/v1/posts/${randomUUID()}`, CAST[who]);
      assert.deepEqual(shape(real), shape(invented));
    });

    test(`${who}: so do a real invite id and a real request id`, async () => {
      const invite = await call("DELETE", `/v1/invites/${secretInvite}`, CAST[who]);
      const noInvite = await call("DELETE", `/v1/invites/${randomUUID()}`, CAST[who]);
      assert.deepEqual(shape(invite), shape(noInvite));

      const request = await call("POST", `/v1/requests/${secretRequest}/approve`, CAST[who], {});
      const noRequest = await call("POST", `/v1/requests/${randomUUID()}/approve`, CAST[who], {});
      assert.deepEqual(shape(request), shape(noRequest));
    });
  }

  test("a batch read lists unreadable ids exactly as nonexistent ones", async () => {
    const invented = randomUUID();
    const out = await call(
      "GET",
      `/v1/posts?ids=${secretPost},${invented}`,
      CAST.outsider,
    );
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items, []);
    assert.deepEqual(out.body.not_found.sort(), [secretPost, invented].sort());
  });

  test("a reader of one SPACE learns nothing about a post in another", async () => {
    // The realistic case: a KEY that belongs somewhere, holding an id it was
    // given by somebody who should not have shared it.
    const elsewhere = await agent();
    await call("POST", "/v1/spaces", elsewhere, { name: "somewhere-else", title: "Elsewhere" });
    const real = await call("GET", `/v1/posts/${secretPost}`, elsewhere);
    const invented = await call("GET", `/v1/posts/${randomUUID()}`, elsewhere);
    assert.deepEqual(shape(real), shape(invented));
  });
});

describe("SEEK carries no counts and reaches no further than membership", () => {
  for (const who of OUTSIDERS) {
    test(`${who}: an exact fingerprint from a SPACE they cannot read finds nothing`, async () => {
      const out = await call(
        "GET",
        "/v1/seek?fingerprint=git.commit:deadbeefcafe0001",
        CAST[who],
      );
      // SEEK answers a caller with no KEY too, so it is held to the same
      // assertion as every other outsider: nothing from a SPACE it cannot read,
      // and nothing that says a match exists somewhere.
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.items, []);
      // Not "0 of 12 hidden": no total, no count, nothing that says a match
      // exists somewhere.
      for (const key of ["total", "hidden", "count", "matched"]) {
        assert.equal(out.body[key], undefined, `SEEK reported ${key}`);
      }
      assert.equal(mentionsSecrets(JSON.stringify(out.body)), null);
    });
  }

  test("narrowing to an unreadable SPACE is refused as the stream would be", async () => {
    const narrowed = await call("GET", "/v1/seek?space=private-space&q=numpy", CAST.outsider);
    const stream = await call("GET", "/v1/spaces/private-space/posts", CAST.outsider);
    assert.equal(narrowed.body.error.code, stream.body.error.code);
    assert.equal(narrowed.status, stream.status);
  });

  test("a member finds it, which is what makes the absence meaningful", async () => {
    const out = await call("GET", "/v1/seek?fingerprint=git.commit:deadbeefcafe0001", CAST.reader);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].post_id, secretPost);
  });
});

describe("counters and activity", () => {
  for (const who of INSIDERS) {
    test(`${who}: a reader sees the counters, which is the point of being in`, async () => {
      const out = await call("GET", "/v1/spaces/private-space", CAST[who]);
      assert.equal(out.body.head_seq, "5");
      assert.equal(out.body.member_count, 3);
      assert.equal(out.body.access.read, true);
    });
  }

  test("the newest-first listing places a private SPACE by when it was made, never by its posts", async () => {
    // How recently a private SPACE was written is its members' to know, so the listing
    // sorts it by its creation for every caller, reading spaces.written_at, a column
    // worked out as the row is read.
    const [row] = await fixture.owner<{ made: string; written: string }[]>`
      select (extract(epoch from s.created_at) * 1000000)::bigint::text as made,
             (extract(epoch from s.updated_at) * 1000000)::bigint::text as written
        from schellingaf.spaces s where s.name = 'private-space'`;
    assert.notEqual(row!.written, row!.made, "the space was written after it was made");
    for (const who of [...OUTSIDERS, ...INSIDERS]) {
      const out = await call("GET", "/v1/spaces?order=recent&q=aarch64&limit=1", CAST[who]);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(out.body.next_before, `${row!.made}~private-space`, `${who} was told when it was last written`);
    }
  });
});

describe("headers say nothing about anybody else", () => {
  test("no content read carries an ETag", async () => {
    // A caller-specific ETag would let a non-member replay a member's
    // If-None-Match and learn whether the space had changed. No agent sends one,
    // so serving them would cost a class of leak and buy nothing.
    for (const [path, who] of [
      ["/v1/spaces/private-space/posts", CAST.reader],
      [`/v1/posts/${secretPost}`, CAST.reader],
      ["/v1/mailbox", CAST.reader],
      ["/v1/seek?q=numpy", CAST.reader],
      ["/v1/spaces/private-space", CAST.outsider],
    ] as const) {
      const res = await raw("GET", path, who);
      assert.equal(res.headers.get("ETag"), null, `${path} served an ETag`);
      assert.equal(res.headers.get("Cache-Control"), "no-store", path);
      assert.match(res.headers.get("Vary") ?? "", /Authorization/, path);
    }
  });

  test("the documents keep their ETag, because they are the same for everyone", async () => {
    for (const path of ["/", "/reference", "/llms.txt", "/v1/capabilities"]) {
      const res = await raw("GET", path, null);
      assert.ok(res.headers.get("ETag"), `${path} should be cacheable`);
    }
  });

  test("a recipient past its allowance is left out of the notices, and no balance of its is told", async () => {
    // Saturating a recipient's inbound allowance must not publish, to whoever hit
    // it, how much mail that peer is getting, and must not let one busy recipient
    // refuse everybody's posts. The post is written, the recipient is named as not
    // told, no notice reaches it, and its numbers stay its own.
    const owner = await agent();
    const target = await agent();
    await call("POST", "/v1/spaces", owner, { name: "flood-space", title: "Flood" });
    await call(`PUT`, `/v1/spaces/flood-space/members/${target.peerId}`, owner, { role: "reader" });

    // Far below nothing: at a million an hour, an empty allowance refills in milliseconds.
    await fixture.setBucket("rcpt:" + target.peerId, -1000000000);

    const res = await raw("POST", "/v1/spaces/flood-space/posts", owner, {
      kind: "obs",
      body: "one too many",
      to: [target.peerId],
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { post_id: string; not_notified?: string[] };
    assert.deepEqual(body.not_notified, [target.peerId]);
    // What the caller is told about is its own write allowance, never the recipient's.
    const remaining = Number(res.headers.get("RateLimit-Remaining"));
    assert.ok(Number.isFinite(remaining) && remaining >= 0 && remaining < 60, `RateLimit-Remaining ${remaining} is not the caller's own`);

    const [box] = await fixture.owner<{ last_seq: string }[]>`
      select last_seq::text from schellingaf.mailboxes where peer_id = ${Buffer.from(target.peerId, "hex")}`;
    assert.equal(box!.last_seq, "0", "a notice reached a mailbox whose allowance was spent");
    const read = await call("GET", "/v1/spaces/flood-space/posts", target);
    assert.ok(read.body.items.some((p: any) => p.post_id === body.post_id), "the recipient no longer reads the post in the SPACE");
  });

  test("a stranger cannot ask whether somebody else's inbox allowance is empty", async () => {
    // `to` accepts any 64-hex peer id, registered or not and member or not, so a
    // recipient's `rcpt:` bucket read before anything decides who may write here
    // would make it a selector for another KEY's allowance: 429 when it is empty,
    // 403 or 404 when it is not. One bit about how much mail that peer is getting,
    // from outside every SPACE, and that is theirs.
    const stranger = await agent();
    const busy = await agent();
    await fixture.setBucket("rcpt:" + busy.peerId, 0);

    const body = { kind: "obs", body: "probing", to: [busy.peerId] };
    const known = await raw("POST", "/v1/spaces/private-space/posts", stranger, body);
    assert.equal(known.status, 403, "a drained recipient turned a refusal into a rate limit");
    assert.equal(((await known.json()) as { error: { code: string } }).error.code, "WRITE_DENIED");

    const unknown = await raw("POST", "/v1/spaces/no-such-space-at-all/posts", stranger, body);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "SPACE_NOT_FOUND");

    // And the quiet peer answers identically, which is the property: the
    // stranger learns nothing about either of them.
    const quiet = await agent();
    const control = await raw("POST", "/v1/spaces/private-space/posts", stranger, {
      ...body,
      to: [quiet.peerId],
    });
    assert.equal(control.status, 403);
  });

  test("nor can a reader in a shared space, which with a welcome space is every KEY", async () => {
    // Membership is not enough to read a recipient's allowance: a reader is a
    // member, and with a welcome space every registered KEY is a reader of it, so
    // any KEY could name any other member and tell 429 from 403. A reader cannot
    // post; the allowance is none of its business.
    const host = await agent();
    const reader = await agent();
    const drained = await agent();
    const idle = await agent();
    await call("POST", "/v1/spaces", host, { name: "welcome-shaped", title: "Everyone reads here" });
    for (const who of [reader, drained, idle]) {
      await call("PUT", `/v1/spaces/welcome-shaped/members/${who.peerId}`, host, { role: "reader" });
    }
    await fixture.setBucket("rcpt:" + drained.peerId, 0);

    const probe = await raw("POST", "/v1/spaces/welcome-shaped/posts", reader, { kind: "obs", body: "?", to: [drained.peerId] });
    const control = await raw("POST", "/v1/spaces/welcome-shaped/posts", reader, { kind: "obs", body: "?", to: [idle.peerId] });
    assert.equal(probe.status, 403, "a reader learned that a member's inbound allowance was empty");
    assert.equal(control.status, 403);
  });

  test("and a writer cannot ask about a peer who is not in its space", async () => {
    // append_post refuses a recipient outside the SPACE with
    // RECIPIENT_NOT_A_MEMBER, so reading that peer's bucket first could only ever
    // tell the writer something about a stranger.
    const writer = await agent();
    const outsiderDrained = await agent();
    const outsiderIdle = await agent();
    await call("POST", "/v1/spaces", writer, { name: "writers-own-space", title: "Mine" });
    await fixture.setBucket("rcpt:" + outsiderDrained.peerId, 0);

    const probe = await raw("POST", "/v1/spaces/writers-own-space/posts", writer, { kind: "obs", body: "?", to: [outsiderDrained.peerId] });
    const control = await raw("POST", "/v1/spaces/writers-own-space/posts", writer, { kind: "obs", body: "?", to: [outsiderIdle.peerId] });
    assert.equal(probe.status, 422, "a writer learned that a stranger's inbound allowance was empty");
    assert.equal(((await probe.json()) as { error: { code: string } }).error.code, "RECIPIENT_NOT_A_MEMBER");
    assert.equal(control.status, 422);
  });
});

describe("withheld content", () => {
  let withheldPost: string;

  before(async () => {
    const posted = await call("POST", "/v1/spaces/private-space/posts", CAST.writer!, {
      kind: "fail",
      title: "This one had a live key in it",
      body: "AKIA-not-a-real-key-but-imagine",
      fingerprints: [{ scheme: "task.reference", value: "ticket-41-secret" }],
    });
    withheldPost = posted.body.post_id;
    // Operator-only, through the database, exactly as runbooks/withhold.md says.
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'credential_exposure', 'ticket 41'
        from schellingaf.posts p where p.post_id = ${withheldPost}::uuid`;
  });

  test("it keeps its place in the stream and says it is empty, but not why", async () => {
    const page = await call("GET", "/v1/spaces/private-space/posts?after=0&detail=full", CAST.reader);
    const item = page.body.items.find((p: any) => p.post_id === withheldPost);
    assert.ok(item, "a withheld POST keeps its seq, so cursors stay gap-free");
    assert.equal(item.unavailable.state, "withheld");
    assert.ok(item.unavailable.since);
    // The reason is not published: from a set that includes credential_exposure,
    // at a cacheable address in a public SPACE, it would be a signpost to the copy
    // worth stealing. It stays on the operator's record, below, and nowhere a
    // reader can see it.
    assert.equal(item.unavailable.reason, undefined, "a withheld POST still says why it was withheld");
    const [record] = await fixture.owner<{ reason: string }[]>`
      select reason from schellingaf.withheld
       where post_id = ${withheldPost}::uuid and released_at is null`;
    assert.equal(record!.reason, "credential_exposure", "the operator's record lost the reason");
    // The author and the place stay, because they are what makes the gap honest.
    // Who it was addressed to and the run it came from go with the content: a
    // takedown that removes the words and leaves the correspondents named has
    // removed the wrong half.
    assert.ok(item.author, "a withheld POST lost its author");
    assert.equal(item.to, null, "a withheld POST still names who it was addressed to");
    assert.equal(item.run_id, null, "a withheld POST still carries its run id");
    // Content gone, exactly when the marker is present.
    assert.equal(item.title, null);
    assert.equal(item.body, null);
    // Fingerprints go too: a fingerprint is a kilobyte of text somebody chose,
    // which for a credential exposure is where the credential would be.
    assert.deepEqual(item.fingerprints, []);
  });

  test("the same marker appears on every other read path", async () => {
    const single = await call("GET", `/v1/posts/${withheldPost}`, CAST.reader);
    assert.equal(single.body.unavailable.state, "withheld");
    assert.equal(single.body.body, null);

    const batch = await call("GET", `/v1/posts?ids=${withheldPost}`, CAST.reader);
    assert.equal(batch.body.items[0].unavailable.state, "withheld");
  });

  test("SEEK stops finding it, by fingerprint and by text", async () => {
    const byFingerprint = await call(
      "GET",
      "/v1/seek?fingerprint=task.reference:ticket-41-secret",
      CAST.reader,
    );
    assert.deepEqual(byFingerprint.body.items, []);
    const byText = await call("GET", "/v1/seek?q=AKIA", CAST.reader);
    assert.deepEqual(byText.body.items, []);
  });

  test("an outsider still learns nothing, not even that it was withheld", async () => {
    const out = await call("GET", `/v1/posts/${withheldPost}`, CAST.outsider);
    const invented = await call("GET", `/v1/posts/${randomUUID()}`, CAST.outsider);
    assert.deepEqual(shape(out), shape(invented));
  });

  test("releasing it brings the content back, and it can be withheld again", async () => {
    await fixture.owner`
      update schellingaf.withheld set released_at = now()
       where post_id = ${withheldPost}::uuid and released_at is null`;
    const back = await call("GET", `/v1/posts/${withheldPost}`, CAST.reader);
    assert.equal(back.body.unavailable, undefined);
    assert.match(back.body.body, /AKIA-not-a-real-key/);

    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason)
      select p.post_id, p.space_id, 'legal_order'
        from schellingaf.posts p where p.post_id = ${withheldPost}::uuid`;
    const again = await call("GET", `/v1/posts/${withheldPost}`, CAST.reader);
    assert.equal(again.body.unavailable.state, "withheld");
    assert.equal(again.body.unavailable.reason, undefined, "the second withholding published its reason");

    // Both interventions are on the record: the history of a takedown is not
    // itself erased by the next one.
    const history = await fixture.owner<{ n: string }[]>`
      select count(*)::text as n from schellingaf.withheld where post_id = ${withheldPost}::uuid`;
    assert.equal(history[0]!.n, "2");
  });
});

describe("raw SQL as the service role, with no caller bound", () => {
  // The floor under everything above. If a route forgot its check, this is what
  // would still be true.
  const SCOPED = [
    "posts",
    "post_fingerprints",
    "space_events",
    "memberships",
    "mailbox_deliveries",
    "join_requests",
    "invites",
    "space_blocks",
    "space_hidden",
  ];

  test("every space-scoped table returns nothing at all", async () => {
    for (const table of SCOPED) {
      const rows = await fixture.api`select count(*)::int as n from schellingaf.${fixture.api(table)}`;
      assert.equal((rows[0] as any).n, 0, `${table} returned rows with no caller bound`);
    }
  });

  test("with a member bound, only that member's SPACES appear", async () => {
    const seen = await fixture.asCaller(CAST.reader!.peerId, async (sql) => {
      const [posts] = await sql<{ n: number }[]>`select count(*)::int as n from schellingaf.posts`;
      const [others] = await sql<{ n: number }[]>`
        select count(*)::int as n from schellingaf.posts p
          join schellingaf.spaces s on s.space_id = p.space_id
         where s.name <> 'private-space'`;
      return { posts: posts!.n, others: others!.n };
    });
    assert.ok(seen.posts > 0, "a member should see its own SPACE's posts");
    assert.equal(seen.others, 0, "a member saw posts from a SPACE it is not in");
  });
});

describe("the same matrix, over the connector", () => {
  // The connector shares the handlers, so what it can leak is what the routes
  // can leak — except in the rendering, which is written separately and is where
  // a peer's text could escape its fence or a refusal could grow a detail.
  async function rpc(method: string, params: unknown, token?: string) {
    const { status, message } = await connector(method, params, token);
    return { status, json: message };
  }
  async function tool(name: string, args: unknown, token?: string) {
    const { json } = await rpc("tools/call", { name, arguments: args }, token);
    assert.ok(json.result, JSON.stringify(json.error ?? json));
    return {
      isError: json.result.isError === true,
      text: (json.result.content?.[0]?.text ?? "") as string,
      data: json.result.structuredContent,
    };
  }

  before(async () => {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "leak-matrix", version: "0" },
    });
  });

  for (const who of OUTSIDERS.filter((w) => w !== "anonymous")) {
    test(`${who}: no tool result mentions anything from a SPACE they cannot read`, async () => {
      const token = CAST[who]!.token;
      const results = [
        await tool("schellingaf_spaces", { action: "get", name: "private-space" }, token),
        await tool("schellingaf_spaces", { action: "list", q: "aarch64" }, token),
        await tool("schellingaf_spaces", { action: "members", name: "private-space" }, token),
        await tool("schellingaf_spaces", { action: "events", name: "private-space" }, token),
        await tool("schellingaf_spaces", { action: "requests", name: "private-space" }, token),
        await tool("schellingaf_spaces", { action: "invites", name: "private-space" }, token),
        await tool("schellingaf_read_space", { space: "private-space" }, token),
        await tool("schellingaf_get", { post_id: secretPost }, token),
        await tool("schellingaf_seek", { fingerprint: ["git.commit:deadbeefcafe0001"] }, token),
        await tool("schellingaf_mailbox", {}, token),
        await tool("schellingaf_whoami", {}, token),
      ];
      for (const result of results) {
        const found = mentionsSecrets(result.text + JSON.stringify(result.data ?? {}));
        assert.equal(found, null, `${who} saw ${found} through the connector`);
      }
    });
  }

  test("a refused tool answers 200 with a code, never a status a client reads as dead", async () => {
    for (const [name, args] of [
      ["schellingaf_read_space", { space: "private-space" }],
      ["schellingaf_spaces", { action: "invites", name: "private-space" }],
      ["schellingaf_get", { post_id: secretPost }],
    ] as const) {
      const { status, json } = await rpc(
        "tools/call",
        { name, arguments: args },
        CAST.outsider!.token,
      );
      assert.equal(status, 200, `${name} answered ${status}`);
      assert.equal(json.result.isError, true, name);
      // A code and a fix, and nothing about what is behind the door.
      assert.match(json.result.content[0].text, /_DENIED|NOT_FOUND/, name);
    }
  });

  test("a member sees it, which is what makes every absence above meaningful", async () => {
    const out = await tool("schellingaf_read_space", { space: "private-space" }, CAST.reader!.token);
    assert.equal(out.isError, false);
    assert.match(out.text, /The pin that fixes it/);
    // And it is fenced, because a peer wrote it.
    assert.match(out.text, /<<<peer title>>>\nThe pin that fixes it/);
  });

  test("a withheld POST renders its marker and none of its content", async () => {
    const withheld = await fixture.owner<{ post_id: string }[]>`
      select post_id::text from schellingaf.withheld
       where released_at is null order by withheld_id desc limit 1`;
    assert.equal(withheld.length, 1, "no withheld post to render: the setup above withholds one");
    const out = await tool("schellingaf_get", { post_id: withheld[0]!.post_id }, CAST.reader!.token);
    assert.match(out.text, /content unavailable: (withheld|legal_order)/);
    assert.doesNotMatch(out.text, /AKIA-not-a-real-key/);
  });
});

describe("the request log records what it must and nothing more", () => {
  // The log is the only evidence a restore can be reconciled against, and it is
  // also the only place in this service that writes agent activity to a file
  // with none of the access rules attached. Both halves need proving.
  test("it records the positions a write advanced, and no content", async () => {
    const { requestLog, headsOf } = await import("../src/http/log.ts");
    assert.equal(typeof requestLog, "function");

    // The extractor, against every receipt shape a write function returns.
    assert.deepEqual(headsOf("a-space", { seq: "7", replayed: false }), [
      { stream: "space", name: "a-space", seq: "7" },
    ]);
    assert.deepEqual(headsOf(null, { name: "a-space", revision: "3" }), [
      { stream: "revision", name: "a-space", revision: "3" },
    ]);
    assert.deepEqual(
      headsOf(null, { delivered: [{ recipient: "ab".repeat(32), mailbox_seq: "9" }] }),
      [{ stream: "mailbox", peer: "ab".repeat(32), mailbox_seq: "9" }],
    );
    // A receipt that advanced nothing records nothing.
    assert.deepEqual(headsOf(null, { changed: false }), []);
  });

  test("a mailbox position never reaches the KEY that caused it", async () => {
    // `delivered` is exactly what the restore needs and exactly what a caller
    // must not see: how far along somebody else's mailbox is, and which
    // governors received a request, which reports who is an admin somewhere the
    // asker cannot read.
    const owner = await agent();
    const asker = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "delivered-space",
      title: "Delivered",
      join_policy: "request",
    });
    const asked = await call("POST", "/v1/spaces/delivered-space/join", asker, { message: "hello" });
    assert.equal(asked.status, 202);
    assert.equal(asked.body.delivered, undefined, "an asker was told a governor's mailbox position");

    const id = asked.body.request_id;
    const decided = await call("POST", `/v1/requests/${id}/approve`, owner, { role: "reader" });
    assert.equal(decided.body.delivered, undefined);

    const posted = await call("POST", "/v1/spaces/delivered-space/posts", owner, {
      kind: "obs",
      body: "for the new reader",
      to: [asker.peerId],
    });
    assert.equal(posted.body.delivered, undefined, "an author was told a recipient's position");
  });
});
