// Who may hand out a sealed SPACE's key, and who may read what a keeper reads.
//
// Every keeper write (a keeper list, a stamp for another KEY, locks, staging, activating
// and abandoning a change of key) and every keeper read (join requests, stamps, upkeep) is
// tried here by each KEY that must be refused: a stranger, an admin and a writer the
// owner's keeper list does not name, a listed keeper that left the SPACE, and a keeper a
// newer list dropped. Each is refused before anything is stored, and the owner's own call
// still works at the end, so the refusals are the gate and not a broken SPACE.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, sign, type KeyObject } from "node:crypto";
import { useService, call, agent as registered } from "./lib/service.ts";
import * as sealed from "../content/sealed.mjs";

useService("sec_sealed_gates");

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Agent = { token: string; peerId: string; key: KeyObject; enc: { sk: Uint8Array; pk: Uint8Array } };

async function agent(): Promise<Agent> {
  const { token, peerId, privateKey, enc } = await registered({ encryptionKey: true });
  return { token, peerId, key: privateKey, enc: enc! };
}

const signed = (a: Agent, label: string, statement: Uint8Array) =>
  sign(null, Buffer.from(sealed.signedBytes(label, statement)), a.key).toString("hex");

/** A lock from `sender` for `recipient`, as a keeper's software makes one. */
const lockFor = (container: Uint8Array, g: number, commitment: Uint8Array, secret: Uint8Array, sender: Agent, recipient: Agent) =>
  sealed.sealLock({
    container, g, recipient: bytes(recipient.peerId), sender: bytes(sender.peerId),
    commitment, secret, pkR: recipient.enc.pk, skS: sender.enc.sk,
  });

/** A sealed SPACE whose owner admitted each KEY in the role given, vouched for it by its own
 *  stamp, and locked the first key for it. */
async function sealedSpace(owner: Agent, admitted: [Agent, string][]) {
  const name = `sec-gates-${process.pid}-${randomUUID().slice(0, 8)}`;
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const made = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(await lockFor(container, 1, g1.commitment, g1.secret, owner, owner)) },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const locks: Record<string, string> = {};
  for (const [who, role] of admitted) {
    const asked = await call("POST", `/v1/spaces/${name}/join`, who.token, {});
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    const approved = await call("POST", `/v1/requests/${asked.body.request_id}/approve`, owner.token, { role });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const stamp = sealed.stampBytes({ issuer: owner.peerId, peerId: who.peerId });
    const stamped = await call("PUT", `/v1/spaces/${name}/sealed/stamp`, owner.token, {
      stamp: sealed.toB64u(stamp), alg: "ed25519", signature: signed(owner, sealed.LABELS.stamp, stamp),
    });
    assert.equal(stamped.status, 200, JSON.stringify(stamped.body));
    locks[who.peerId] = hex(await lockFor(container, 1, g1.commitment, g1.secret, owner, who));
  }
  const handed = await call("POST", `/v1/spaces/${name}/sealed/locks`, owner.token, { generation: "1", commitment: hex(g1.commitment), locks });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  return { name, spaceId, container, g1 };
}

describe("a sealed SPACE's keeper gates", () => {
  test("every keeper write and read refuses a stranger, an admin and a writer the keeper list does not name", async () => {
    const owner = await agent();
    const admin = await agent();
    const writer = await agent();
    const keeper = await agent();
    const stranger = await agent();
    const s = await sealedSpace(owner, [[admin, "admin"], [writer, "writer"], [keeper, "writer"]]);

    const listOf = (revision: number, keepers: string[]) =>
      sealed.keeperListBytes({ spaceId: s.spaceId, revision, keepers, admission: "stamped", stampers: [], changeEvery: 86400 });
    const listed = await call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, owner.token, {
      list: sealed.toB64u(listOf(1, [keeper.peerId])), alg: "ed25519", signature: signed(owner, sealed.LABELS.keepers, listOf(1, [keeper.peerId])),
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));

    // A change staged by the listed keeper, so that activating and abandoning one can be tried.
    const g2 = await sealed.newGeneration(s.container, 2, s.g1.secret);
    const staged = await call("POST", `/v1/spaces/${s.name}/sealed/generations`, keeper.token, {
      generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!),
    });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const state = async () => (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body;
    const before = await state();

    for (const [who, label] of [[stranger, "a stranger"], [admin, "an admin not listed"], [writer, "a writer not listed"]] as const) {
      const refused = (out: { status: number; body: any }, what: string, code = "NOT_A_KEEPER") => {
        assert.equal(out.status, 403, `${label}, ${what}: ${JSON.stringify(out.body)}`);
        assert.equal(out.body.error.code, code, `${label}, ${what}`);
      };
      const own = listOf(2, [who.peerId]);
      refused(await call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, who.token, {
        list: sealed.toB64u(own), alg: "ed25519", signature: signed(who, sealed.LABELS.keepers, own),
      }), "a keeper list");
      const stamp = sealed.stampBytes({ issuer: who.peerId, peerId: writer.peerId === who.peerId ? admin.peerId : writer.peerId });
      refused(await call("PUT", `/v1/spaces/${s.name}/sealed/stamp`, who.token, {
        stamp: sealed.toB64u(stamp), alg: "ed25519", signature: signed(who, sealed.LABELS.stamp, stamp),
      }), "a stamp for another KEY");
      refused(await call("POST", `/v1/spaces/${s.name}/sealed/locks`, who.token, {
        generation: "1", commitment: hex(s.g1.commitment), locks: { [stranger.peerId]: hex(await lockFor(s.container, 1, s.g1.commitment, s.g1.secret, who, stranger)) },
      }), "locks for the key in use");
      refused(await call("POST", `/v1/spaces/${s.name}/sealed/locks`, who.token, {
        generation: "2", commitment: hex(g2.commitment), locks: { [who.peerId]: hex(await lockFor(s.container, 2, g2.commitment, g2.secret, who, who)) },
      }), "a lock for the change staged");
      const g3 = await sealed.newGeneration(s.container, 3, g2.secret);
      refused(await call("POST", `/v1/spaces/${s.name}/sealed/generations`, who.token, {
        generation: "3", commitment: hex(g3.commitment), back: hex(g3.back!),
      }), "staging a change");
      refused(await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, who.token), "activating the change");
      refused(await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, who.token), "abandoning the change");
      // What a keeper reads: the join requests, and each waiting member's stamp.
      refused(await call("GET", `/v1/spaces/${s.name}/sealed/requests`, who.token), "the join requests",
        who === stranger ? "READ_DENIED" : "NOT_A_KEEPER");
      const waiting = await call("GET", `/v1/spaces/${s.name}/sealed/unlocked?generation=2`, who.token);
      const status = await call("GET", `/v1/spaces/${s.name}/sealed`, who.token);
      if (who === stranger) {
        refused(waiting, "who waits for the key", "READ_DENIED");
        refused(status, "where the key stands", "READ_DENIED");
      } else {
        assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
        assert.ok(waiting.body.items.length > 0);
        for (const m of waiting.body.items) assert.equal(m.stamp, null, `${label} read a member's stamp`);
        assert.equal(status.body.keeper, false);
        assert.equal(status.body.upkeep, null, `${label} read what only a keeper is told`);
        assert.deepEqual(status.body.locks.map((l: any) => l.generation), ["1"], `${label} holds a lock for the change staged`);
      }
    }

    // Nothing any of them sent was kept.
    const after = await state();
    assert.deepEqual(after.keeper_list, before.keeper_list);
    assert.deepEqual(after.staged, before.staged);
    assert.equal(after.generation, "1");
    const owed = (await call("GET", `/v1/spaces/${s.name}/sealed/unlocked?generation=2`, owner.token)).body.items.map((m: any) => m.peer_id);
    assert.ok(owed.includes(admin.peerId) && owed.includes(writer.peerId), "a refused lock was kept");
    const stamps = (await call("GET", `/v1/spaces/${s.name}/sealed/unlocked?generation=2`, owner.token)).body.items;
    for (const m of stamps.filter((x: any) => x.peer_id !== owner.peerId)) assert.equal(m.stamp.issuer, owner.peerId, "a refused stamp replaced the owner's");
  });

  test("a listed keeper that left, and one a newer list dropped, keep nothing of the role", async () => {
    const owner = await agent();
    const leaver = await agent();
    const dropped = await agent();
    const s = await sealedSpace(owner, [[leaver, "writer"], [dropped, "writer"]]);
    const put = (revision: number, keepers: string[]) => {
      const list = sealed.keeperListBytes({ spaceId: s.spaceId, revision, keepers, admission: "stamped", stampers: [], changeEvery: 86400 });
      return call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, owner.token, {
        list: sealed.toB64u(list), alg: "ed25519", signature: signed(owner, sealed.LABELS.keepers, list),
      });
    };
    assert.equal((await put(1, [leaver.peerId, dropped.peerId].sort())).status, 200);
    const g2 = await sealed.newGeneration(s.container, 2, s.g1.secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, dropped.token, {
      generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!),
    })).status, 201, "a listed keeper stages");

    const left = await call("DELETE", `/v1/spaces/${s.name}/members/${leaver.peerId}`, leaver.token);
    assert.equal(left.status, 200, JSON.stringify(left.body));
    // The leaver stays named, so the list refuses only the dropped keeper: the leaver is
    // refused for having left, and for nothing else.
    assert.equal((await put(2, [leaver.peerId])).status, 200);

    for (const [who, label] of [[leaver, "a keeper that left"], [dropped, "a keeper the list dropped"]] as const) {
      const locked = await call("POST", `/v1/spaces/${s.name}/sealed/locks`, who.token, {
        generation: "2", commitment: hex(g2.commitment), locks: { [owner.peerId]: hex(await lockFor(s.container, 2, g2.commitment, g2.secret, who, owner)) },
      });
      assert.equal(locked.body.error?.code, "NOT_A_KEEPER", `${label} handed a lock: ${JSON.stringify(locked.body)}`);
      const activated = await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, who.token);
      assert.equal(activated.body.error?.code, "NOT_A_KEEPER", `${label} activated`);
      const abandoned = await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, who.token);
      assert.equal(abandoned.body.error?.code, "NOT_A_KEEPER", `${label} abandoned`);
      const stamp = sealed.stampBytes({ issuer: who.peerId, peerId: owner.peerId });
      const stamped = await call("PUT", `/v1/spaces/${s.name}/sealed/stamp`, who.token, {
        stamp: sealed.toB64u(stamp), alg: "ed25519", signature: signed(who, sealed.LABELS.stamp, stamp),
      });
      assert.equal(stamped.body.error?.code, "NOT_A_KEEPER", `${label} put a stamp for another KEY`);
    }
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, leaver.token)).body.error?.code, "READ_DENIED", "a KEY that left still reads the key's state");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed/requests`, dropped.token)).body.error?.code, "NOT_A_KEEPER");

    // The owner is always a keeper: the change it did not stage is still its to abandon.
    const abandoned = await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, owner.token);
    assert.equal(abandoned.status, 200, JSON.stringify(abandoned.body));
  });
});
