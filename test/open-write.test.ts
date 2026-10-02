// Open write: a public work space any KEY posts in without joining, a SPACE's owner and
// admins blocking a KEY from posting and hiding a post, and the mark every post carries
// when its author held no role in its SPACE. append_post, set_space_block and
// set_post_hidden hold the rules; these drive them through the routes, as an agent
// would.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, db, fixture, config, call, agent, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { verifyPost } from "../src/domain/verify.ts";

const HOST = "api.open-write.test";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  // Fifty KEYS registering or posting at once queue at the global gate, which refuses
  // one that waits past a second, as a busy machine makes them. The gate is
  // load-limits.test.ts's subject; here it waits as long as the posts take.
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
useService("open_write", { apiHost: HOST, oracleReviewer: null });

let n = 0;
async function openSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `open-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Findings", visibility: "public", join_policy: "open", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.join_policy, "open");
  return name;
}

async function post(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "obs", body: "Seen.", ...fields });
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

describe("which SPACES may be open", () => {
  test("a public work space may, and a private one, an oracle space or a sealed one may not", async () => {
    const owner = await agent();
    await openSpace(owner);
    const refused = "join_policy open is for a public work space";
    for (const extra of [{ visibility: "private" }, { oracle: true }, {}]) {
      const out = await call("POST", "/v1/spaces", owner.token, { name: `nope-${n++}`, title: "T", join_policy: "open", ...extra });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.detail, refused);
    }
    // Changed later: the database knows what the SPACE is and refuses in the same words.
    const closed = `closed-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: closed, title: "T" })).status, 201);
    const patched = await call("PATCH", `/v1/spaces/${closed}`, owner.token, { join_policy: "open" });
    assert.equal(patched.status, 400, JSON.stringify(patched.body));
    assert.equal(patched.body.error.detail, refused);
    const shown = `shown-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: shown, title: "T", visibility: "public" })).status, 201);
    const opened = await call("PATCH", `/v1/spaces/${shown}`, owner.token, { join_policy: "open" });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal((await call("GET", `/v1/spaces/${shown}`)).body.join_policy, "open");
  });

  test("the capability document says open write is available, and how", async () => {
    const caps = (await call("GET", "/v1/capabilities")).body;
    assert.ok(caps.join_policies.includes("open"));
    assert.equal(caps.modules.open_write.status, "available");
    assert.match(caps.modules.open_write.mark, /no_role/);
    assert.deepEqual(caps.rate_limits.open_posts_per_peer, { per_day: 60, first_day: 10 });
    assert.deepEqual(caps.rate_limits.open_posts_per_space, { per_day: 10000 });
  });
});

describe("any KEY posts in an open work space", () => {
  test("joining one creates nothing, spends no ask, and says to post", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    const before = (await call("GET", `/v1/spaces/${name}`, owner.token)).body.revision;
    const joined = await call("POST", `/v1/spaces/${name}/join`, stranger.token, { message: "let me in" });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.state, "open");
    assert.match(joined.body.notice, /Nothing to join here: POST/);
    const profile = (await call("GET", `/v1/spaces/${name}`, owner.token)).body;
    assert.equal(profile.revision, before, "a join that creates nothing moves no revision");
    assert.equal(profile.member_count, 0);
    const requests = await call("GET", `/v1/spaces/${name}/requests`, owner.token);
    assert.deepEqual(requests.body.items, []);
    const asks = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key like 'req:%'`;
    assert.equal(asks[0]!.n, 0, "no ask was read or spent");
  });

  test("a stranger posts, its posts carry no_role at every detail, and a member's never do", async () => {
    const owner = await agent();
    const stranger = await agent();
    const reader = await agent();
    const name = await openSpace(owner);
    await grant(owner, name, reader, "reader");
    const theirs = await post(stranger, name, { body: "A stranger saw it." });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    assert.equal(theirs.body.no_role, true);
    // A reader holds a role: it may post in an open work space, unmarked.
    const readers = await post(reader, name, { body: "A reader saw it." });
    assert.equal(readers.status, 201, JSON.stringify(readers.body));
    assert.equal(readers.body.no_role, undefined);
    const mine = await post(owner, name, { body: "The owner saw it." });
    assert.equal(mine.body.no_role, undefined);
    for (const detail of ["ids", "snippets", "full"]) {
      const items = (await call("GET", `/v1/spaces/${name}/posts?detail=${detail}`)).body.items as any[];
      assert.deepEqual(items.map((p) => p.no_role ?? false), [true, false, false], detail);
    }
    const one = await call("GET", `/v1/posts/${theirs.body.post_id}`);
    assert.equal(one.body.no_role, true);
    // A replay says what the post was written as.
    const again = await post(stranger, name, { body: "Once.", idempotency_key: "k1" });
    const replay = await post(stranger, name, { body: "Once.", idempotency_key: "k1" });
    assert.equal(again.body.no_role, true);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.no_role, true);
    // The stranger never became a member.
    const profile = (await call("GET", `/v1/spaces/${name}`, stranger.token)).body;
    assert.equal(profile.access.role, null);
    assert.equal(profile.access.post, true);
    assert.equal((await call("GET", `/v1/spaces/${name}/members`, stranger.token)).status, 403);
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.access.post, false, "no KEY, no post");
  });

  test("posting where a KEY holds no role spends one allowance, in open work spaces and oracle spaces alike", async () => {
    const owner = await agent();
    const stranger = await agent();
    const open = await openSpace(owner);
    const oracle = `oracle-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Doc", oracle: true })).status, 201);
    // A KEY registered in the last day: ten, between both.
    for (let i = 0; i < 6; i++) assert.equal((await post(stranger, open, { body: `Open ${i}.` })).status, 201);
    for (let i = 0; i < 4; i++) assert.equal((await post(stranger, oracle, { body: `Oracle ${i}.` })).status, 201);
    const eleventh = await post(stranger, open, { body: "One more." });
    assert.equal(eleventh.status, 429, JSON.stringify(eleventh.body));
    assert.equal(eleventh.body.error.code, "RATE_LIMITED");
    assert.ok(Number(eleventh.headers.get("Retry-After")) > 60, "its own allowance says how long to wait");
    assert.equal(eleventh.headers.get("RateLimit-Remaining"), null, "no numbers of the write allowance spent before it");
    // Refused, it spent nothing: the SPACE's own count moved by its six, not seven.
    const [bucket] = await fixture.owner<{ tokens: number }[]>`
      select b.tokens from schellingaf.rate_buckets b
        join schellingaf.spaces s on b.key = 'open-space:' || s.space_id::text
       where s.name = ${open}`;
    assert.equal(Math.floor(bucket!.tokens), 10000 - 6, String(bucket!.tokens));
    // The owner writes as ever.
    assert.equal((await post(owner, open)).status, 201);
  });

  test("a reply reaches a stranger who wrote, and a stranger reaches nobody who blocks its messages", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    const asked = await post(stranger, name, { kind: "question", body: "Does it build?" });
    const answered = await post(owner, name, { kind: "result", body: "Yes.", reply_to: asked.body.post_id });
    assert.equal(answered.status, 201);
    const mail = (await call("GET", "/v1/mailbox?reason=reply", stranger.token)).body.items as any[];
    assert.ok(mail.some((m) => m.post?.post_id === answered.body.post_id), JSON.stringify(mail));

    assert.equal((await call("PUT", `/v1/blocks/${stranger.peerId}`, owner.token)).status, 200);
    const addressed = await post(stranger, name, { body: "For you.", to: [owner.peerId] });
    assert.equal(addressed.status, 201, JSON.stringify(addressed.body));
    assert.deepEqual(addressed.body.not_notified, [owner.peerId]);
    const inbox = (await call("GET", "/v1/mailbox?reason=to", owner.token)).body.items as any[];
    assert.equal(inbox.some((m) => m.post?.post_id === addressed.body.post_id), false);
  });
});

describe("what a stranger learns and reaches", () => {
  test("a KEY with no role addresses only the owner, so no refusal tells it who the members are", async () => {
    const owner = await agent();
    const member = await agent();
    const outsider = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    await grant(owner, name, member, "writer");
    const refusals = [];
    for (const who of [member, outsider]) {
      const out = await post(stranger, name, { to: [who.peerId] });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      refusals.push(out.body.error.detail);
    }
    assert.equal(refusals[0], refusals[1], "a member and a non-member are refused alike");
    assert.equal(refusals[0], "a KEY with no role here addresses only the owner with to");
    assert.equal((await post(stranger, name, { to: [owner.peerId] })).status, 201);
    // A member addresses members as ever.
    const other = await agent();
    await grant(owner, name, other, "reader");
    assert.equal((await post(member, name, { to: [other.peerId] })).status, 201);
  });

  test("a reply to a member who blocks the stranger's messages is written, and says who was not told", async () => {
    const owner = await agent();
    const member = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    await grant(owner, name, member, "writer");
    const theirs = await post(member, name, { kind: "question", body: "Anyone?" });
    assert.equal((await call("PUT", `/v1/blocks/${stranger.peerId}`, member.token)).status, 200);
    const reply = await post(stranger, name, { body: "Me.", reply_to: theirs.body.post_id });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.not_notified, [member.peerId]);
  });

  test("an oracle space's discussion keeps no ceiling of its own", async () => {
    const owner = await agent();
    const stranger = await agent();
    const oracle = `oracle-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Doc", oracle: true })).status, 201);
    assert.equal((await post(stranger, oracle)).status, 201);
    const rows = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.rate_buckets b
        join schellingaf.spaces s on b.key = 'open-space:' || s.space_id::text
       where s.name = ${oracle}`;
    assert.equal(rows[0]!.n, 0);
  });
});

describe("the service's reviewer", () => {
  test("a block never stops it deciding a proposal, and stops anything else it posts", async () => {
    const owner = await agent();
    const reviewer = await agent();
    const stranger = await agent();
    const reviewing = createApp({ ...config, oracleReviewer: reviewer.peerId }, db);
    const as = async (path: string, token: string, payload: unknown) => {
      const res = await reviewing.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() as any };
    };
    const oracle = `oracle-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Doc", oracle: true })).status, 201);
    const v1 = await as(`/v1/spaces/${oracle}/posts`, owner.token, { kind: "version", body: "The text." });
    const proposal = await as(`/v1/spaces/${oracle}/posts`, stranger.token, { kind: "version", body: "Better text.", supersedes: v1.body.post_id });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal((await call("PUT", `/v1/spaces/${oracle}/blocks/${reviewer.peerId}`, owner.token)).status, 200);
    const decided = await as(`/v1/spaces/${oracle}/posts`, reviewer.token, { kind: "go", body: "Accepted.", reply_to: proposal.body.post_id });
    assert.equal(decided.status, 201, JSON.stringify(decided.body));
    assert.equal(decided.body.no_role, undefined, "its decision is an admin's, unmarked");
    const remark = await as(`/v1/spaces/${oracle}/posts`, reviewer.token, { kind: "obs", body: "A remark." });
    assert.equal(remark.body.error.code, "WRITE_BLOCKED");
  });
});

describe("many strangers at once", () => {
  test("fifty KEYS with no role post into one open work space together, and its stream stays gap-free", async () => {
    const owner = await agent();
    const name = await openSpace(owner);
    const strangers = await Promise.all(Array.from({ length: 50 }, () => agent()));
    const out = await Promise.all(strangers.map((s, i) => post(s, name, { body: `Arrived ${i}.` })));
    assert.deepEqual(out.map((o) => o.status), out.map(() => 201), JSON.stringify(out.find((o) => o.status !== 201)?.body));
    const seqs = out.map((o) => Number(o.body.seq)).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
    assert.ok(out.every((o) => o.body.no_role === true));
  });

  test("a block and a hide racing posts never lose a post or deadlock", async () => {
    const owner = await agent();
    const name = await openSpace(owner);
    const strangers = await Promise.all(Array.from({ length: 8 }, () => agent()));
    const first = await post(strangers[0]!, name, { body: "First." });
    const results = await Promise.all([
      ...strangers.map((s, i) => post(s, name, { body: `Racing ${i}.` })),
      call("PUT", `/v1/spaces/${name}/blocks/${strangers[1]!.peerId}`, owner.token),
      call("PUT", `/v1/posts/${first.body.post_id}/hidden`, owner.token),
    ]);
    for (const r of results) assert.ok([200, 201, 403].includes(r.status), JSON.stringify(r.body));
    const items = (await call("GET", `/v1/spaces/${name}/posts?detail=ids&limit=200`)).body.items as any[];
    assert.deepEqual(items.map((p) => Number(p.seq)), Array.from({ length: items.length }, (_, i) => i + 1));
    assert.equal(items[0].unavailable.state, "hidden");
  });
});

describe("blocked from posting", () => {
  test("the owner blocks a stranger, who reads and cannot post or ask, until unblocked", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    assert.equal((await post(stranger, name)).status, 201);
    const blocked = await call("PUT", `/v1/spaces/${name}/blocks/${stranger.peerId}`, owner.token);
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(blocked.body.blocked, true);
    assert.equal(blocked.body.changed, true);
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${stranger.peerId}`, owner.token)).body.changed, false);

    const refused = await post(stranger, name);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "WRITE_BLOCKED");
    assert.equal((await call("POST", `/v1/spaces/${name}/join`, stranger.token, {})).body.error.code, "WRITE_BLOCKED");
    const profile = (await call("GET", `/v1/spaces/${name}`, stranger.token)).body;
    assert.equal(profile.access.post, false);
    assert.equal(profile.access.blocked, true);
    assert.equal(profile.access.read, true);
    assert.equal((await call("GET", `/v1/spaces/${name}/posts`, stranger.token)).status, 200);

    const list = await call("GET", `/v1/spaces/${name}/blocks`, owner.token);
    assert.deepEqual(list.body.items.map((b: any) => b.peer_id), [stranger.peerId]);
    assert.equal((await call("GET", `/v1/spaces/${name}/blocks`, stranger.token)).body.error.code, "CONTROL_DENIED");

    const events = (await call("GET", `/v1/spaces/${name}/events`, owner.token)).body.items as any[];
    assert.ok(events.some((e) => e.event === "peer.blocked" && e.payload.peer_id === stranger.peerId));

    assert.equal((await call("DELETE", `/v1/spaces/${name}/blocks/${stranger.peerId}`, owner.token)).status, 200);
    assert.equal((await post(stranger, name)).status, 201);
  });

  test("an admin blocks below its rank, a member included, and never an admin, the owner or itself", async () => {
    const owner = await agent();
    const admin = await agent();
    const other = await agent();
    const writer = await agent();
    const name = `governed-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "T" })).status, 201);
    await grant(owner, name, admin, "admin");
    await grant(owner, name, other, "admin");
    await grant(owner, name, writer, "writer");
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${writer.peerId}`, admin.token)).status, 200);
    assert.equal((await post(writer, name)).body.error.code, "WRITE_BLOCKED");
    for (const target of [other, owner, admin]) {
      const out = await call("PUT", `/v1/spaces/${name}/blocks/${target.peerId}`, admin.token);
      assert.equal(out.body.error.code, "CONTROL_DENIED", JSON.stringify(out.body));
    }
    // A writer blocks nobody.
    const out = await call("PUT", `/v1/spaces/${name}/blocks/${other.peerId}`, writer.token);
    assert.equal(out.body.error.code, "CONTROL_DENIED");
  });
});

describe("hidden", () => {
  test("a hidden post keeps its place and chain link, and its words leave every read and SEEK", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    const word = `zanzibarquux${process.pid}`;
    const spam = await post(stranger, name, { title: "Buy", body: `Cheap ${word} here.`, fingerprints: [{ scheme: "task.reference", value: word }] });
    assert.equal(spam.status, 201);
    assert.equal((await post(owner, name, { body: "Later." })).status, 201);
    assert.equal((await call("GET", `/v1/seek?q=${word}`)).body.items.length, 1);

    const hid = await call("PUT", `/v1/posts/${spam.body.post_id}/hidden`, owner.token);
    assert.equal(hid.status, 200, JSON.stringify(hid.body));
    assert.equal(hid.body.hidden, true);

    const one = (await call("GET", `/v1/posts/${spam.body.post_id}`)).body;
    assert.equal(one.unavailable.state, "hidden");
    assert.equal(one.body, null);
    assert.equal(one.title, null);
    assert.equal(one.no_role, true, "the mark stays: it is the service's record, not the author's words");
    const full = (await call("GET", `/v1/spaces/${name}/posts?detail=full&proof=true`, stranger.token)).body.items as any[];
    assert.equal(full.length, 2, "it keeps its place");
    assert.equal(full[0].body, null);
    assert.deepEqual(full[0].fingerprints, []);
    assert.equal(full[0].fingerprint_count, 0, "not even how many it had");
    assert.equal(full[0].proof.canonical, null);
    assert.equal(JSON.stringify(full).includes(word), false);
    // Its chain link and the next post's still check.
    const site = { rpId: HOST, origins: [`https://${HOST}`] } as never;
    assert.deepEqual(full.flatMap((p) => verifyPost(p, site)), []);
    assert.equal(full[1].proof.previous_hash, full[0].proof.chain_hash);
    assert.equal((await call("GET", `/v1/seek?q=${word}`)).body.items.length, 0);
    assert.equal((await call("GET", `/v1/seek?fingerprint=task.reference:${word}`)).body.items.length, 0);
    const events = (await call("GET", `/v1/spaces/${name}/events`, owner.token)).body.items as any[];
    assert.ok(events.some((e) => e.event === "post.hidden" && e.payload.post_id === spam.body.post_id));

    assert.equal((await call("DELETE", `/v1/posts/${spam.body.post_id}/hidden`, owner.token)).status, 200);
    assert.match((await call("GET", `/v1/posts/${spam.body.post_id}`)).body.body, new RegExp(word));
  });

  test("only the owner or an admin hides, a post ranked below it, and never an oracle space's version or decision", async () => {
    const owner = await agent();
    const writer = await agent();
    const stranger = await agent();
    const name = await openSpace(owner);
    await grant(owner, name, writer, "writer");
    const theirs = await post(stranger, name);
    const ownersOwn = await post(owner, name);
    assert.equal((await call("PUT", `/v1/posts/${theirs.body.post_id}/hidden`, writer.token)).body.error.code, "CONTROL_DENIED");
    assert.equal((await call("PUT", `/v1/posts/${ownersOwn.body.post_id}/hidden`, owner.token)).body.error.code, "CONTROL_DENIED");
    assert.equal((await call("PUT", `/v1/posts/00000000-0000-4000-8000-000000000000/hidden`, owner.token)).body.error.code, "POST_NOT_FOUND");

    const oracle = `oracle-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Doc", oracle: true })).status, 201);
    const v1 = await call("POST", `/v1/spaces/${oracle}/posts`, owner.token, { kind: "version", body: "The text." });
    const proposal = await call("POST", `/v1/spaces/${oracle}/posts`, stranger.token, { kind: "version", body: "Junk.", supersedes: v1.body.post_id });
    assert.equal(proposal.body.no_role, true);
    const out = await call("PUT", `/v1/posts/${proposal.body.post_id}/hidden`, owner.token);
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.match(out.body.error.detail, /every version and every decision/);
    // A block there stops further proposals.
    assert.equal((await call("PUT", `/v1/spaces/${oracle}/blocks/${stranger.peerId}`, owner.token)).status, 200);
    const again = await call("POST", `/v1/spaces/${oracle}/posts`, stranger.token, { kind: "obs", body: "More." });
    assert.equal(again.body.error.code, "WRITE_BLOCKED");
  });
});
