// A KEY that may not act on a SPACE is refused before it waits on the SPACE's lock.
//
// Every control function asks first, unlocked, whether the caller may do what it asks,
// and only then takes the SPACE row (.claude/rules/plpgsql.md, "Check order"). A call
// refused only after the lock queues behind the SPACE's real writers, and how long it
// waited tells a stranger how busy a private SPACE is. Here the SPACE is held by a
// writer that never finishes, and each refusal must come back inside a 200 ms lock wait.
// links.test.ts holds revoke and remove to the same rule.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { useService, call, agent, fixture, type Agent } from "./lib/service.ts";

const ready = useService("sec_so_precheck");

const key = (a: Agent) => Buffer.from(a.peerId, "hex");

let owner: Agent;
let reader: Agent;
let writer: Agent;
let stranger: Agent;
let requestId: string;

before(async () => {
  await ready;
  owner = await agent();
  for (const [name, join_policy] of [["held-space", "request"], ["shut-space", "invite"]]) {
    const made = await call("POST", "/v1/spaces", owner, { name, title: `The ${name}`, join_policy });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  reader = await agent();
  writer = await agent();
  for (const [who, role] of [[reader, "reader"], [writer, "writer"]] as const) {
    const out = await call("PUT", `/v1/spaces/held-space/members/${who.peerId}`, owner, { role });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
  stranger = await agent();
  const asker = await agent();
  const asked = await call("POST", "/v1/spaces/held-space/join", asker, { message: "let me in" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  requestId = asked.body.request_id;
});

/** Runs `fn` while another transaction holds the SPACES' rows, and answers the refusal
 *  it met, or "ran" when it was not refused, or the lock timeout when it waited. */
async function whileHeld(fn: (tx: any) => Promise<unknown>): Promise<string> {
  let out = "ran";
  await fixture.owner.begin(async (hold) => {
    await hold`select 1 from schellingaf.spaces where name in ('held-space', 'shut-space') for no key update`;
    try {
      await fixture.owner.begin(async (tx) => {
        await tx`set local lock_timeout = '200ms'`;
        await fn(tx);
      });
    } catch (e: any) {
      out = e.message;
    }
  });
  return out;
}

describe("refused before the SPACE's lock", () => {
  test("a grant by a KEY that admits nobody", async () => {
    for (const actor of [stranger, reader, writer]) {
      const out = await whileHeld((tx) =>
        tx`select schellingaf.grant_membership('held-space', ${key(actor)}, ${key(stranger)}, 'reader', null)`);
      assert.equal(out, "CONTROL_DENIED");
    }
  });

  test("a removal by a KEY that admits nobody", async () => {
    for (const actor of [stranger, reader, writer]) {
      const out = await whileHeld((tx) =>
        tx`select schellingaf.revoke_membership('held-space', ${key(actor)}, ${key(reader)})`);
      assert.equal(out, "CONTROL_DENIED");
    }
  });

  test("leaving, by a KEY that is not in the SPACE, and by its owner", async () => {
    assert.equal(await whileHeld((tx) => tx`select schellingaf.leave_space('held-space', ${key(stranger)})`), "NOT_A_MEMBER");
    assert.equal(await whileHeld((tx) => tx`select schellingaf.leave_space('held-space', ${key(owner)})`), "OWNER_CANNOT_LEAVE");
  });

  test("a decision on a join request by a KEY that admits nobody", async () => {
    for (const actor of [stranger, reader, writer]) {
      for (const decision of ["approve", "decline"]) {
        const out = await whileHeld((tx) =>
          tx`select schellingaf.decide_request(${requestId}::uuid, ${key(actor)}, ${decision}, null, null)`);
        assert.equal(out, "REQUEST_NOT_FOUND", `${decision}: ${out}`);
      }
    }
  });

  test("a code that is no link of the SPACE, and an ask where only a link admits", async () => {
    const guess = createHash("sha256").update("schellingaf_inv_not-a-code").digest();
    assert.equal(
      await whileHeld((tx) => tx`select schellingaf.join_space('held-space', ${key(stranger)}, ${guess}, null)`),
      "INVITE_INVALID",
    );
    assert.equal(
      await whileHeld((tx) => tx`select schellingaf.join_space('shut-space', ${key(stranger)}, null, 'hello')`),
      "JOIN_BY_INVITE_ONLY",
    );
  });

  test("whoever may act still does, after the lock", async () => {
    // Nothing held: each call that passes its pre-check is decided under the lock as before.
    const target = await agent();
    const granted = await call("PUT", `/v1/spaces/held-space/members/${target.peerId}`, owner, { role: "reader" });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    const left = await call("DELETE", `/v1/spaces/held-space/members/${target.peerId}`, target);
    assert.equal(left.status, 200, JSON.stringify(left.body));
    const decided = await call("POST", `/v1/requests/${requestId}/approve`, owner, { role: "reader" });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const link = await call("POST", "/v1/spaces/shut-space/invites", owner, {});
    const joined = await call("POST", "/v1/join", stranger, { link: link.body.link ?? undefined, name: "shut-space", code: link.body.code });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const owners = await call("POST", "/v1/spaces/shut-space/join", owner, { code: "schellingaf_inv_" + "0".repeat(32) });
    assert.equal(owners.body.role, "owner", "an owner sending any code is told it owns the SPACE, as before");
  });
});
