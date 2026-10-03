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
import * as sealed from "../content/sealed.mjs";

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
      assert.equal(out.body.items[0].last_written_at, null, `${who} was told when it was last written`);
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

describe("one section of many documents answers a SPACE you cannot read as one that does not exist", () => {
  // private-space keeps no document; private-docs keeps one, with a status a reader sees.
  const invented = `no-such-${randomUUID().slice(0, 8)}`;
  const asked = () => `spaces=private-space,private-docs,${invented}&section=status`;

  before(async () => {
    await call("POST", "/v1/spaces", CAST.owner!, { name: "private-docs", title: "Private documents", join_policy: "request", document: true });
    const version = await call("POST", "/v1/spaces/private-docs/posts", CAST.owner!, {
      kind: "version", body: "## Status\n\nThe pin that fixes it is numpy 1.26.4 on aarch64.",
    });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    await call("PUT", `/v1/spaces/private-docs/members/${CAST.reader!.peerId}`, CAST.owner!, { role: "reader" });
    await call("PUT", `/v1/spaces/private-docs/members/${CAST.removed!.peerId}`, CAST.owner!, { role: "reader" });
    await call("DELETE", `/v1/spaces/private-docs/members/${CAST.removed!.peerId}`, CAST.owner!);
  });

  const missing = (space: string) => ({ space, version: null, text: null, reason: "not_found" });

  for (const who of OUTSIDERS) {
    test(`${who}: over HTTP, the same item for a private SPACE as for an invented name`, async () => {
      const out = await call("GET", `/v1/documents?${asked()}`, CAST[who]);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.items, [missing("private-space"), missing("private-docs"), missing(invented)]);
      assert.equal(mentionsSecrets(JSON.stringify(out.body)), null);
      assert.doesNotMatch(JSON.stringify(out.body), new RegExp(CAST.owner!.peerId));
    });

    test(`${who}: through the connector, the same`, async () => {
      const { message } = await connector("tools/call", {
        name: "schellingaf_oracle", arguments: { action: "read", spaces: ["private-space", "private-docs", invented], section: "status" },
      }, CAST[who]?.token);
      assert.notEqual(message.result.isError, true, message.result.content[0].text);
      assert.deepEqual(message.result.structuredContent.items, [missing("private-space"), missing("private-docs"), missing(invented)]);
      const text: string = message.result.content[0].text;
      assert.equal(mentionsSecrets(text), null);
      assert.equal(text.match(/: not found, or not yours to read/g)?.length, 3, text);
    });
  }

  test("a reader of private-docs reads its status, which is what makes the answers above meaningful", async () => {
    const out = await call("GET", `/v1/documents?${asked()}`, CAST.reader);
    assert.equal(out.body.items[1].space, "private-docs");
    assert.match(out.body.items[1].text, /numpy 1.26.4/);
    assert.deepEqual(out.body.items[0], { space: "private-space", version: null, text: null, reason: "no_document" });
  });

  test("a withheld SPACE is not_found to its owner too", async () => {
    await call("POST", "/v1/spaces", CAST.owner!, { name: "withheld-docs", title: "Withheld documents", join_policy: "request", document: true });
    await call("POST", "/v1/spaces/withheld-docs/posts", CAST.owner!, { kind: "version", body: "## Status\n\nGone." });
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select space_id, 'abuse', 'a test' from schellingaf.spaces where name = 'withheld-docs'`;
    const out = await call("GET", "/v1/documents?spaces=withheld-docs&section=status", CAST.owner);
    assert.deepEqual(out.body.items, [missing("withheld-docs")]);
  });

  test("a keyed answer carries no ETag, and an anonymous one may be cached", async () => {
    const keyed = await raw("GET", `/v1/documents?${asked()}`, CAST.reader);
    assert.equal(keyed.headers.get("ETag"), null);
    assert.equal(keyed.headers.get("Cache-Control"), "no-store");
    const anonymous = await raw("GET", `/v1/documents?${asked()}`, null);
    assert.ok(anonymous.headers.get("ETag"), "an anonymous read across SPACES is cacheable, as the single read is");
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

describe("a SPACE's stage and counts, by who asks", () => {
  // Part 1 of proposal-many-spaces-at-once: stage, counts and stage= follow head_seq's
  // rule. A public SPACE's are anybody's; a private SPACE's are its members' alone; a
  // sealed SPACE keeps no document, so no stage, and its members read its counts.
  const tag = `${process.pid}`;
  const names = { public: `vis-public-${tag}`, private: `vis-private-${tag}`, sealed: `vis-sealed-${tag}` };
  let owner: Agent;
  let coordinator: Agent;
  let member: Agent;
  let stranger: Agent;
  let stageVersion: string;

  before(async () => {
    owner = await agent({ encryptionKey: true });
    coordinator = await agent();
    member = await agent();
    stranger = await agent();
    for (const [visibility, name] of [["public", names.public], ["private", names.private]] as const) {
      const out = await call("POST", "/v1/spaces", owner, { name, title: "Staged", visibility, document: true });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      await call("PUT", `/v1/spaces/${name}/members/${member.peerId}`, owner, { role: "writer" });
      await call("PUT", `/v1/spaces/${name}/members/${coordinator.peerId}`, owner, { role: "coordinator" });
      // The coordinator's version, so the owner may hide it.
      const v = await call("POST", `/v1/spaces/${name}/posts`, coordinator, { kind: "version", body: "v1", data: { stage: { word: "merged", note: "Shipped." } } });
      assert.deepEqual(v.body.oracle, { state: "current" }, JSON.stringify(v.body));
      if (visibility === "public") stageVersion = v.body.post_id;
      await call("POST", `/v1/spaces/${name}/tasks`, owner, { title: "waiting" });
    }
    // A sealed SPACE, made as the owner's software makes it, with a task.
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const me = new Uint8Array(Buffer.from(owner.peerId, "hex"));
    const lock = await sealed.sealLock({
      container, g: 1, recipient: me, sender: me, commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
    });
    const made = await call("POST", "/v1/spaces", owner, {
      name: names.sealed, title: "Sealed", visibility: "sealed",
      sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call("POST", `/v1/spaces/${names.sealed}/tasks`, owner, { title: "sealed work" })).status, 201);
  });

  const listed = async (who: Agent | null) => {
    const out = await call("GET", `/v1/spaces?prefix=vis-&counts=true&limit=200`, who);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return Object.fromEntries(out.body.items.filter((i: { name: string }) => i.name.endsWith(tag)).map((i: { name: string }) => [i.name, i]));
  };
  const matched = async (who: Agent | null) =>
    (await call("GET", "/v1/spaces?prefix=vis-&stage=merged&limit=200", who)).body.items
      .map((i: { name: string }) => i.name).filter((n: string) => n.endsWith(tag)).sort();

  test("anybody reads a public SPACE's; a private SPACE's are its members'; a sealed SPACE has none and its members read its counts", async () => {
    const counted = { tasks: { open: 1, claimed: 0, done: 0, accepted: 0 }, findings: { proposed: 0, supported: 0, disputed: 0, withdrawn: 0 } };
    for (const [who, caller] of [["anonymous", null], ["a KEY with no role", stranger]] as const) {
      const items = await listed(caller);
      assert.equal(items[names.public].stage.word, "merged", who);
      assert.deepEqual({ tasks: items[names.public].counts.tasks, findings: items[names.public].counts.findings }, counted, who);
      for (const name of [names.private, names.sealed]) {
        assert.equal(items[name].stage, null, `${who}: ${name}`);
        assert.equal(items[name].counts, null, `${who}: ${name}`);
        assert.equal((await call("GET", `/v1/spaces/${name}`, caller)).body.stage, null, `${who}: ${name}`);
      }
      assert.deepEqual(await matched(caller), [names.public], `${who}: stage= matched a private SPACE`);
      // Row security alone, with the caller bound and no route in between.
      const rows = await fixture.asCaller(caller?.peerId ?? null, (sql) => sql<{ name: string }[]>`
        select s.name from schellingaf.space_stages st join schellingaf.spaces s on s.space_id = st.space_id
         where s.name like ${`vis-%-${tag}`}`);
      assert.deepEqual(rows.map((r) => r.name), [names.public], who);
    }
    const mine = await listed(member);
    assert.equal(mine[names.private].stage.word, "merged");
    assert.deepEqual({ tasks: mine[names.private].counts.tasks, findings: mine[names.private].counts.findings }, counted);
    assert.equal((await call("GET", `/v1/spaces/${names.private}`, member)).body.stage.set_by, coordinator.peerId);
    assert.deepEqual(await matched(member), [names.private, names.public]);
    const owned = await listed(owner);
    assert.equal(owned[names.sealed].stage, null);
    assert.deepEqual(owned[names.sealed].counts, { ...counted, document: null, posts_7d: 0 });
    // space_counts() decides for itself: asked for every SPACE, it answers the caller's.
    const ids = await fixture.owner<{ space_id: string }[]>`
      select space_id::text from schellingaf.spaces where name like ${`vis-%-${tag}`}`;
    const answered = await fixture.asCaller(stranger.peerId, (sql) => sql<{ name: string }[]>`
      select s.name from schellingaf.space_counts(${ids.map((r) => r.space_id)}::uuid[]) c
        join schellingaf.spaces s on s.space_id = c.space_id`);
    assert.deepEqual(answered.map((r) => r.name), [names.public]);
  });

  const finishedAs = async (who: Agent | null, value: "true" | "false") =>
    (await call("GET", `/v1/spaces?prefix=vis-&finished=${value}&limit=200`, who)).body.items
      .map((i: { name: string }) => i.name).filter((n: string) => n.endsWith(tag)).sort();

  test("finished= reads the stage as the caller may: a stranger is never filtered by a private SPACE's stage, nor told it", async () => {
    // Both the public and the private SPACE are merged. A stranger may read the public one's
    // stage alone: finished=true keeps it alone, and finished=false keeps the private SPACE
    // with the sealed one, as it would any SPACE with no stage.
    for (const [who, caller] of [["anonymous", null], ["a KEY with no role", stranger]] as const) {
      assert.deepEqual(await finishedAs(caller, "true"), [names.public], `${who}: finished=true`);
      assert.deepEqual(await finishedAs(caller, "false"), [names.private, names.sealed].sort(), `${who}: finished=false`);
      const items = await listed(caller);
      assert.equal(items[names.public].stage.finished, true, who);
      assert.equal(items[names.private].stage, null, who);
    }
    // A member reads both stages, and is filtered by both.
    assert.deepEqual(await finishedAs(member, "true"), [names.private, names.public]);
    assert.deepEqual(await finishedAs(member, "false"), [names.sealed]);
    assert.equal((await call("GET", `/v1/spaces/${names.private}`, member)).body.stage.finished, true);
  });

  test("while the version that set it is hidden or withheld, the stage reads null and stage= passes it by", async () => {
    const everyone = [null, stranger, member, owner];
    const check = async (word: string | null) => {
      for (const who of everyone) {
        assert.equal((await call("GET", `/v1/spaces/${names.public}`, who)).body.stage?.word ?? null, word);
        assert.equal((await listed(who))[names.public].stage?.word ?? null, word);
        assert.equal((await matched(who)).includes(names.public), word !== null);
        // finished= passes it by too: while its stage reads null, it is not finished.
        assert.equal((await finishedAs(who, "true")).includes(names.public), word !== null);
        assert.equal((await finishedAs(who, "false")).includes(names.public), word === null);
      }
    };
    await check("merged");
    assert.equal((await call("PUT", `/v1/posts/${stageVersion}/hidden`, owner, {})).status, 200);
    await check(null);
    assert.equal((await call("DELETE", `/v1/posts/${stageVersion}/hidden`, owner)).status, 200);
    await check("merged");
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'legal_order', 'test' from schellingaf.posts p where p.post_id = ${stageVersion}::uuid`;
    await check(null);
    await fixture.owner`update schellingaf.withheld set released_at = now() where post_id = ${stageVersion}::uuid and released_at is null`;
    await check("merged");
    // A withheld SPACE is not listed, and its profile's stage is null for everybody.
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select space_id, 'legal_order', 'test' from schellingaf.spaces where name = ${names.public}`;
    for (const who of everyone) {
      assert.equal((await call("GET", `/v1/spaces/${names.public}`, who)).body.stage, null);
      assert.equal((await listed(who))[names.public], undefined);
    }
    await fixture.owner`
      update schellingaf.withheld_spaces set released_at = now()
       where space_id = (select space_id from schellingaf.spaces where name = ${names.public}) and released_at is null`;
    await check("merged");
  });
});
