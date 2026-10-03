// Two calls that reach the same mailboxes in opposite orders, at once, many times.
//
// append_post locks a POST's mailboxes in ascending peer id, but a batch writes its POSTS in
// order, so across POSTS it takes them in whatever order its items name them. Two batches in
// two SPACES naming the same two members in opposite orders then deadlock, and PostgreSQL
// aborts one with 40P01. That call rolled back whole, so the route writes it again: every
// call here must answer 201, each POST must be written once, and a plain single POST to both
// members, which can be the victim too, must land as well.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, fixture, type Agent } from "./lib/service.ts";

const ready = useService("postdeadlock", { oracleReviewer: null });
let owner: Agent, a: Agent, b: Agent, c: Agent, r: Agent, x: Agent;
const ONE = `dl-one-${process.pid}`;
const TWO = `dl-two-${process.pid}`;
const THREE = `dl-three-${process.pid}`;
const ROUNDS = 30;

before(async () => {
  await ready;
  [owner, a, b, c, r, x] = await Promise.all([agent(), agent(), agent(), agent(), agent(), agent()]);
  for (const name of [ONE, TWO, THREE]) {
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: name })).status, 201);
    for (const who of [a, b, c, r, x]) {
      assert.equal((await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role: "writer" })).status, 200);
    }
  }
});

test("batches that reach two mailboxes in opposite orders are all written, each POST once", async () => {
  const codes: Record<string, number> = {};
  const item = (to: string, i: number) => ({ kind: "obs", title: `n${i}`, body: "x".repeat(20000), to: [to] });
  for (let round = 0; round < ROUNDS; round++) {
    for (const who of [a, b, c]) await fixture.setBucket(`peer:${who.peerId}`, 60);
    for (const from of [a, b, c]) {
      for (const to of [r, x]) await fixture.setBucket(`dm:${from.peerId}:${to.peerId}`, 200);
    }
    for (const to of [r, x]) await fixture.setBucket(`rcpt:${to.peerId}`, 200);
    const one = call("POST", `/v1/spaces/${ONE}/posts`, a.token, { posts: [item(r.peerId, 0), item(x.peerId, 1), item(r.peerId, 2), item(x.peerId, 3)] });
    const two = call("POST", `/v1/spaces/${TWO}/posts`, b.token, { posts: [item(x.peerId, 0), item(r.peerId, 1), item(x.peerId, 2), item(r.peerId, 3)] });
    const three = call("POST", `/v1/spaces/${THREE}/posts`, c.token, { kind: "obs", title: "both", body: "y".repeat(20000), to: [r.peerId, x.peerId] });
    for (const out of await Promise.all([one, two, three])) {
      const code = out.status === 201 ? "201" : `${out.status} ${out.body?.error?.code} ${out.body?.error?.detail ?? ""}`;
      codes[code] = (codes[code] ?? 0) + 1;
    }
  }
  assert.deepEqual(codes, { "201": ROUNDS * 3 });
  // Written once each: a call written again after a deadlock left nothing of its first try.
  const [posted] = await fixture.owner<{ one: number; two: number; three: number }[]>`
    select count(*) filter (where s.name = ${ONE})::int as one,
           count(*) filter (where s.name = ${TWO})::int as two,
           count(*) filter (where s.name = ${THREE})::int as three
      from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where p.kind = 'obs'`;
  assert.deepEqual(posted, { one: ROUNDS * 4, two: ROUNDS * 4, three: ROUNDS });
});
