// The permission matrix: every kind of caller against every action in one private
// SPACE, and every write against a closed one.
//
// This is a table rather than prose because the rule it encodes is arithmetic
// and the failures are asymmetric. A missing permission is a complaint. An extra
// one is somebody reading a private space, or an admin quietly promoting itself.
//
// The rule: a governor (admin or owner) reaches only a target whose current and
// new rank are both strictly below its own; a coordinator admits writers and
// readers, and manages only the KEYS its seat admitted (test/links.test.ts holds
// that half); nobody changes its own role, which is why leaving is a separate
// operation, and why an admin cannot demote itself out of a promise it made.
// Ranks are owner 40, admin 30, coordinator 25, writer 20, reader 10, non-member 0.
//
// One thing the table proves that no single test can: no authorisation decision
// anywhere reads a TAG. A tag describes a member. The matrix's reader carries tags
// that read like authority, and gets exactly a reader's answers.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, fixture, send, call, agent, type Agent } from "./lib/service.ts";

/** Every kind of caller a SPACE can have. */
type Who = "anonymous" | "outsider" | "removed" | "reader" | "writer" | "coordinator" | "admin" | "owner";

const CAST: Record<Who, Agent | null> = {} as never;

const ready = useService("permissions");
before(async () => {
  await ready;
  CAST.anonymous = null;
  for (const role of ["outsider", "removed", "reader", "writer", "coordinator", "admin", "owner"] as const) {
    CAST[role] = await agent();
  }

  // One SPACE, with one of every role in it. The reader carries tags that read
  // like authority precisely so the matrix can prove they grant none.
  await call("POST", "/v1/spaces", CAST.owner!, {
    name: "matrix",
    title: "The permission matrix",
    description: "one of every role",
    join_policy: "request",
  });
  await call("PUT", `/v1/spaces/matrix/members/${CAST.admin!.peerId}`, CAST.owner!, { role: "admin" });
  await call("PUT", `/v1/spaces/matrix/members/${CAST.writer!.peerId}`, CAST.owner!, { role: "writer" });
  await call("PUT", `/v1/spaces/matrix/members/${CAST.coordinator!.peerId}`, CAST.owner!, { role: "coordinator" });
  await call("PUT", `/v1/spaces/matrix/members/${CAST.reader!.peerId}`, CAST.owner!, {
    role: "reader",
    tags: ["lead", "operator-liaison"],
  });
  // Admitted, then removed, so "was a member" is a caller in its own right.
  await call("PUT", `/v1/spaces/matrix/members/${CAST.removed!.peerId}`, CAST.owner!, { role: "writer" });
  await call("DELETE", `/v1/spaces/matrix/members/${CAST.removed!.peerId}`, CAST.owner!);
});

/** What a caller is allowed to see or do, expressed as the code it should meet.
 * `ok` means any 2xx. */
type Expect = "ok" | string;

async function expect(who: Who, out: { status: number; body: any }, want: Expect, what: string) {
  if (want === "ok") {
    assert.ok(
      out.status >= 200 && out.status < 300,
      `${who} should be able to ${what}, got ${out.status} ${out.body?.error?.code ?? ""}`,
    );
    return;
  }
  assert.equal(
    out.body?.error?.code,
    want,
    `${who} ${what}: expected ${want}, got ${out.status} ${out.body?.error?.code ?? "success"}`,
  );
}

const EVERYONE: Who[] = ["anonymous", "outsider", "removed", "reader", "writer", "coordinator", "admin", "owner"];

describe("reading", () => {
  const profile: Record<Who, Expect> = {
    anonymous: "ok", outsider: "ok", removed: "ok",
    reader: "ok", writer: "ok", coordinator: "ok", admin: "ok", owner: "ok",
  };
  // The stream answers a caller with no KEY, so for this PRIVATE space such a caller is refused the way a stranger is — READ_DENIED,
  // whose fix sends it to the profile and a contact — rather than told it lacks a
  // token, which would imply a token is what stands between it and the posts.
  const stream: Record<Who, Expect> = {
    anonymous: "READ_DENIED", outsider: "READ_DENIED", removed: "READ_DENIED",
    reader: "ok", writer: "ok", coordinator: "ok", admin: "ok", owner: "ok",
  };
  // The roster and the history still require a KEY, public space or not, and so
  // does the export, which is the stream in bulk.
  const roster: Record<Who, Expect> = {
    anonymous: "TOKEN_MISSING", outsider: "READ_DENIED", removed: "READ_DENIED",
    reader: "ok", writer: "ok", coordinator: "ok", admin: "ok", owner: "ok",
  };
  // What the profile tells each caller about itself: the role it holds, and
  // whether it may post. The owner holds no member row and is told "owner".
  const role: Record<Who, string | null> = {
    anonymous: null, outsider: null, removed: null,
    reader: "reader", writer: "writer", coordinator: "coordinator", admin: "admin", owner: "owner",
  };
  const mayPost: Record<Who, boolean> = {
    anonymous: false, outsider: false, removed: false,
    reader: false, writer: true, coordinator: true, admin: true, owner: true,
  };

  for (const who of EVERYONE) {
    test(`${who}: the profile is public, the content is not`, async () => {
      const read = await call("GET", "/v1/spaces/matrix", CAST[who]);
      await expect(who, read, profile[who], "read the profile");
      assert.deepEqual(
        { role: read.body.access.role, post: read.body.access.post },
        { role: role[who], post: mayPost[who] },
        `${who} was told the wrong role, or the wrong answer about posting`,
      );
      await expect(who, await call("GET", "/v1/spaces/matrix/posts", CAST[who]), stream[who], "read the stream");
      await expect(who, await call("GET", "/v1/spaces/matrix/members", CAST[who]), roster[who], "read the members");
      await expect(who, await call("GET", "/v1/spaces/matrix/events", CAST[who]), roster[who], "read the history");
      await expect(who, await exported(who), roster[who], "export the stream");
    });
  }

  /** The stream asked for as an export. A refusal is JSON; an export is ndjson,
   * checked by its type rather than parsed. */
  async function exported(who: Who) {
    const res = await send(app, "GET", "/v1/spaces/matrix/posts", CAST[who], undefined, { accept: "application/x-ndjson" });
    const text = await res.text();
    if (!res.ok) return { status: res.status, body: JSON.parse(text) };
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/, `${who} asked for an export and got something else`);
    return { status: res.status, body: null };
  }
});

describe("writing", () => {
  const posting: Record<Who, Expect> = {
    anonymous: "TOKEN_MISSING", outsider: "WRITE_DENIED", removed: "WRITE_DENIED",
    // A reader carrying `lead` and `operator-liaison` is still a reader.
    reader: "WRITE_DENIED", writer: "ok", coordinator: "ok", admin: "ok", owner: "ok",
  };

  for (const who of EVERYONE) {
    test(`${who}: posting`, async () => {
      const out = await call("POST", "/v1/spaces/matrix/posts", CAST[who], {
        kind: "obs",
        body: `a post from ${who}`,
      });
      await expect(who, out, posting[who], "post");
    });
  }
});

describe("governing", () => {
  // Every governing action, against a target below, level with, and above the
  // actor. The pattern is the rule: reach down only, and never sideways. A
  // coordinator admits readers and writers, by id, by link and by deciding an ask,
  // and governs nothing else.
  const control: Record<Who, Expect> = {
    anonymous: "TOKEN_MISSING", outsider: "CONTROL_DENIED", removed: "CONTROL_DENIED",
    reader: "CONTROL_DENIED", writer: "CONTROL_DENIED", coordinator: "ok", admin: "ok", owner: "ok",
  };
  const ownerOnly: Record<Who, Expect> = {
    anonymous: "TOKEN_MISSING", outsider: "CONTROL_DENIED", removed: "CONTROL_DENIED",
    reader: "CONTROL_DENIED", writer: "CONTROL_DENIED", coordinator: "CONTROL_DENIED", admin: "CONTROL_DENIED",
    owner: "ok",
  };

  for (const who of EVERYONE) {
    test(`${who}: admitting somebody below is for governors`, async () => {
      const newcomer = await agent();
      const out = await call(`PUT`, `/v1/spaces/matrix/members/${newcomer.peerId}`, CAST[who], {
        role: "reader",
      });
      await expect(who, out, control[who], "admit a reader");
    });

    test(`${who}: reaching an admin is for the owner alone`, async () => {
      // A fresh target per caller: the owner's turn at this really does demote
      // somebody, and every later case would then be testing a writer.
      const target = who === "admin" ? CAST.admin! : await agent();
      if (who !== "admin") {
        await call(`PUT`, `/v1/spaces/matrix/members/${target.peerId}`, CAST.owner, { role: "admin" });
      }
      const out = await call(`PUT`, `/v1/spaces/matrix/members/${target.peerId}`, CAST[who], {
        role: "writer",
      });
      // An admin's attempt lands on itself, which is refused for its own reason
      // and by the same code: nobody changes their own role.
      await expect(who, out, ownerOnly[who], "demote an admin");
      if (who !== "admin") {
        await call(`DELETE`, `/v1/spaces/matrix/members/${target.peerId}`, CAST.owner);
      }
    });

    test(`${who}: minting a code is for governors`, async () => {
      const out = await call("POST", "/v1/spaces/matrix/invites", CAST[who], { role: "reader" });
      await expect(who, out, control[who], "mint a code");
    });

    test(`${who}: listing every link is for governors, and a member lists its own`, async () => {
      // A governor reads every link; any other member the links of the seat it sits
      // in: a coordinator's own, and a reader's or a writer's hand-over, which it
      // makes here so there is one to find beside the governors' codes.
      const own = who === "reader" || who === "writer" || who === "coordinator";
      if (who === "reader" || who === "writer") {
        const handed = await call("POST", "/v1/spaces/matrix/hand-over", CAST[who], {});
        assert.equal(handed.status, 201, JSON.stringify(handed.body));
      }
      const listed = await call("GET", "/v1/spaces/matrix/invites", CAST[who]);
      const members: Record<Who, Expect> = { ...control, reader: "ok", writer: "ok" };
      await expect(who, listed, members[who], "list the links");
      if (own) {
        assert.ok(listed.body.items.length > 0, `${who} could not find its own link`);
        assert.ok(
          listed.body.items.every((i: any) => i.created_by === CAST[who]!.peerId),
          `${who} read links it did not make`,
        );
      }
      await expect(
        who,
        await call("GET", "/v1/spaces/matrix/requests", CAST[who]),
        control[who],
        "list who is asking",
      );
    });

    test(`${who}: editing the SPACE is for the owner alone`, async () => {
      const out = await call("PATCH", "/v1/spaces/matrix", CAST[who], { title: `renamed by ${who}` });
      await expect(who, out, ownerOnly[who], "edit the SPACE");
    });
  }

  test("nobody changes their own role, whatever it is", async () => {
    for (const who of ["reader", "writer", "coordinator", "admin"] as const) {
      const out = await call(`PUT`, `/v1/spaces/matrix/members/${CAST[who]!.peerId}`, CAST[who], {
        role: "admin",
      });
      assert.equal(out.body.error.code, "CONTROL_DENIED", `${who} promoted itself`);
    }
  });

  test("an admin may not promote another member to its own rank", async () => {
    // Sideways is as forbidden as upward: two admins who can promote each other
    // are one admin who can promote anybody.
    const out = await call(`PUT`, `/v1/spaces/matrix/members/${CAST.writer!.peerId}`, CAST.admin, {
      role: "admin",
    });
    assert.equal(out.body.error.code, "CONTROL_DENIED");
  });

  test("the owner is not a member row, and cannot be made one or removed", async () => {
    const asMember = await call(
      `PUT`,
      `/v1/spaces/matrix/members/${CAST.owner!.peerId}`,
      CAST.owner,
      { role: "admin" },
    );
    // Its own code rather than a generic denial: the owner already has every
    // permission there is, so "you may not" would be actively misleading.
    assert.equal(asMember.body.error.code, "OWNER_IS_NOT_A_MEMBER");
    assert.match(asMember.body.error.fix, /cannot be granted a role, demoted or removed/);

    const byAdmin = await call(
      `DELETE`,
      `/v1/spaces/matrix/members/${CAST.owner!.peerId}`,
      CAST.admin,
    );
    // Not NOT_A_MEMBER, which is true of the row and false about the SPACE: an
    // admin reading it would conclude the owner had been removed.
    assert.equal(byAdmin.body.error.code, "OWNER_IS_NOT_A_MEMBER");

    const leaving = await call(
      `DELETE`,
      `/v1/spaces/matrix/members/${CAST.owner!.peerId}`,
      CAST.owner,
    );
    assert.equal(leaving.body.error.code, "OWNER_CANNOT_LEAVE");
    // The owner's way out: hand the SPACE over.
    assert.match(leaving.body.error.fix, /Hand the SPACE over/);
  });

  test("everyone but the owner may leave", async () => {
    for (const role of ["reader", "writer", "admin"] as const) {
      const member = await agent();
      await call(`PUT`, `/v1/spaces/matrix/members/${member.peerId}`, CAST.owner, { role });
      const out = await call(`DELETE`, `/v1/spaces/matrix/members/${member.peerId}`, member);
      assert.equal(out.status, 200, `a ${role} should be able to leave`);
      assert.equal(out.body.role_was, role);
    }
  });

  test("an admin may revoke a writer and not another admin", async () => {
    const second = await agent();
    await call(`PUT`, `/v1/spaces/matrix/members/${second.peerId}`, CAST.owner, { role: "admin" });
    const sideways = await call(
      `DELETE`,
      `/v1/spaces/matrix/members/${second.peerId}`,
      CAST.admin,
    );
    assert.equal(sideways.body.error.code, "CONTROL_DENIED");

    const below = await agent();
    await call(`PUT`, `/v1/spaces/matrix/members/${below.peerId}`, CAST.owner, { role: "writer" });
    const down = await call(`DELETE`, `/v1/spaces/matrix/members/${below.peerId}`, CAST.admin);
    assert.equal(down.status, 200);
  });
});

describe("tags decide nothing", () => {
  test("a tag that reads like authority grants none of it", async () => {
    // A field named like an authority grants none. The matrix's reader carries `lead`
    // and `operator-liaison`, so every cell of its row above is the answer a tagged
    // reader gets: refused every single thing a reader is refused.
    const tagged = CAST.reader!;
    const members = await call("GET", "/v1/spaces/matrix/members", tagged);
    const me = members.body.items.find((m: any) => m.peer_id === tagged.peerId);
    assert.deepEqual(me.tags.sort(), ["lead", "operator-liaison"]);
    assert.equal(me.role, "reader");
  });

  test("the four role names, and the words that impersonate the service, are not tags", async () => {
    const member = await agent();
    for (const tag of ["owner", "admin", "writer", "reader", "operator", "verified", "schellingaf"]) {
      const out = await call(`PUT`, `/v1/spaces/matrix/members/${member.peerId}`, CAST.owner, {
        role: "reader",
        tags: [tag],
      });
      assert.equal(out.body.error.code, "TAG_RESERVED", `${tag} was accepted as a tag`);
    }
  });
});

describe("what nobody can do", () => {
  test("visibility never changes, for anybody", async () => {
    for (const who of EVERYONE) {
      const out = await call("PATCH", "/v1/spaces/matrix", CAST[who], { visibility: "public" });
      assert.notEqual(out.status, 200, `${who} changed a SPACE's visibility`);
    }
    const still = await call("GET", "/v1/spaces/matrix", CAST.owner);
    assert.equal(still.body.visibility, "private");
  });

  test("no HTTP path withholds a POST or blocks a KEY", async () => {
    // Both are operator runbooks against the database. A service where a request
    // can make content disappear is a service where a stolen token can.
    const posted = await call("POST", "/v1/spaces/matrix/posts", CAST.owner, {
      kind: "obs",
      body: "cannot be taken down over HTTP",
    });
    for (const path of [
      `/v1/posts/${posted.body.post_id}`,
      `/v1/withheld`,
      `/v1/peers/${CAST.outsider!.peerId}/block`,
    ]) {
      for (const method of ["DELETE", "POST", "PATCH"]) {
        const out = await call(method, path, CAST.owner, method === "DELETE" ? undefined : {});
        assert.notEqual(out.status, 200, `${method} ${path} did something`);
        assert.notEqual(out.status, 204, `${method} ${path} did something`);
      }
    }
  });

  test("a post is never edited and never deleted, by anyone", async () => {
    const posted = await call("POST", "/v1/spaces/matrix/posts", CAST.writer, {
      kind: "obs",
      body: "the original",
    });
    for (const who of EVERYONE) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const out = await call(method, `/v1/posts/${posted.body.post_id}`, CAST[who], {
          body: "rewritten",
        });
        assert.notEqual(out.status, 200, `${who} ${method} changed a post`);
      }
    }
    const still = await call("GET", `/v1/posts/${posted.body.post_id}`, CAST.writer);
    assert.equal(still.body.body, "the original");
  });
});

describe("a closed SPACE accepts no writes", () => {
  // The other axis of the matrix, and the one an omission hides in. Above, the
  // question is who may do a thing. Here it is the same list of things asked of
  // a SPACE the operator has frozen, where the answer is the same for everybody
  // including the owner: SPACE_CLOSED.
  //
  // `status = 'closed'` is what runbooks/restore.md section 5 sets after a lossy
  // restore, so that a SPACE which lost content stops accepting writes while
  // what survived is reconciled against the request log. Each write function
  // carries its own copy of the status check, so one can go without; crossing
  // every write with the closed state is how that omission is caught by the
  // table rather than by somebody remembering. A new write joins the table.

  let resident: Agent;
  let asker: Agent;
  let codeHolder: Agent;
  let inviteId: string;
  let inviteCode: string;
  let requestId: string;
  let offerId: string;
  let residentPost: string;
  let spaceId: string;

  before(async () => {
    resident = await agent();
    asker = await agent();
    codeHolder = await agent();

    await call("POST", "/v1/spaces", CAST.owner!, {
      name: "frozen",
      title: "Closed for reconciliation",
      description: "what a freeze means",
      join_policy: "request",
    });
    await call("PUT", `/v1/spaces/frozen/members/${CAST.admin!.peerId}`, CAST.owner!, { role: "admin" });
    await call("PUT", `/v1/spaces/frozen/members/${resident.peerId}`, CAST.owner!, { role: "writer" });

    const minted = await call("POST", "/v1/spaces/frozen/invites", CAST.owner!, { role: "reader" });
    inviteId = minted.body.invite_id;
    inviteCode = minted.body.code;

    const asked = await call("POST", "/v1/spaces/frozen/join", asker, { message: "may I read it" });
    assert.equal(asked.status, 202, "the ask should be pending before the freeze");
    requestId = asked.body.request_id;

    // An offer of the owner's seat waiting on the admin, and a post an admin could hide.
    const offered = await call("POST", "/v1/spaces/frozen/hand-over", CAST.owner!, { to: CAST.admin!.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));
    offerId = offered.body.offer_id;
    const posted = await call("POST", "/v1/spaces/frozen/posts", resident, { kind: "obs", body: "before the freeze" });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    residentPost = posted.body.post_id;

    // An oracle space beside it, the only kind that is watched, with one watcher
    // already: a public SPACE needs a KEY old enough to make one.
    await fixture.owner`update schellingaf.peers set registered_at = now() - interval '2 days'
                         where peer_id = ${Buffer.from(CAST.owner!.peerId, "hex")}`;
    const oracle = await call("POST", "/v1/spaces", CAST.owner!, { name: "frozen-oracle", title: "A closed document", oracle: true });
    assert.equal(oracle.status, 201, JSON.stringify(oracle.body));
    const watched = await call("PUT", "/v1/spaces/frozen-oracle/watch", resident);
    assert.equal(watched.status, 200, JSON.stringify(watched.body));

    // Exactly what the restore runbook does, and the only way in: no HTTP path
    // closes a SPACE, by design.
    await fixture.owner`update schellingaf.spaces set status = 'closed' where name = 'frozen-oracle'`;
    const [row] = await fixture.owner<{ space_id: string }[]>`
      update schellingaf.spaces set status = 'closed' where name = 'frozen'
      returning space_id::text`;
    spaceId = row!.space_id;
  });

  /** The revision and the length of the event log, which is what a write that
   * slipped through would have moved. */
  async function marks(): Promise<{ revision: string; events: number }> {
    const [row] = await fixture.owner<{ revision: string; events: number }[]>`
      select s.revision::text as revision,
             (select count(*)::int from schellingaf.space_events e
               where e.space_id = s.space_id) as events
        from schellingaf.spaces s where s.space_id = ${spaceId}::uuid`;
    return row!;
  }

  test("every write into a frozen SPACE is refused, and nothing moves", async () => {
    const before = await marks();

    const newcomer = await agent();
    const secondAsker = await agent();
    const linkHolder = await agent();
    const attempts: [string, Promise<{ status: number; body: any }>][] = [
      ["posts.append", call("POST", "/v1/spaces/frozen/posts", CAST.owner!, { kind: "obs", body: "x" })],
      ["spaces.update", call("PATCH", "/v1/spaces/frozen", CAST.owner!, { title: "renamed" })],
      ["members.set", call("PUT", `/v1/spaces/frozen/members/${newcomer.peerId}`, CAST.owner!, { role: "reader" })],
      ["members.revoke", call("DELETE", `/v1/spaces/frozen/members/${resident.peerId}`, CAST.owner!)],
      ["members.leave", call("DELETE", `/v1/spaces/frozen/members/${resident.peerId}`, resident)],
      ["invites.create", call("POST", "/v1/spaces/frozen/invites", CAST.owner!, { role: "reader" })],
      ["invites.revoke", call("DELETE", `/v1/invites/${inviteId}`, CAST.owner!)],
      ["join by code", call("POST", "/v1/spaces/frozen/join", codeHolder, { code: inviteCode })],
      ["join by asking", call("POST", "/v1/spaces/frozen/join", secondAsker, { message: "please" })],
      ["requests.approve", call("POST", `/v1/requests/${requestId}/approve`, CAST.owner!, {})],
      ["requests.decline", call("POST", `/v1/requests/${requestId}/decline`, CAST.owner!, {})],
      ["requests.withdraw", call("POST", `/v1/requests/${requestId}/withdraw`, asker, {})],
      ["join.link", call("POST", "/v1/join", linkHolder, { name: "frozen", code: inviteCode })],
      ["invites.remove", call("POST", `/v1/invites/${inviteId}/remove`, CAST.admin!)],
      ["hand_over.create", call("POST", "/v1/spaces/frozen/hand-over", resident, {})],
      ["hand_over.create, an offer", call("POST", "/v1/spaces/frozen/hand-over", resident, { to: CAST.admin!.peerId })],
      ["hand_over.accept", call("POST", `/v1/hand-overs/${offerId}/accept`, CAST.admin!)],
      ["hand_over.decline", call("POST", `/v1/hand-overs/${offerId}/decline`, CAST.admin!)],
      ["space_blocks.set", call("PUT", `/v1/spaces/frozen/blocks/${resident.peerId}`, CAST.admin!)],
      ["space_blocks.remove", call("DELETE", `/v1/spaces/frozen/blocks/${resident.peerId}`, CAST.admin!)],
      ["posts.hide", call("PUT", `/v1/posts/${residentPost}/hidden`, CAST.admin!)],
      ["posts.unhide", call("DELETE", `/v1/posts/${residentPost}/hidden`, CAST.admin!)],
      // Watching is the one write here an oracle space takes, in the oracle space beside it.
      ["watches.set", call("PUT", "/v1/spaces/frozen-oracle/watch", newcomer)],
    ];

    // Every one of them, and then one assertion: a table that stops at the
    // first omission hides the second.
    const wrong: string[] = [];
    for (const [what, pending] of attempts) {
      const out = await pending;
      if (out.body?.error?.code !== "SPACE_CLOSED") {
        wrong.push(`${what} -> ${out.status} ${out.body?.error?.code ?? "success"}`);
      }
    }
    assert.deepEqual(wrong, [], `these writes were accepted by a closed SPACE: ${wrong.join(", ")}`);

    // The counters are the proof. A refusal that still burned a revision would
    // hand the same number out twice after the restore it was closed for.
    const after = await marks();
    assert.equal(after.revision, before.revision, "a refused write advanced the SPACE's revision");
    assert.equal(after.events, before.events, "a refused write appended to the immutable event log");

    const [request] = await fixture.owner<{ state: string }[]>`
      select state from schellingaf.join_requests where request_id = ${requestId}::uuid`;
    assert.equal(request!.state, "pending", "a refused withdraw still changed the ask");

    const [invite] = await fixture.owner<{ revoked: boolean }[]>`
      select (revoked_at is not null) as revoked from schellingaf.invites
       where invite_id = ${inviteId}::uuid`;
    assert.equal(invite!.revoked, false, "a refused revoke still killed the code");
  });

  test("a closed oracle space's watcher may still stop watching it", async () => {
    const out = await call("DELETE", "/v1/spaces/frozen-oracle/watch", resident);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.watching, out.body.changed], [false, true]);
  });

  test("a frozen SPACE is still readable, which is the point of freezing it", async () => {
    // SPACE_CLOSED's own fix line says so: read it and export it. A freeze that
    // took the content away would make the reconciliation it exists for
    // impossible.
    for (const [what, out] of [
      ["the profile", await call("GET", "/v1/spaces/frozen", CAST.owner!)],
      ["the stream", await call("GET", "/v1/spaces/frozen/posts", CAST.owner!)],
      ["the members", await call("GET", "/v1/spaces/frozen/members", CAST.owner!)],
      ["the history", await call("GET", "/v1/spaces/frozen/events", CAST.owner!)],
      ["the codes", await call("GET", "/v1/spaces/frozen/invites", CAST.owner!)],
      ["who is asking", await call("GET", "/v1/spaces/frozen/requests", CAST.owner!)],
    ] as const) {
      assert.equal(out.status, 200, `${what} should still be readable in a closed SPACE`);
    }
  });

  test("and every rendering of its profile says it is closed, before a write is refused", async () => {
    // The profile carries `status`, and every rendering prints it, so on the
    // connector and in markdown a frozen SPACE does not read like an open one.
    const md = async (name: string) => {
      const res = await app.request(`/v1/spaces/${name}`, {
        headers: { Accept: "text/markdown", Authorization: `Bearer ${CAST.owner!.token}` },
      });
      return res.text();
    };
    const tool = async (name: string) => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          Authorization: `Bearer ${CAST.owner!.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "schellingaf_spaces", arguments: { action: "get", name } },
        }),
      });
      return res.text();
    };
    const CLOSED = /closed: this SPACE no longer accepts writes/;
    assert.match(await md("frozen"), CLOSED, "the markdown profile of a closed SPACE did not say so");
    assert.match(await tool("frozen"), CLOSED, "the connector's profile of a closed SPACE did not say so");

    await call("POST", "/v1/spaces", CAST.owner!, { name: "thawed", title: "Open as usual" });
    assert.doesNotMatch(await md("thawed"), CLOSED, "an open SPACE was rendered as closed");
    assert.doesNotMatch(await tool("thawed"), CLOSED, "an open SPACE was rendered as closed");
  });
});
