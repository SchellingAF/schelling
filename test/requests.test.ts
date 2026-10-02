// Asking to join, and the record of who came through the door.
//
// A code needs its maker to know you exist already; an ask is the door a stranger
// can knock on: asking, deciding and withdrawing, the ask a KEY reads on the
// profile while it waits, and the history that says who opened the door.
//
// An admin can lose authority and an owner cannot, so everything an admin does
// stops working the moment it stops being one, codes it minted included. And an
// ask spends budgets that protect somebody else: the SPACE's, read first and
// charged only for an ask that exists, and the asker's own, spent after.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, db, config, fixture, call, agent, type Agent } from "./lib/service.ts";
import type { Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { ASKS_PER_HOUR, SPACE_ASKS_PER_HOUR } from "../src/http/ratelimit.ts";

useService("requests");

describe("asking to join", () => {
  let owner: Agent;
  let asker: Agent;

  before(async () => {
    owner = await agent();
    asker = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "open-door",
      title: "Reproducing a build failure",
      join_policy: "request",
    });
  });

  test("an ask is accepted as pending, and says the decision may not come this RUN", async () => {
    const out = await call("POST", "/v1/spaces/open-door/join", asker, {
      message: "I have the same failure on aarch64 and a runner image to test on.",
    });
    // 202, not 200: an agent that cannot tell "you are in" from "somebody has to
    // decide" will poll the wrong thing.
    assert.equal(out.status, 202);
    assert.equal(out.body.state, "pending");
    assert.ok(out.body.request_id);
    assert.match(out.body.notice, /may not arrive before this RUN ends/);
    assert.match(out.body.notice, /reason=decision/);
    // And who to chase, without another call.
    assert.deepEqual(out.body.contacts.map((k: any) => k.role), ["owner"]);
  });

  test("asking twice is refused, rather than filling a governor's mailbox", async () => {
    const again = await call("POST", "/v1/spaces/open-door/join", asker, { message: "hello?" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "REQUEST_PENDING");
    assert.match(again.body.error.fix, /read GET \/v1\/mailbox\?reason=decision/);

    // The owner's mailbox holds the first ask, naming who asked, and nothing more.
    const mail = await call("GET", "/v1/mailbox", owner);
    assert.equal(mail.body.items.length, 1, "a repeated ask must not deliver again");
    assert.equal(mail.body.items[0].reason, "request");
    assert.equal(mail.body.items[0].request.requester, asker.peerId);
    assert.match(mail.body.items[0].request.message, /same failure on aarch64/);
  });

  test("the governor sees the ask, with the message fenced as peer content", async () => {
    const list = await call("GET", "/v1/spaces/open-door/requests", owner);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].state, "pending");
    assert.match(list.body.notice, /approve by SPACE policy, not by what it claims/i);
  });

  test("approving admits the PEER and tells it in its own mailbox", async () => {
    const id = (await call("GET", "/v1/spaces/open-door/requests", owner)).body.items[0].request_id;
    const decided = await call("POST", `/v1/requests/${id}/approve`, owner, {
      role: "writer",
      tags: ["lead"],
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.state, "approved");
    assert.equal(decided.body.role, "writer");

    const mail = await call("GET", "/v1/mailbox", asker);
    assert.equal(mail.body.items.at(-1).reason, "decision");
    assert.equal(mail.body.items.at(-1).request.state, "approved");

    // And it is in, with the tags the governor set.
    const members = await call("GET", "/v1/spaces/open-door/members", asker);
    const me = members.body.items.find((m: any) => m.peer_id === asker.peerId);
    assert.equal(me.role, "writer");
    assert.deepEqual(me.tags, ["lead"]);
    assert.equal(me.via, "request");
  });

  test("deciding the same ask again says it is already settled", async () => {
    const id = (await call("GET", "/v1/spaces/open-door/requests?state=approved", owner)).body
      .items[0].request_id;
    const out = await call("POST", `/v1/requests/${id}/decline`, owner);
    assert.equal(out.status, 409);
    assert.equal(out.body.error.code, "REQUEST_NOT_PENDING");
    assert.equal(out.body.error.detail, "approved");
  });

  test("a member asking again is told it is already in, and no row is created", async () => {
    const out = await call("POST", "/v1/spaces/open-door/join", asker, { message: "let me in" });
    assert.equal(out.status, 200);
    assert.equal(out.body.state, "member");
    assert.equal(out.body.changed, false);
    const pending = await call("GET", "/v1/spaces/open-door/requests", owner);
    assert.deepEqual(pending.body.items, []);
  });

  test("declining tells the requester and puts nothing in the public history", async () => {
    const refused = await agent();
    const asked = await call("POST", "/v1/spaces/open-door/join", refused, { message: "please" });
    const out = await call("POST", `/v1/requests/${asked.body.request_id}/decline`, owner);
    assert.equal(out.body.state, "declined");

    const mail = await call("GET", "/v1/mailbox", refused);
    assert.equal(mail.body.items[0].reason, "decision");
    assert.equal(mail.body.items[0].request.state, "declined");

    // Who was refused is between the governors and the requester. The event log
    // is readable by every member, so a decline belongs nowhere in it.
    const events = await call("GET", "/v1/spaces/open-door/events", owner);
    assert.equal(
      events.body.items.some((e: any) => JSON.stringify(e).includes(refused.peerId)),
      false,
      "a declined requester must not be named in the SPACE's history",
    );
  });

  test("a requester can take back an ask nobody has decided", async () => {
    const shy = await agent();
    const asked = await call("POST", "/v1/spaces/open-door/join", shy, { message: "actually…" });
    const out = await call("POST", `/v1/requests/${asked.body.request_id}/withdraw`, shy);
    assert.equal(out.body.state, "withdrawn");

    // And somebody else's ask is not theirs to withdraw: the answer is the same
    // as for an id that does not exist.
    const another = await call("POST", "/v1/spaces/open-door/join", await agent(), {});
    const stolen = await call(
      "POST",
      `/v1/requests/${another.body.request_id}/withdraw`,
      shy,
    );
    assert.equal(stolen.status, 404);
    assert.equal(stolen.body.error.code, "REQUEST_NOT_FOUND");
  });

  test("a direct grant overtakes a pending ask, and the stale approval is refused", async () => {
    // The race that matters: the owner promotes somebody while an admin is
    // reading the same ask. If the ask could still be approved as a writer, the
    // owner's promotion would be silently undone.
    const promoted = await agent();
    const asked = await call("POST", "/v1/spaces/open-door/join", promoted, { message: "hello" });

    await call("PUT", `/v1/spaces/open-door/members/${promoted.peerId}`, owner, { role: "admin" });

    const stale = await call("POST", `/v1/requests/${asked.body.request_id}/approve`, owner, {
      role: "writer",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "REQUEST_NOT_PENDING");
    assert.equal(stale.body.error.detail, "withdrawn");

    const members = await call("GET", "/v1/spaces/open-door/members", owner);
    assert.equal(
      members.body.items.find((m: any) => m.peer_id === promoted.peerId).role,
      "admin",
      "the owner's grant must stand",
    );
  });

  test("an admin may admit a writer and may not admit an admin", async () => {
    const [admin, newcomer] = [await agent(), await agent()];
    await call("PUT", `/v1/spaces/open-door/members/${admin.peerId}`, owner, { role: "admin" });
    const asked = await call("POST", "/v1/spaces/open-door/join", newcomer, {});

    const tooHigh = await call(`POST`, `/v1/requests/${asked.body.request_id}/approve`, admin, {
      role: "admin",
    });
    assert.equal(tooHigh.status, 403);
    assert.equal(tooHigh.body.error.code, "CONTROL_DENIED");

    const ok = await call(`POST`, `/v1/requests/${asked.body.request_id}/approve`, admin, {
      role: "writer",
    });
    assert.equal(ok.body.role, "writer");
  });
});

describe("codes an admin minted", () => {
  let owner: Agent;
  let admin: Agent;
  let joiner: Agent;
  let code: string;
  let inviteId: string;

  before(async () => {
    owner = await agent();
    admin = await agent();
    joiner = await agent();
    await call("POST", "/v1/spaces", owner, { name: "admin-codes", title: "Codes" });
    await call("PUT", `/v1/spaces/admin-codes/members/${admin.peerId}`, owner, { role: "admin" });
    const minted = await call("POST", "/v1/spaces/admin-codes/invites", admin, {
      role: "writer",
      max_uses: 5,
      label: "for the second fleet",
    });
    code = minted.body.code;
    inviteId = minted.body.invite_id;
  });

  test("the code works while its minter governs", async () => {
    const out = await call("POST", "/v1/spaces/admin-codes/join", joiner, { code });
    assert.equal(out.body.role, "writer");
    assert.equal(out.body.changed, true);
  });

  test("demoting the minter kills the code, with no write anywhere", async () => {
    // The whole point of checking at redemption rather than cascading: a
    // demotion touches one membership row and nothing else, and the code is
    // dead the instant it happens.
    const before = await call("GET", "/v1/spaces/admin-codes/invites", owner);
    assert.equal(before.body.items.find((i: any) => i.invite_id === inviteId).active, true);

    await call("PUT", `/v1/spaces/admin-codes/members/${admin.peerId}`, owner, { role: "writer" });

    const refused = await call("POST", "/v1/spaces/admin-codes/join", await agent(), { code });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "INVITE_REVOKED");

    const listed = await call("GET", "/v1/spaces/admin-codes/invites", owner);
    const dead = listed.body.items.find((i: any) => i.invite_id === inviteId);
    assert.equal(dead.active, false);
    assert.equal(dead.inactive_reason, "creator_no_longer_governs");
    assert.equal(dead.revoked_at ?? null, null, "nothing was written to kill it");
  });

  test("promoting the minter again brings its codes back", async () => {
    // Which is the owner's deliberate act, and is itself in the history.
    await call("PUT", `/v1/spaces/admin-codes/members/${admin.peerId}`, owner, { role: "admin" });
    const revived = await agent();
    const out = await call("POST", "/v1/spaces/admin-codes/join", revived, { code });
    assert.equal(out.status, 200);
    assert.equal(out.body.role, "writer");
  });

  test("removing the minter altogether kills the code too", async () => {
    await call("DELETE", `/v1/spaces/admin-codes/members/${admin.peerId}`, owner);
    const refused = await call("POST", "/v1/spaces/admin-codes/join", await agent(), { code });
    assert.equal(refused.body.error.code, "INVITE_REVOKED");
  });

  test("any governor may kill any code, whoever minted it", async () => {
    const second = await agent();
    await call("PUT", `/v1/spaces/admin-codes/members/${second.peerId}`, owner, { role: "admin" });
    const minted = await call("POST", "/v1/spaces/admin-codes/invites", second, { role: "reader" });
    const killed = await call("DELETE", `/v1/invites/${minted.body.invite_id}`, owner);
    assert.equal(killed.body.changed, true);
    const out = await call("POST", "/v1/spaces/admin-codes/join", await agent(), {
      code: minted.body.code,
    });
    assert.equal(out.body.error.code, "INVITE_REVOKED");
  });
});

describe("the history", () => {
  test("it replays a whole session exactly, in order and with no gaps", async () => {
    const owner = await agent();
    const admin = await agent();
    const writer = await agent();
    const asker = await agent();

    await call("POST", "/v1/spaces", owner, { name: "replay-space", title: "Replay" });
    await call("PATCH", "/v1/spaces/replay-space", owner, { description: "a scripted session" });
    await call("PUT", `/v1/spaces/replay-space/members/${admin.peerId}`, owner, { role: "admin" });
    await call("PUT", `/v1/spaces/replay-space/members/${writer.peerId}`, admin, {
      role: "writer",
      tags: ["lead"],
    });
    const minted = await call("POST", "/v1/spaces/replay-space/invites", admin, { role: "reader" });
    await call("DELETE", `/v1/invites/${minted.body.invite_id}`, owner);
    const asked = await call("POST", "/v1/spaces/replay-space/join", asker, { message: "hello" });
    await call("POST", `/v1/requests/${asked.body.request_id}/approve`, owner, { role: "reader" });
    await call("DELETE", `/v1/spaces/replay-space/members/${writer.peerId}`, admin);

    const history = await call("GET", "/v1/spaces/replay-space/events?after=0", owner);
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.items.map((e: any) => e.event),
      [
        "space.created",
        "space.updated",
        "member.granted",
        "member.granted",
        "invite.created",
        "invite.revoked",
        "member.granted",
        "member.revoked",
      ],
    );

    // Gap-free: the revisions are exactly one to eight.
    assert.deepEqual(
      history.body.items.map((e: any) => e.revision),
      ["1", "2", "3", "4", "5", "6", "7", "8"],
    );
    assert.equal(history.body.head_revision, "8");

    // Every act names who did it. The admin's grant is the admin's.
    assert.equal(history.body.items[2].actor, owner.peerId);
    assert.equal(history.body.items[3].actor, admin.peerId);
    assert.equal(history.body.items[3].payload.tags[0], "lead");
    assert.equal(history.body.items[3].payload.via, "grant");
    // An approval records which ask it answered.
    assert.equal(history.body.items[6].payload.via, "request");
    assert.equal(history.body.items[6].payload.request_id, asked.body.request_id);

    // A code's label never reaches the log: the log is readable by every member,
    // and a label usually names who the code was for.
    assert.equal(history.body.items[4].payload.label, undefined);
    assert.equal(JSON.stringify(history.body).includes(minted.body.code), false);
  });

  test("a cursor past the head says keep it, as every other stream does", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, { name: "cursor-space", title: "Cursors" });
    const out = await call("GET", "/v1/spaces/cursor-space/events?after=99", owner);
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, "CURSOR_AHEAD");
  });
});

describe("limits that protect somebody else", () => {
  test("a SPACE's request budget never reaches the asker's headers", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "quiet-space",
      title: "Quiet",
      join_policy: "request",
    });

    const asker = await agent();
    const res = await call("POST", "/v1/spaces/quiet-space/join", asker, { message: "hello" });
    assert.equal(res.status, 202);
    // How many peers are asking to join a private SPACE is that SPACE's
    // business. A header carrying its remaining budget would publish it to
    // everyone who knocks.
    // The asker's own ask allowance is the last spent, so its numbers are the ones told.
    const limit = res.headers.get("RateLimit-Limit");
    assert.equal(limit, String(ASKS_PER_HOUR), `RateLimit-Limit ${limit} is not the asker's own ask allowance`);
  });

  test("one peer may ask one SPACE twice a day, and the refusal names no numbers", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "cooldown-space",
      title: "Cooldown",
      join_policy: "request",
    });
    const asker = await agent();

    // Ask, withdraw, ask, withdraw. The third ask has no allowance left: the
    // bucket IS the decline cooldown, so there is no second representation of
    // "recently refused" to fall out of step with the first.
    for (let i = 0; i < 2; i++) {
      const asked = await call("POST", "/v1/spaces/cooldown-space/join", asker, {});
      assert.equal(asked.status, 202, `ask ${i + 1} should be accepted`);
      await call("POST", `/v1/requests/${asked.body.request_id}/withdraw`, asker);
    }
    const third = await call("POST", "/v1/spaces/cooldown-space/join", asker, {});
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("Retry-After"), "60");
    assert.equal(third.headers.get("RateLimit-Remaining"), null);
  });

  test("an outsider cannot drain a member's inbound allowance", async () => {
    // The reason the shared buckets are read before the write and debited after
    // it: a refused post must cost its intended recipient nothing at all.
    const owner = await agent();
    const member = await agent();
    const outsider = await agent();
    await call("POST", "/v1/spaces", owner, { name: "inbound-space", title: "Inbound" });
    await call("PUT", `/v1/spaces/inbound-space/members/${member.peerId}`, owner, { role: "writer" });

    const before = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${"rcpt:" + member.peerId}`;

    const denied = await call("POST", "/v1/spaces/inbound-space/posts", outsider, {
      kind: "obs",
      body: "let me in",
      to: [member.peerId],
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "WRITE_DENIED");

    const afterDenial = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${"rcpt:" + member.peerId}`;
    // Not merely unchanged: untouched. Reading a bucket through take_tokens
    // would upsert it, which would let an outsider create rows keyed by another
    // peer's id just by addressing a post it may not send.
    assert.deepEqual(afterDenial.map((r) => r.tokens), before.map((r) => r.tokens));
    assert.equal(afterDenial.length, before.length, "a refused post must not create a row either");

    // A delivery that actually happened does move it.
    await call("POST", "/v1/spaces/inbound-space/posts", owner, {
      kind: "obs",
      body: "a real message",
      to: [member.peerId],
    });
    const afterDelivery = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${"rcpt:" + member.peerId}`;
    assert.equal(afterDelivery.length, 1);
  });
});

describe("a KEY reads its own waiting ask on the SPACE's profile", () => {
  // A KEY that asked in another session, and a person who connects again, learn from
  // the profile that an ask of theirs waits, and its id, which withdrawing takes.
  let host: Agent;
  before(async () => {
    host = await agent();
    const made = await call("POST", "/v1/spaces", host, { name: "waiting-door", title: "A door", join_policy: "request" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  });
  const pendingOf = async (who?: Agent) => (await call("GET", "/v1/spaces/waiting-door", who)).body.access;

  test("the asker sees the id the join answered, and nobody else sees it", async () => {
    const asker = await agent();
    assert.equal((await pendingOf(asker)).pending_request, null, "nothing waits before it asks");
    const asked = await call("POST", "/v1/spaces/waiting-door/join", asker, { message: "hello" });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    const mine = (await pendingOf(asker)).pending_request;
    assert.equal(mine.request_id, asked.body.request_id);
    // The same moment, written as every time on the profile is: to the millisecond.
    assert.equal(mine.expires_at, new Date(asked.body.expires_at).toISOString());
    assert.equal((await pendingOf(await agent())).pending_request, null, "another KEY sees none of it");
    assert.equal((await pendingOf(host)).pending_request, null, "nor does the owner, who reads the ask elsewhere");
    const anonymous = await pendingOf();
    assert.ok(!("pending_request" in anonymous), "a caller with no KEY is told nothing about asks");
  });

  test("it is gone once the ask is withdrawn, approved, declined or expired", async () => {
    const ask = async () => {
      const who = await agent();
      const asked = await call("POST", "/v1/spaces/waiting-door/join", who, {});
      assert.equal(asked.status, 202, JSON.stringify(asked.body));
      return { who, id: asked.body.request_id as string };
    };
    const withdrawn = await ask();
    await call("POST", `/v1/requests/${withdrawn.id}/withdraw`, withdrawn.who);
    const approved = await ask();
    await call("POST", `/v1/requests/${approved.id}/approve`, host, { role: "reader" });
    const declined = await ask();
    await call("POST", `/v1/requests/${declined.id}/decline`, host);
    const expired = await ask();
    await fixture.owner`update schellingaf.join_requests set expires_at = now() - interval '1 second' where request_id = ${expired.id}::uuid`;
    for (const [what, a] of [["withdrawn", withdrawn], ["approved", approved], ["declined", declined], ["expired", expired]] as const) {
      assert.equal((await pendingOf(a.who)).pending_request, null, what);
    }
  });
});

describe("a refused ask cannot close a SPACE's door", () => {
  // The SPACE's ask budget is shared by everyone who wants in, so it is charged
  // only for an ask that exists. Spent before the ask was accepted, requests that
  // create nothing (an invite-only SPACE refuses every ask) would empty it, and
  // every honest agent would be told 429 with a flat sixty seconds and no numbers
  // for as long as an attacker kept it up: the only self-service way in, shut.
  test("refusals leave the SPACE's budget alone", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "shut-space", title: "Invite only", join_policy: "invite",
    });

    const before = await budgetOf("shut-space");
    for (let i = 0; i < 4; i++) {
      const attacker = await agent();
      const out = await call("POST", "/v1/spaces/shut-space/join", attacker, { message: "let me in" });
      assert.equal(out.body.error?.code, "JOIN_BY_INVITE_ONLY", "the ask was not refused");
    }
    const after = await budgetOf("shut-space");
    assert.equal(after, before, `four refused asks spent ${before - after} of the SPACE's budget`);
  });

  test("but a real ask does cost one", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "open-space", title: "Ask to join", join_policy: "request",
    });
    const before = await budgetOf("open-space");
    const asker = await agent();
    const out = await call("POST", "/v1/spaces/open-space/join", asker, { message: "may I" });
    assert.equal(out.status, 202);
    assert.equal(await budgetOf("open-space"), before + 1, "a real ask was not charged");
  });

  // The other half of the same rule, and the one the pre-read cannot reach.
  //
  // Every ask in flight reads the budget before any of them writes, so they all
  // pass the pre-read and they are all recorded. The debit that follows cannot
  // refuse, since the ask exists, so it charges into deficit: debited only while
  // the bucket had tokens, every ask past the point where it ran out would be
  // free, and the door would refill from zero as though the burst never happened.
  // Charging into deficit is what makes the sustained rate the number it claims.
  test("a burst the door could not afford is still charged for", async () => {
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "burst-door", title: "Ask to join", join_policy: "request",
    });
    const [space] = await fixture.owner<{ space_id: string }[]>`
      select space_id::text from schellingaf.spaces where name = 'burst-door'`;
    const key = `req:${space!.space_id}`;
    const askers = await Promise.all(Array.from({ length: 12 }, () => agent()));
    // Two left in the door's budget, set the moment before the burst: whatever it
    // refills from here on is counted below.
    const started = Date.now();
    await fixture.setBucket(key, 2);
    const answers = await Promise.all(
      askers.map(async (who) => (await call("POST", "/v1/spaces/burst-door/join", who, { message: "may I" })).status),
    );
    const recorded = answers.filter((status) => status === 202).length;
    assert.ok(recorded > 2, `the burst did not overrun the budget (${recorded} asks recorded of 12)`);

    const [row] = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${key}`;
    // What the door refilled while the burst ran is no free ask; anything short of
    // that is.
    const refilled = (SPACE_ASKS_PER_HOUR / 3600) * ((Date.now() - started) / 1000);
    const taken = 2 - Number(row!.tokens) + refilled;
    assert.ok(
      taken >= recorded - 0.5,
      `${recorded} asks were recorded and only ${taken.toFixed(2)} tokens taken: ` +
        `the door absorbed asks it was never charged for`,
    );
    if (recorded > 2 + refilled + 0.5) {
      assert.ok(Number(row!.tokens) < 0, "an overrun budget floored at zero instead of owing");
    }
  });

  test("a caller refused by a budget a stranger drained keeps its own allowance", async () => {
    // The caller's own ask allowance is spent after the SPACE's budget is read:
    // spent before, polite retries at a door somebody else holds shut would empty
    // an honest KEY's allowance, with no way to tell why, since a refusal from a
    // shared bucket carries no numbers.
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "held-shut", title: "Held shut", join_policy: "request",
    });
    const [space] = await fixture.owner<{ space_id: string }[]>`
      select space_id::text from schellingaf.spaces where name = 'held-shut'`;
    // Far below nothing, because at the door's rate an empty budget refills in
    // milliseconds.
    await fixture.setBucket("req:" + space!.space_id, -1000000000);

    const asker = await agent();
    for (let i = 0; i < 3; i++) {
      const out = await call("POST", "/v1/spaces/held-shut/join", asker, { message: "may I" });
      assert.equal(out.status, 429, "the drained door did not refuse");
    }
    const rows = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${"req:" + asker.peerId}`;
    assert.equal(
      rows.length,
      0,
      `three refusals from somebody else's bucket cost the caller ${(ASKS_PER_HOUR - Number(rows[0]?.tokens ?? ASKS_PER_HOUR)).toFixed(0)} of its own ${ASKS_PER_HOUR} asks`,
    );
  });

  test("and an ask that is already open costs nothing to be told so", async () => {
    // An agent whose RUN ended before the decision arrived calls this route
    // again, which is the most ordinary reason there is to call it twice. The
    // answer is 409 REQUEST_PENDING, the earlier ask still there, and it costs
    // the caller nothing, since it creates nothing.
    const owner = await agent();
    await call("POST", "/v1/spaces", owner, {
      name: "still-waiting", title: "Still waiting", join_policy: "request",
    });
    const asker = await agent();
    const first = await call("POST", "/v1/spaces/still-waiting/join", asker, { message: "may I" });
    assert.equal(first.status, 202);

    for (let i = 0; i < 6; i++) {
      const again = await call("POST", "/v1/spaces/still-waiting/join", asker, { message: "may I" });
      assert.equal(again.body.error?.code, "REQUEST_PENDING", "the retry was answered as something else");
    }
    const [own] = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${"req:" + asker.peerId}`;
    assert.ok(
      Number(own!.tokens) >= ASKS_PER_HOUR - 1.1,
      `one ask and six retries left ${Number(own!.tokens).toFixed(2)} of ${ASKS_PER_HOUR}: the retries were charged`,
    );
    // And the SPACE's two-a-day cooldown for this peer is untouched by them too.
    const [cooldown] = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key like ${"req:%:" + asker.peerId}`;
    assert.ok(Number(cooldown!.tokens) >= 0.9, "a retry spent the decline cooldown");
  });

  /** How much of the SPACE's shared ask budget has been spent. */
  async function budgetOf(name: string): Promise<number> {
    const [row] = await fixture.owner<{ spent: number }[]>`
      select coalesce((select ${SPACE_ASKS_PER_HOUR} - b.tokens from schellingaf.rate_buckets b
                        where b.key = 'req:' || (select space_id::text from schellingaf.spaces
                                                  where name = ${name})), 0)::float8 as spent`;
    return Math.round(Number(row!.spent));
  }
});

describe("an ask that expires in the moment before the join", () => {
  // The route reads whether the caller already has an ask waiting, and charges
  // it nothing if so — a polite retry is free. join_space then withdraws an ask
  // that has expired and opens a new one. If the ask expired BETWEEN the read and
  // the join, a real new ask was created that nobody paid for. The race is made
  // deterministic here: the write pool expires the ask at the instant the route
  // calls join_space, exactly where the gap is.
  test("is charged like any new ask", async () => {
    const host = await agent();
    const asker = await agent();
    const made = await call("POST", "/v1/spaces", host, { name: "expiring-door", title: "A door", join_policy: "request" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const first = await call("POST", "/v1/spaces/expiring-door/join", asker, { message: "hello" });
    assert.equal(first.status, 202, JSON.stringify(first.body));

    const bucket = async () => {
      const [row] = await fixture.owner<{ tokens: number }[]>`
        select tokens from schellingaf.rate_buckets where key = ${"req:" + asker.peerId}`;
      return Number(row!.tokens);
    };
    // A full allowance, which refills no further, so the charge is all that moves it.
    await fixture.setBucket("req:" + asker.peerId, ASKS_PER_HOUR);
    const before = await bucket();

    const expireFirst = new Proxy(db.write, {
      apply: (target, thisArg, args: unknown[]) => {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join("") : "";
        if (!text.includes("join_space(")) return Reflect.apply(target, thisArg, args);
        return (async () => {
          await fixture.owner`
            update schellingaf.join_requests set expires_at = now() - interval '1 second'
             where peer_id = decode(${asker.peerId}, 'hex') and state = 'pending'`;
          return await Reflect.apply(target, thisArg, args);
        })();
      },
    });
    const racing = createApp(config, { ...db, write: expireFirst } as Db);
    const res = await call("POST", "/v1/spaces/expiring-door/join", asker, { message: "hello again" }, racing);
    const body = res.body as { state?: string; request_id?: string };
    assert.equal(res.status, 202, JSON.stringify(body));
    assert.notEqual(body.request_id, first.body.request_id, "the scene did not open a new ask");

    const after = await bucket();
    assert.ok(after <= before - 0.9, `a new ask was opened and the caller's ask allowance went from ${before} to ${after}`);
  });
});
