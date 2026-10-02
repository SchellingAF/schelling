// Invite links, the coordinator, handing a seat on, revoke and remove, and the
// limits no swarm meets. The tests of those limits that build a swarm of thousands
// are in links-swarm.test.ts, a file of their own so they run beside these.
//
// An agent drops a link and another agent is in with one call, nobody approving
// each joiner; a coordinator brings KEYS in; any member hands its seat to a
// successor and leaves; and a leaked link can be taken back with everyone it let
// in. The database holds the rules, in join_space, look_invite, take_over and
// remove_link_members; these tests drive them through the routes and the connector.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { useService, HOST, db, config, fixture, call, agent, connector, type App, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { challengePreimage, readInviteLink } from "../src/domain/protocol.ts";
import { SPACE_LIMITS } from "../src/surface/vocabulary.ts";

const SITE = "https://site.schellingaf.test";
let siteless: App;

const ready = useService("links", { siteOrigin: SITE });
before(async () => {
  await ready;
  siteless = createApp({ ...config, siteOrigin: null }, db);
});

/** A new key pair's challenge, signed and not yet sent back: the verify is the test's. */
async function challenge() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const ch = (await call("POST", "/v1/keys/challenge", null, { public_key: hex })).body;
  const signature = signBytes(null, challengePreimage(HOST, Buffer.from(ch.challenge, "hex")), privateKey).toString("hex");
  return { hex, ch, signature };
}

async function tool(name: string, args: unknown, who: Agent) {
  const { message } = await connector("tools/call", { name, arguments: args }, who);
  assert.ok(message.result, JSON.stringify(message.error ?? message));
  return {
    isError: message.result.isError === true,
    text: (message.result.content?.[0]?.text ?? "") as string,
    data: message.result.structuredContent as any,
  };
}

async function makeSpace(owner: Agent, name: string, joinPolicy = "invite") {
  const made = await call("POST", "/v1/spaces", owner, { name, title: `The ${name} space`, join_policy: joinPolicy });
  assert.equal(made.status, 201, JSON.stringify(made.body));
}

async function members(name: string, who: Agent) {
  const out = await call("GET", `/v1/spaces/${name}/members`, who);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body as { owner: string; items: any[] };
}

describe("reading a link", () => {
  test("a link on the website is read for its SPACE and code, and nothing else is", () => {
    const code = `schellingaf_inv_${"a".repeat(32)}`;
    assert.deepEqual(readInviteLink(`${SITE}/join/some-space/${code}`, SITE), { name: "some-space", code });
    // Its twins, a trailing slash, a query and a fragment, and the www name.
    for (const variant of [
      `${SITE}/join/some-space/${code}/`,
      `${SITE}/join/some-space/${code}.md`,
      `${SITE}/join/some-space/${code}.json?utm=x#top`,
      `https://www.site.schellingaf.test/join/some-space/${code}`,
      `http://site.schellingaf.test/join/some-space/${code}`,
    ]) {
      assert.deepEqual(readInviteLink(variant, SITE), { name: "some-space", code }, variant);
    }
    // A lookalike, a path that is not a link, a code of neither kind, and no website.
    for (const bad of [
      `https://site.schellingaf.test.evil.example/join/some-space/${code}`,
      `https://evil.example/join/some-space/${code}`,
      `${SITE}/spaces/some-space`,
      `${SITE}/join/some-space/schellingaf_xyz_${"a".repeat(32)}`,
      `${SITE}/join/Some-Space/${code}`,
      "not a link at all",
    ]) {
      assert.ok("refused" in readInviteLink(bad, SITE), bad);
    }
    assert.ok("refused" in readInviteLink(`${SITE}/join/some-space/${code}`, null));
  });
});

describe("an invite link", () => {
  let owner: Agent;
  let joiner: Agent;
  let link: string;
  let inviteId: string;

  before(async () => {
    owner = await agent();
    joiner = await agent();
    await makeSpace(owner, "link-space");
  });

  test("made without choosing, it admits ten writers for seven days, and comes as a link", async () => {
    const made = await call("POST", "/v1/spaces/link-space/invites", owner, {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.role, "writer");
    assert.equal(made.body.max_uses, 10);
    // The database's clock sets expires_at and can run a fraction of a millisecond
    // ahead of this one, so the bound allows a second.
    const days = (Date.parse(made.body.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days <= 7 + 1 / 86400, `expires in ${days} days`);
    assert.match(made.body.code, /^schellingaf_inv_[0-9a-f]{32}$/);
    assert.equal(made.body.link, `${SITE}/join/link-space/${made.body.code}`);
    assert.match(made.body.notice, /Whoever holds this link/);
    link = made.body.link;
    inviteId = made.body.invite_id;
  });

  test("anybody holding it can look at what it gives before using it", async () => {
    const look = await call("POST", "/v1/invites/look", joiner, { link });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.deepEqual(
      { name: look.body.name, kind: look.body.kind, role: look.body.role, state: look.body.state, uses: look.body.uses },
      { name: "link-space", kind: "invite", role: "writer", state: "live", uses: 0 },
    );
  });

  test("one call with the link, and the KEY is in: the link is read, never fetched", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a link must never be fetched");
    }) as typeof fetch;
    try {
      const joined = await call("POST", "/v1/join", joiner, { link });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal(joined.body.state, "member");
      assert.equal(joined.body.role, "writer");
    } finally {
      globalThis.fetch = realFetch;
    }
    const roster = await members("link-space", owner);
    const row = roster.items.find((m) => m.peer_id === joiner.peerId);
    assert.equal(row.via, "invite");
    assert.equal(row.invite_id, inviteId);
    assert.equal(row.managed_by, owner.peerId);
  });

  test("the join route takes the link too, and refuses one for another SPACE", async () => {
    const other = await agent();
    const wrong = await call("POST", "/v1/spaces/some-other-space/join", other, { link });
    assert.equal(wrong.status, 400);
    const right = await call("POST", "/v1/spaces/link-space/join", other, { link });
    assert.equal(right.status, 200, JSON.stringify(right.body));
  });

  test("both join routes read the link before they spend, so the same refusal comes first on each", async () => {
    const k = await agent();
    await fixture.setBucket(`peer:${k.peerId}`, -1000);
    const lookalike = `https://evil.example/join/link-space/schellingaf_inv_${"a".repeat(32)}`;
    for (const path of ["/v1/join", "/v1/spaces/link-space/join"]) {
      const bad = await call("POST", path, k, { link: lookalike });
      assert.equal(bad.body.error?.code, "INVITE_INVALID", `${path}: ${JSON.stringify(bad.body)}`);
      const spent = await call("POST", path, k, { link });
      assert.equal(spent.body.error?.code, "RATE_LIMITED", `${path}: ${JSON.stringify(spent.body)}`);
    }
  });

  test("a lookalike link is refused, and says where links live", async () => {
    const other = await agent();
    const code = link.split("/").at(-1)!;
    const out = await call("POST", "/v1/join", other, { link: `https://site.schellingaf.test.example.org/join/link-space/${code}` });
    assert.equal(out.status, 404);
    assert.equal(out.body.error.code, "INVITE_INVALID");
    assert.match(out.body.error.detail, /site\.schellingaf\.test/);
  });

  test("a service that names no website reads no link, and says to send the name and code", async () => {
    const other = await agent();
    const out = await call("POST", "/v1/join", other, { link }, siteless);
    assert.equal(out.body.error.code, "INVITE_INVALID");
    assert.match(out.body.error.detail, /names no website/);
    const made = await call("POST", "/v1/spaces/link-space/invites", owner, {}, siteless);
    assert.equal(made.status, 201);
    assert.equal(made.body.link, null, "no link without a website, the code alone");
  });

  test("no limit and never are the maker's to choose, and a large reach is no reach limit", async () => {
    const made = await call("POST", "/v1/spaces/link-space/invites", owner, {
      role: "reader",
      max_uses: null,
      expires_in_seconds: null,
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.max_uses, null);
    assert.equal(made.body.expires_at, null);
    const look = await call("POST", "/v1/invites/look", owner, { link: made.body.link });
    assert.equal(look.body.max_uses, null);
    assert.equal(look.body.expires_at, null);
    const big = await call("POST", "/v1/spaces/link-space/invites", owner, { max_uses: 1_000_000 });
    assert.equal(big.status, 201);
    for (const bad of [{ max_uses: 0 }, { max_uses: 1.5 }, { expires_in_seconds: 10 }]) {
      const out = await call("POST", "/v1/spaces/link-space/invites", owner, bad);
      assert.equal(out.status, 400, JSON.stringify(bad));
    }
  });

  test("a revoked link says so to whoever looks, and refuses whoever uses it", async () => {
    const revoked = await call("DELETE", `/v1/invites/${inviteId}`, owner);
    assert.equal(revoked.status, 200);
    const late = await agent();
    const look = await call("POST", "/v1/invites/look", late, { link });
    assert.equal(look.body.state, "revoked");
    const out = await call("POST", "/v1/join", late, { link });
    assert.equal(out.body.error.code, "INVITE_REVOKED");
  });

  test("a brand-new KEY registers and joins in one call", async () => {
    const made = await call("POST", "/v1/spaces/link-space/invites", owner, {});
    const { hex, ch, signature } = await challenge();
    const { status, body: out } = await call("POST", "/v1/keys/verify", null, {
      public_key: hex, challenge: ch.challenge, signature, invite: made.body.link,
    });
    assert.equal(status, 200, JSON.stringify(out));
    assert.ok(out.token);
    assert.equal(out.joined.state, "member");
    assert.equal(out.joined.role, "writer");
    const roster = await members("link-space", owner);
    assert.ok(roster.items.some((m) => m.peer_id === ch.peer_id));
  });

  test("a link that does not work still leaves the new KEY registered, and says why", async () => {
    const { hex, ch, signature } = await challenge();
    const { status, body: out } = await call("POST", "/v1/keys/verify", null, {
      public_key: hex, challenge: ch.challenge, signature, invite: link,
    });
    assert.equal(status, 200);
    assert.ok(out.token, "the KEY stands whatever the link does");
    assert.equal(out.join_refused.code, "INVITE_REVOKED");
    assert.ok(out.join_refused.fix);
  });

  test("the connector joins with the link, and looks at one first", async () => {
    const made = await call("POST", "/v1/spaces/link-space/invites", owner, { role: "reader" });
    const newcomer = await agent();
    const look = await tool("schellingaf_join", { action: "look", link: made.body.link }, newcomer);
    assert.equal(look.isError, false, look.text);
    assert.equal(look.data.kind, "invite");
    const joined = await tool("schellingaf_join", { action: "join", link: made.body.link }, newcomer);
    assert.equal(joined.isError, false, joined.text);
    assert.equal(joined.data.role, "reader");
  });

  test("the connector makes a link and prints it", async () => {
    const out = await tool("schellingaf_space_control", { action: "invite", name: "link-space", max_uses: null }, owner);
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /link https:\/\/site\.schellingaf\.test\/join\/link-space\/schellingaf_inv_/);
    assert.equal(out.data.max_uses, null);
  });
});

describe("the coordinator", () => {
  let owner: Agent;
  let coordinator: Agent;
  let broughtIn: Agent;
  let ownersOwn: Agent;

  before(async () => {
    owner = await agent();
    coordinator = await agent();
    broughtIn = await agent();
    ownersOwn = await agent();
    await makeSpace(owner, "coord-space", "request");
    const made = await call("PUT", `/v1/spaces/coord-space/members/${coordinator.peerId}`, owner, { role: "coordinator" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    await call("PUT", `/v1/spaces/coord-space/members/${ownersOwn.peerId}`, owner, { role: "writer" });
  });

  test("makes writer and reader links, and never a coordinator's", async () => {
    const writer = await call("POST", "/v1/spaces/coord-space/invites", coordinator, { role: "writer" });
    assert.equal(writer.status, 201, JSON.stringify(writer.body));
    const joined = await call("POST", "/v1/join", broughtIn, { link: writer.body.link });
    assert.equal(joined.body.role, "writer");
    const up = await call("POST", "/v1/spaces/coord-space/invites", coordinator, { role: "coordinator" });
    assert.equal(up.status, 403);
    assert.equal(up.body.error.code, "CONTROL_DENIED");
  });

  test("admits by id, and changes or removes only the KEYS it brought in", async () => {
    const byId = await agent();
    const admitted = await call("PUT", `/v1/spaces/coord-space/members/${byId.peerId}`, coordinator, { role: "reader" });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const raised = await call("PUT", `/v1/spaces/coord-space/members/${byId.peerId}`, coordinator, { role: "writer" });
    assert.equal(raised.status, 200);
    const notMine = await call("PUT", `/v1/spaces/coord-space/members/${ownersOwn.peerId}`, coordinator, { role: "reader" });
    assert.equal(notMine.status, 403);
    const removeNotMine = await call("DELETE", `/v1/spaces/coord-space/members/${ownersOwn.peerId}`, coordinator);
    assert.equal(removeNotMine.status, 403);
    const removeMine = await call("DELETE", `/v1/spaces/coord-space/members/${broughtIn.peerId}`, coordinator);
    assert.equal(removeMine.status, 200, JSON.stringify(removeMine.body));
  });

  test("reads the join requests, and decides them at writer or reader", async () => {
    const asker = await agent();
    const asked = await call("POST", "/v1/spaces/coord-space/join", asker, { message: "I can help" });
    assert.equal(asked.status, 202);
    const list = await call("GET", "/v1/spaces/coord-space/requests", coordinator);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.pending_count, 1);
    const tooHigh = await call("POST", `/v1/requests/${asked.body.request_id}/approve`, coordinator, { role: "coordinator" });
    assert.equal(tooHigh.status, 403);
    const ok = await call("POST", `/v1/requests/${asked.body.request_id}/approve`, coordinator, { role: "writer" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("lists its own links alone, where a governor lists them all", async () => {
    const mine = await call("GET", "/v1/spaces/coord-space/invites", coordinator);
    assert.ok(mine.body.items.length > 0);
    assert.ok(mine.body.items.every((i: any) => i.created_by === coordinator.peerId));
    await call("POST", "/v1/spaces/coord-space/invites", owner, {});
    const all = await call("GET", "/v1/spaces/coord-space/invites", owner);
    assert.ok(all.body.items.some((i: any) => i.created_by === owner.peerId));
    assert.ok(all.body.items.some((i: any) => i.created_by === coordinator.peerId));
  });

  test("the role and the members of one role are found, not paged to", async () => {
    const coordinators = await call("GET", "/v1/spaces/coord-space/members?role=writer", owner);
    assert.ok(coordinators.body.items.every((m: any) => m.role === "writer"));
    const one = await call("GET", `/v1/spaces/coord-space/members?peer=${ownersOwn.peerId}`, owner);
    assert.deepEqual(one.body.items.map((m: any) => m.peer_id), [ownersOwn.peerId]);
  });
});

describe("handing a seat on", () => {
  let owner: Agent;

  before(async () => {
    owner = await agent();
    await makeSpace(owner, "torch-space");
  });

  test("a writer's hand-over link gives its seat to whoever uses it, once, and the writer leaves", async () => {
    const writer = await agent();
    await call("PUT", `/v1/spaces/torch-space/members/${writer.peerId}`, owner, { role: "writer", tags: ["builder"] });
    const handed = await call("POST", "/v1/spaces/torch-space/hand-over", writer, {});
    assert.equal(handed.status, 201, JSON.stringify(handed.body));
    assert.match(handed.body.code, /^schellingaf_hand_[0-9a-f]{32}$/);
    assert.equal(handed.body.link, `${SITE}/join/torch-space/${handed.body.code}`);

    const successor = await agent();
    const look = await call("POST", "/v1/invites/look", successor, { link: handed.body.link });
    assert.deepEqual({ kind: look.body.kind, role: look.body.role, made_by: look.body.made_by }, { kind: "hand_over", role: "writer", made_by: writer.peerId });

    const taken = await call("POST", "/v1/join", successor, { link: handed.body.link });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.role, "writer");
    assert.equal(taken.body.handed_over_by, writer.peerId);

    const roster = await members("torch-space", owner);
    const row = roster.items.find((m) => m.peer_id === successor.peerId);
    assert.deepEqual(row.tags, ["builder"], "the successor sits where the maker sat, tags and all");
    assert.equal(row.via, "hand_over");
    assert.ok(!roster.items.some((m) => m.peer_id === writer.peerId), "the maker is gone");

    const third = await agent();
    const again = await call("POST", "/v1/join", third, { link: handed.body.link });
    assert.equal(again.body.error.code, "INVITE_EXHAUSTED");
  });

  test("a coordinator's live links pass with its seat, and its other hand-overs die", async () => {
    const coordinator = await agent();
    await call("PUT", `/v1/spaces/torch-space/members/${coordinator.peerId}`, owner, { role: "coordinator" });
    const standing = await call("POST", "/v1/spaces/torch-space/invites", coordinator, {});
    const spare = await call("POST", "/v1/spaces/torch-space/hand-over", coordinator, { expires_in_seconds: null });
    const handed = await call("POST", "/v1/spaces/torch-space/hand-over", coordinator, {});
    const successor = await agent();
    const taken = await call("POST", "/v1/join", successor, { link: handed.body.link });
    assert.equal(taken.body.role, "coordinator");

    // The link it dropped before it ended still works, now under its successor.
    const late = await agent();
    const joined = await call("POST", "/v1/join", late, { link: standing.body.link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const list = await call("GET", "/v1/spaces/torch-space/invites", owner);
    assert.equal(list.body.items.find((i: any) => i.invite_id === standing.body.invite_id).created_by, successor.peerId);
    // One seat passes once: the spare is dead.
    const other = await agent();
    const spareUsed = await call("POST", "/v1/join", other, { link: spare.body.link });
    assert.equal(spareUsed.body.error.code, "INVITE_REVOKED");
  });

  test("a maker cannot take its own seat, and a KEY already higher takes nothing", async () => {
    const writer = await agent();
    await call("PUT", `/v1/spaces/torch-space/members/${writer.peerId}`, owner, { role: "writer" });
    const handed = await call("POST", "/v1/spaces/torch-space/hand-over", writer, {});
    const self = await call("POST", "/v1/join", writer, { link: handed.body.link });
    assert.equal(self.body.error.code, "CONTROL_DENIED");
    const admin = await agent();
    await call("PUT", `/v1/spaces/torch-space/members/${admin.peerId}`, owner, { role: "admin" });
    const higher = await call("POST", "/v1/join", admin, { link: handed.body.link });
    assert.equal(higher.body.changed, false);
    assert.equal(higher.body.role, "admin");
    const roster = await members("torch-space", owner);
    assert.ok(roster.items.some((m) => m.peer_id === writer.peerId), "the maker stays when nothing was taken");
  });

  test("an owner's offer reaches its successor's mailbox, and accepting hands over the SPACE", async () => {
    const successor = await agent();
    // A KEY that knows the owner: a member already, whose own seat it gives up.
    await call("PUT", `/v1/spaces/torch-space/members/${successor.peerId}`, owner, { role: "reader" });
    const admitted = await agent();
    await call("PUT", `/v1/spaces/torch-space/members/${admitted.peerId}`, owner, { role: "writer" });
    const standing = await call("POST", "/v1/spaces/torch-space/invites", owner, {});
    const offered = await call("POST", "/v1/spaces/torch-space/hand-over", owner, { to: successor.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));
    assert.equal(offered.body.code, undefined, "an offer has no code anybody holds");
    assert.equal(offered.body.link, undefined);
    const offerId = offered.body.offer_id;

    const mail = await call("GET", "/v1/mailbox", successor);
    const item = mail.body.items.find((i: any) => i.reason === "hand_over");
    assert.ok(item, JSON.stringify(mail.body));
    assert.deepEqual(
      { offer_id: item.offer.offer_id, space: item.offer.space, from: item.offer.from, role: item.offer.role, state: item.offer.state },
      { offer_id: offerId, space: "torch-space", from: owner.peerId, role: "owner", state: "waiting" },
    );

    const stranger = await agent();
    const notYours = await call("POST", `/v1/hand-overs/${offerId}/accept`, stranger);
    assert.equal(notYours.body.error.code, "INVITE_NOT_FOUND");

    const accepted = await call("POST", `/v1/hand-overs/${offerId}/accept`, successor);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.role, "owner");

    const profile = await call("GET", "/v1/spaces/torch-space", successor);
    assert.equal(profile.body.owner, successor.peerId);
    const oldOwner = await call("PATCH", "/v1/spaces/torch-space", owner, { title: "still mine?" });
    assert.equal(oldOwner.status, 403);
    // An owner is never a member row, and whom the old owner admitted the new one manages.
    const roster = await members("torch-space", successor);
    assert.ok(!roster.items.some((m) => m.peer_id === successor.peerId));
    assert.equal(roster.items.find((m) => m.peer_id === admitted.peerId).managed_by, successor.peerId);
    // The owner's link passed with the SPACE.
    const late = await agent();
    const joined = await call("POST", "/v1/join", late, { link: standing.body.link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const again = await call("POST", `/v1/hand-overs/${offerId}/accept`, successor);
    assert.equal(again.body.changed, false, "accepting twice is harmless");
  });

  test("an offer declined ends, and its maker keeps the seat", async () => {
    const newOwner = (await call("GET", "/v1/spaces/torch-space", owner)).body.owner;
    assert.notEqual(newOwner, owner.peerId);
    const writer = await agent();
    const space = await agent();
    await makeSpace(space, "decline-space");
    await call("PUT", `/v1/spaces/decline-space/members/${writer.peerId}`, space, { role: "writer" });
    const target = await agent();
    await call("PUT", `/v1/spaces/decline-space/members/${target.peerId}`, space, { role: "reader" });
    const offered = await call("POST", "/v1/spaces/decline-space/hand-over", writer, { to: target.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));
    const declined = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, target);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const late = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/accept`, target);
    assert.equal(late.body.error.code, "INVITE_REVOKED");
    const roster = await members("decline-space", space);
    assert.ok(roster.items.some((m) => m.peer_id === writer.peerId));
  });

  test("an offer reaches only a KEY that knows its maker and does not block it", async () => {
    const own = await agent();
    await makeSpace(own, "offer-space");
    const stranger = await agent();
    const out = await call("POST", "/v1/spaces/offer-space/hand-over", own, { to: stranger.peerId });
    assert.equal(out.status, 403);
    assert.equal(out.body.error.code, "HAND_OVER_UNREACHABLE");
    assert.match(out.body.error.fix, /hand-over link/);
    // A member knows its owner, until it blocks it; the refusal is the same either way.
    await call("PUT", `/v1/spaces/offer-space/members/${stranger.peerId}`, own, { role: "reader" });
    const known = await call("POST", "/v1/spaces/offer-space/hand-over", own, { to: stranger.peerId });
    assert.equal(known.status, 201, JSON.stringify(known.body));
    const blocked = await call("PUT", `/v1/blocks/${own.peerId}`, stranger);
    assert.ok(blocked.status < 300, JSON.stringify(blocked.body));
    const again = await call("POST", "/v1/spaces/offer-space/hand-over", own, { to: stranger.peerId });
    assert.equal(again.body.error.code, "HAND_OVER_UNREACHABLE");
  });

  test("one seat has one hand-over at a time: a new one replaces the last", async () => {
    const own = await agent();
    await makeSpace(own, "one-space");
    const writer = await agent();
    await call("PUT", `/v1/spaces/one-space/members/${writer.peerId}`, own, { role: "writer" });
    const first = await call("POST", "/v1/spaces/one-space/hand-over", writer, { expires_in_seconds: null });
    const second = await call("POST", "/v1/spaces/one-space/hand-over", writer, {});
    const somebody = await agent();
    const look = await call("POST", "/v1/invites/look", somebody, { link: first.body.link });
    assert.equal(look.body.state, "revoked", "the first died when the second was made");
    const taken = await call("POST", "/v1/join", somebody, { link: second.body.link });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
  });

  test("a hand-over passes the seat as it was when made, or nothing", async () => {
    const own = await agent();
    await makeSpace(own, "as-made");
    const b = await agent();
    await call("PUT", `/v1/spaces/as-made/members/${b.peerId}`, own, { role: "writer" });
    const writerSeat = await call("POST", "/v1/spaces/as-made/hand-over", b, {});
    // Raised to admin since: the link was a writer's seat, and passes nothing now.
    await call("PUT", `/v1/spaces/as-made/members/${b.peerId}`, own, { role: "admin" });
    const z = await agent();
    const look = await call("POST", "/v1/invites/look", z, { link: writerSeat.body.link });
    assert.deepEqual([look.body.role, look.body.state], ["writer", "creator_no_longer_governs"]);
    const raised = await call("POST", "/v1/join", z, { link: writerSeat.body.link });
    assert.equal(raised.body.error.code, "INVITE_REVOKED");
    // Back to writer, the seat is as it was, and the link passes it again.
    await call("PUT", `/v1/spaces/as-made/members/${b.peerId}`, own, { role: "writer" });
    const again = await call("POST", "/v1/invites/look", z, { link: writerSeat.body.link });
    assert.equal(again.body.state, "live");
    const seatOffer = await call("POST", "/v1/spaces/as-made/hand-over", own, { to: b.peerId });
    const accepted = await call("POST", `/v1/hand-overs/${seatOffer.body.offer_id}/accept`, b);
    assert.equal(accepted.body.role, "owner");
    // B owns the SPACE now: its writer's seat is gone, and the old link with it.
    const late = await call("POST", "/v1/join", z, { link: writerSeat.body.link });
    assert.equal(late.body.error.code, "INVITE_REVOKED");
    const profile = await call("GET", "/v1/spaces/as-made", z);
    assert.notEqual(profile.body.owner, z.peerId, "a writer's hand-over never passes the SPACE");
  });

  test("a KEY let in again sits in a new seat: nothing its old seat made comes back", async () => {
    const own = await agent();
    await makeSpace(own, "new-seat");
    const b = await agent();
    await call("PUT", `/v1/spaces/new-seat/members/${b.peerId}`, own, { role: "writer" });
    const handed = await call("POST", "/v1/spaces/new-seat/hand-over", b, { expires_in_seconds: null });
    await call("DELETE", `/v1/spaces/new-seat/members/${b.peerId}`, b);
    await call("PUT", `/v1/spaces/new-seat/members/${b.peerId}`, own, { role: "writer" });
    const z = await agent();
    const out = await call("POST", "/v1/join", z, { link: handed.body.link });
    assert.equal(out.body.error.code, "INVITE_REVOKED");
  });

  test("a seat given up takes its hand-overs with it, so they never pass the seat it merged into", async () => {
    const own = await agent();
    await makeSpace(own, "given-up");
    const put = (who: Agent, role: string) => call("PUT", `/v1/spaces/given-up/members/${who.peerId}`, own, { role });
    const t = await agent();
    const m = await agent();
    const y = await agent();
    await put(t, "admin");
    await put(y, "reader");
    // While an admin, T keeps a hand-over link and makes an offer; then it is lowered.
    const kept = await call("POST", "/v1/spaces/given-up/hand-over", t, { expires_in_seconds: null });
    await put(t, "writer");
    // T takes admin M's seat, giving up its own.
    await put(m, "admin");
    const mSeat = await call("POST", "/v1/spaces/given-up/hand-over", m, {});
    assert.equal((await call("POST", "/v1/join", t, { link: mSeat.body.link })).body.role, "admin");
    const outsider = await agent();
    const look = await call("POST", "/v1/invites/look", outsider, { link: kept.body.link });
    assert.equal(look.body.state, "revoked", "made from the seat T gave up, so it died with it");
    // The seat T sits in now passes once, by T's new link, and the old one takes it from nobody.
    const x = await agent();
    const fresh = await call("POST", "/v1/spaces/given-up/hand-over", t, {});
    assert.equal((await call("POST", "/v1/join", x, { link: fresh.body.link })).body.role, "admin");
    const late = await call("POST", "/v1/join", outsider, { link: kept.body.link });
    assert.equal(late.body.error.code, "INVITE_REVOKED");
    const roster = await members("given-up", own);
    assert.equal(roster.items.find((r) => r.peer_id === x.peerId).role, "admin");
    // An offer made from a seat given up dies the same way.
    const c = await agent();
    await put(c, "coordinator");
    const offer = await call("POST", "/v1/spaces/given-up/hand-over", c, { to: y.peerId, expires_in_seconds: null });
    assert.equal(offer.status, 201, JSON.stringify(offer.body));
    await put(c, "reader");
    const n = await agent();
    await put(n, "coordinator");
    const nSeat = await call("POST", "/v1/spaces/given-up/hand-over", n, {});
    assert.equal((await call("POST", "/v1/join", c, { link: nSeat.body.link })).body.role, "coordinator");
    const accepted = await call("POST", `/v1/hand-overs/${offer.body.offer_id}/accept`, y);
    assert.equal(accepted.body.error?.code, "INVITE_REVOKED", JSON.stringify(accepted.body));
  });

  test("an offer to a KEY whose mailbox takes no more waits a minute, and says nothing to anyone else", async () => {
    const own = await agent();
    await makeSpace(own, "full-box");
    const busy = await agent();
    await call("PUT", `/v1/spaces/full-box/members/${busy.peerId}`, own, { role: "reader" });
    await fixture.setBucket(`rcpt:${busy.peerId}`, -1000000000);
    const res = await call("POST", "/v1/spaces/full-box/hand-over", own, { to: busy.peerId });
    const out = res.body;
    assert.equal(res.status, 429, JSON.stringify(out));
    assert.equal(out.error.code, "RATE_LIMITED");
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.equal(res.headers.get("RateLimit-Remaining"), null, "somebody else's allowance carries no numbers");
    const [delivered] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.mailbox_deliveries
       where recipient_id = ${Buffer.from(busy.peerId, "hex")} and reason = 'hand_over'`;
    assert.equal(delivered!.n, 0);
  });

  test("a link whose seat admits nobody any more is dead to a look, the list and a join alike", async () => {
    const own = await agent();
    await makeSpace(own, "no-longer");
    const c = await agent();
    await call("PUT", `/v1/spaces/no-longer/members/${c.peerId}`, own, { role: "coordinator" });
    const link = await call("POST", "/v1/spaces/no-longer/invites", c, { role: "reader" });
    await call("PUT", `/v1/spaces/no-longer/members/${c.peerId}`, own, { role: "writer" });
    const z = await agent();
    const look = await call("POST", "/v1/invites/look", z, { link: link.body.link });
    assert.equal(look.body.state, "creator_no_longer_governs");
    const list = await call("GET", "/v1/spaces/no-longer/invites", own);
    const listed = list.body.items.find((i: any) => i.invite_id === link.body.invite_id);
    assert.deepEqual([listed.active, listed.inactive_reason], [false, "creator_no_longer_governs"]);
    const used = await call("POST", "/v1/join", z, { link: link.body.link });
    assert.equal(used.body.error.code, "INVITE_REVOKED");
  });

  test("a link whose seat a blocked KEY holds is dead to a look, the list and a join alike", async () => {
    const own = await agent();
    await makeSpace(own, "maker-blocked");
    const c = await agent();
    const w = await agent();
    await call("PUT", `/v1/spaces/maker-blocked/members/${c.peerId}`, own, { role: "coordinator" });
    await call("PUT", `/v1/spaces/maker-blocked/members/${w.peerId}`, own, { role: "writer" });
    const invite = await call("POST", "/v1/spaces/maker-blocked/invites", c, { role: "reader" });
    const handOver = await call("POST", "/v1/spaces/maker-blocked/hand-over", w, {});
    assert.equal(handOver.status, 201, JSON.stringify(handOver.body));
    for (const before of [invite, handOver]) {
      const look = await call("POST", "/v1/invites/look", own, { link: before.body.link });
      assert.equal(look.body.state, "live", "live until its maker is blocked");
    }
    await fixture.owner`update schellingaf.peers set blocked_at = now()
                         where peer_id in (${Buffer.from(c.peerId, "hex")}, ${Buffer.from(w.peerId, "hex")})`;

    const z = await agent();
    const list = await call("GET", "/v1/spaces/maker-blocked/invites", own);
    for (const made of [invite, handOver]) {
      const look = await call("POST", "/v1/invites/look", z, { link: made.body.link });
      assert.equal(look.body.state, "creator_no_longer_governs");
      const listed = list.body.items.find((i: any) => i.invite_id === made.body.invite_id);
      assert.deepEqual([listed.active, listed.inactive_reason], [false, "creator_no_longer_governs"]);
      const used = await call("POST", "/v1/join", z, { link: made.body.link });
      assert.equal(used.body.error.code, "INVITE_REVOKED");
    }
  });

  test("who sits in a seat is told to its SPACE's members alone, a public SPACE's too", async () => {
    const own = await agent();
    await fixture.owner`update schellingaf.peers set registered_at = now() - interval '2 days' where peer_id = ${Buffer.from(own.peerId, "hex")}`;
    const made = await call("POST", "/v1/spaces", own, { name: "open-seats", title: "Open", visibility: "public" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const w = await agent();
    await call("PUT", `/v1/spaces/open-seats/members/${w.peerId}`, own, { role: "writer" });
    const [seat] = await fixture.owner<{ space_id: string; seat_id: string }[]>`
      select m.space_id::text, m.seat_id::text from schellingaf.memberships m
        join schellingaf.spaces s on s.space_id = m.space_id
       where s.name = 'open-seats' and m.peer_id = ${Buffer.from(w.peerId, "hex")}`;
    const stranger = await agent();
    for (const who of [stranger.peerId, null]) {
      const answer = await fixture.asCaller(who, async (sql) => {
        const [r] = await sql<{ who: string | null; role: string | null }[]>`
          select encode(schellingaf.seat_holder(${seat!.space_id}::uuid, ${seat!.seat_id}::uuid), 'hex') as who,
                 schellingaf.seat_role(${seat!.space_id}::uuid, ${seat!.seat_id}::uuid) as role`;
        return r!;
      });
      assert.deepEqual([answer.who, answer.role], [null, null], `told ${who ?? "a caller with no KEY"}`);
    }
    const asOwner = await fixture.asCaller(own.peerId, async (sql) => {
      const [r] = await sql<{ who: string }[]>`
        select encode(schellingaf.seat_holder(${seat!.space_id}::uuid, ${seat!.seat_id}::uuid), 'hex') as who`;
      return r!;
    });
    assert.equal(asOwner.who, w.peerId);
  });
});

describe("revoke and remove", () => {
  test("a link's KEYS, and whoever they let in, leave; anyone a governor changed since stays", async () => {
    const owner = await agent();
    await makeSpace(owner, "leak-space");
    const coordinatorLink = await call("POST", "/v1/spaces/leak-space/invites", owner, { role: "coordinator" });
    const k1 = await agent();
    await call("POST", "/v1/join", k1, { link: coordinatorLink.body.link });
    const childLink = await call("POST", "/v1/spaces/leak-space/invites", k1, { role: "writer" });
    const k2 = await agent();
    await call("POST", "/v1/join", k2, { link: childLink.body.link });
    const byK1 = await agent();
    await call("PUT", `/v1/spaces/leak-space/members/${byK1.peerId}`, k1, { role: "reader" });
    const k3 = await agent();
    await call("POST", "/v1/join", k3, { link: coordinatorLink.body.link });
    // The owner decides about k3 since: k3 no longer rests on the link.
    await call("PUT", `/v1/spaces/leak-space/members/${k3.peerId}`, owner, { role: "writer" });

    const removed = await call("POST", `/v1/invites/${coordinatorLink.body.invite_id}/remove`, owner);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.removed, 3);
    assert.equal(removed.body.remaining, 0);
    assert.equal(removed.body.removed_peers, undefined, "who was removed is logged, never returned");

    const roster = await members("leak-space", owner);
    assert.deepEqual(roster.items.map((m) => m.peer_id), [k3.peerId]);
    const late = await agent();
    const child = await call("POST", "/v1/join", late, { link: childLink.body.link });
    assert.equal(child.body.error.code, "INVITE_REVOKED", "every link they made died with them");
  });

  test("a large removal goes a batch at a time, and each call says how many remain", async () => {
    const owner = await agent();
    await makeSpace(owner, "batch-space");
    const made = await call("POST", "/v1/spaces/batch-space/invites", owner, { max_uses: null });
    const joiners: Agent[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await agent();
      await call("POST", "/v1/join", a, { link: made.body.link });
      joiners.push(a);
    }
    const [first] = await fixture.owner<{ r: any }[]>`
      select schellingaf.remove_link_members(${made.body.invite_id}::uuid, ${Buffer.from(owner.peerId, "hex")}, 2) as r`;
    assert.deepEqual([first!.r.removed, first!.r.remaining], [2, 3]);
    const [second] = await fixture.owner<{ r: any }[]>`
      select schellingaf.remove_link_members(${made.body.invite_id}::uuid, ${Buffer.from(owner.peerId, "hex")}, 2) as r`;
    assert.deepEqual([second!.r.removed, second!.r.remaining], [2, 1]);
    const last = await call("POST", `/v1/invites/${made.body.invite_id}/remove`, owner);
    assert.deepEqual([last.body.removed, last.body.remaining], [1, 0]);
  });

  test("each call reads again who is still in reach: a member changed between calls stays", async () => {
    const owner = await agent();
    const coord = await agent();
    await makeSpace(owner, "stale-space");
    await call("PUT", `/v1/spaces/stale-space/members/${coord.peerId}`, owner, { role: "coordinator" });
    const link = await call("POST", "/v1/spaces/stale-space/invites", coord, { role: "writer", max_uses: null });
    const joiners = [await agent(), await agent(), await agent()];
    for (const a of joiners) await call("POST", "/v1/join", a, { link: link.body.link });
    // A batch of one stands in for 500 of a set larger than 500.
    await fixture.owner`select schellingaf.remove_link_members(${link.body.invite_id}::uuid, ${Buffer.from(coord.peerId, "hex")}, 1)`;
    const left = (await members("stale-space", owner)).items.map((m) => m.peer_id);
    const [kept, promoted] = joiners.filter((a) => left.includes(a.peerId));
    // Between calls the owner decides about both: neither rests on the link any more.
    await call("PUT", `/v1/spaces/stale-space/members/${kept!.peerId}`, owner, { role: "writer", tags: ["kept"] });
    await call("PUT", `/v1/spaces/stale-space/members/${promoted!.peerId}`, owner, { role: "coordinator" });
    const x = await agent();
    await call("PUT", `/v1/spaces/stale-space/members/${x.peerId}`, promoted!, { role: "reader" });
    const theirs = await call("POST", "/v1/spaces/stale-space/invites", promoted!, { role: "reader" });

    const next = await call("POST", `/v1/invites/${link.body.invite_id}/remove`, coord);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.deepEqual([next.body.removed, next.body.remaining], [0, 0]);
    const after = (await members("stale-space", owner)).items.map((m) => m.peer_id);
    for (const stays of [kept!, promoted!, x]) assert.ok(after.includes(stays.peerId));
    const late = await agent();
    const used = await call("POST", "/v1/join", late, { link: theirs.body.link });
    assert.equal(used.status, 200, "a coordinator the owner made keeps its own links");
  });

  test("a KEY without the rank is refused before it waits on the SPACE", async () => {
    const owner = await agent();
    await makeSpace(owner, "queue-space");
    const reader = await agent();
    await call("PUT", `/v1/spaces/queue-space/members/${reader.peerId}`, owner, { role: "reader" });
    const link = await call("POST", "/v1/spaces/queue-space/invites", owner, {});
    // The SPACE held by a writer that never finishes: a refusal must not queue behind it.
    await fixture.owner.begin(async (hold) => {
      await hold`select 1 from schellingaf.spaces where name = 'queue-space' for no key update`;
      for (const fn of ["remove", "revoke"] as const) {
        let out = "ran";
        try {
          await fixture.owner.begin(async (tx) => {
            await tx`set local lock_timeout = '200ms'`;
            if (fn === "remove") {
              await tx`select schellingaf.remove_link_members(${link.body.invite_id}::uuid, ${Buffer.from(reader.peerId, "hex")})`;
            } else {
              await tx`select schellingaf.revoke_invite(${link.body.invite_id}::uuid, ${Buffer.from(reader.peerId, "hex")})`;
            }
          });
        } catch (e: any) {
          out = e.message;
        }
        assert.equal(out, "INVITE_NOT_FOUND", `${fn}: ${out}`);
      }
    });
  });

  test("a coordinator uses it on its own links, and on nobody else's", async () => {
    const owner = await agent();
    await makeSpace(owner, "own-links");
    const coordinator = await agent();
    await call("PUT", `/v1/spaces/own-links/members/${coordinator.peerId}`, owner, { role: "coordinator" });
    const ownersLink = await call("POST", "/v1/spaces/own-links/invites", owner, {});
    const denied = await call("POST", `/v1/invites/${ownersLink.body.invite_id}/remove`, coordinator);
    assert.equal(denied.body.error.code, "INVITE_NOT_FOUND");
    const mine = await call("POST", "/v1/spaces/own-links/invites", coordinator, {});
    const ok = await call("POST", `/v1/invites/${mine.body.invite_id}/remove`, coordinator);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe("swarm scale", () => {
  test("the database's limits are the ones the capability document publishes", async () => {
    const caps = (await call("GET", "/v1/capabilities")).body;
    for (const [name, value] of Object.entries(SPACE_LIMITS)) {
      if (name === "coordinators_per_space") continue;
      const [row] = await fixture.owner<{ n: string }[]>`select schellingaf.cap(${name})::text as n`;
      assert.equal(Number(row!.n), value, name);
      assert.equal(caps.limits[name], value, name);
    }
    const [unknown] = await fixture.owner<{ n: string }[]>`select schellingaf.cap('no-such-limit')::text as n`;
    assert.equal(unknown!.n, "0", "a misspelt limit refuses rather than admits");
    assert.equal(caps.modules.ownership_transfer.status, "available");
  });

  test("the member count is a tally, right through joins, leaves, removals and hand-overs", async () => {
    const owner = await agent();
    await makeSpace(owner, "tally-space");
    const count = async () => {
      const [row] = await fixture.owner<{ tally: number; real: number }[]>`
        select sp.member_count as tally,
               (select count(*)::int from schellingaf.memberships mm where mm.space_id = sp.space_id) as real
          from schellingaf.spaces sp where sp.name = 'tally-space'`;
      assert.equal(row!.tally, row!.real, "the tally drifted from the rows");
      return row!.tally;
    };
    const made = await call("POST", "/v1/spaces/tally-space/invites", owner, { max_uses: null });
    const a = await agent();
    const b = await agent();
    await call("POST", "/v1/join", a, { link: made.body.link });
    await call("POST", "/v1/join", b, { link: made.body.link });
    assert.equal(await count(), 2);
    await call("DELETE", `/v1/spaces/tally-space/members/${a.peerId}`, a);
    assert.equal(await count(), 1);
    const handed = await call("POST", "/v1/spaces/tally-space/hand-over", b, {});
    const c = await agent();
    await call("POST", "/v1/join", c, { link: handed.body.link });
    assert.equal(await count(), 1);
    await call("POST", `/v1/invites/${made.body.invite_id}/remove`, owner);
    assert.equal(await count(), 0);
  });

  test("a coordinator's notices spend the same allowance a writer's do", async () => {
    const owner = await agent();
    await makeSpace(owner, "fair-space");
    const coord = await agent();
    const reader = await agent();
    await call("PUT", `/v1/spaces/fair-space/members/${coord.peerId}`, owner, { role: "coordinator" });
    await call("PUT", `/v1/spaces/fair-space/members/${reader.peerId}`, owner, { role: "reader" });
    await fixture.setBucket(`dm:${coord.peerId}:${reader.peerId}`, -1000000000);
    const posted = await call("POST", "/v1/spaces/fair-space/posts", coord, { kind: "obs", body: "to the reader", to: [reader.peerId] });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.deepEqual(posted.body.not_notified, [reader.peerId]);
    const profile = await call("GET", "/v1/spaces/fair-space", coord);
    assert.equal(profile.body.access.post, true, "a coordinator is told it may post");
  });

  test("an offer reads no allowance but the sender's own before it is refused", async () => {
    const stranger = await agent();
    const target = await agent();
    await fixture.setBucket(`rcpt:${target.peerId}`, -1000000000);
    const out = await call("POST", "/v1/spaces/no-such-space/hand-over", stranger, { to: target.peerId });
    assert.equal(out.status, 404, "a busy mailbox says nothing to a KEY that may not offer there");
  });
});
