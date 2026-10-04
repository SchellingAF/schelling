// An unscoped SEEK fills its page past the per-SPACE cap, and names what it left out.
//
// proposal-seek-hits-per-space (4 October 2026): a fingerprint held by twenty posts of one
// public SPACE answered two of twenty places, and said nothing. The caps now choose in
// rounds (migrations/0135_seek_fill.sql): round 1 is the old answer row for row, and each
// later round takes up to two more from a SPACE and three more from an owner, to fill
// places nobody else wanted. The note names the public SPACES whose hits still did not fit.
//
// The scenes are written straight into the database, as flood.test.ts writes its own, so
// a SPACE of many posts costs no write allowance; the searches go through the route, or
// through the functions as the api role with the caller bound.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { publicKey } from "./helpers.ts";
import { LEFT_OUT_NAMED, LEFT_OUT_NOTE, leftOutNote } from "../src/http/seek.ts";

const ready = useService("seek_fill");

async function peer(seed: string): Promise<Buffer> {
  const [row] = await fixture.owner<{ id: Buffer }[]>`
    select schellingaf.register_peer(${publicKey(seed)}, null) as id`;
  return row!.id;
}

async function publicSpace(owner: Buffer, name: string): Promise<void> {
  await fixture.owner`
    select schellingaf.create_space(${owner}, ${name}, ${"a public space"}, ${""}, ${"request"}, ${"public"})`;
}

/** One post, written the way the route writes it, and its id. */
async function post(space: string, author: Buffer, body: string, print: string | null, kind = "result"): Promise<string> {
  const [row] = await fixture.owner<{ receipt: { post_id: string } }[]>`
    select schellingaf.append_post(
      ${space}, ${author}, ${kind}, ${"A post in a test"}, ${body}, ${null}, ${null},
      ${"{}"}::bytea[], ${null}, ${null}, ${null}, ${null},
      ${fixture.owner.json(print ? [{ scheme: "subject", value: print }] : [])}, ${randomUUID()}) as receipt`;
  return row!.receipt.post_id;
}

// ── the rounds, as a model ──────────────────────────────────────────────────

type Row = { id: string; space: string; owner: string };
type Placed = { id: string; round: number };
const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/** The rule 0135 states, written plainly: rows newest first in, page order out. */
function rounds(rows: Row[], perSpace = 2, perOwner = 3): Placed[] {
  const inSpace = new Map<string, number>();
  const ranked = rows.map((r) => {
    const n = (inSpace.get(r.space) ?? 0) + 1;
    inSpace.set(r.space, n);
    return { ...r, spaceRound: Math.ceil(n / perSpace) };
  });
  const byOwner = new Map<string, typeof ranked>();
  for (const r of ranked) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
  const out: Placed[] = [];
  for (const list of byOwner.values()) {
    list.sort((a, b) => a.spaceRound - b.spaceRound || newestFirst(a.id, b.id));
    list.forEach((r, i) => out.push({ id: r.id, round: Math.max(r.spaceRound, Math.ceil((i + 1) / perOwner)) }));
  }
  return out.sort((a, b) => a.round - b.round || newestFirst(a.id, b.id));
}

/** What 0107 kept: two a SPACE newest first, then three an owner of those. */
function oldKept(rows: Row[]): Set<string> {
  const inSpace = new Map<string, number>();
  const two = rows.filter((r) => {
    const n = (inSpace.get(r.space) ?? 0) + 1;
    inSpace.set(r.space, n);
    return n <= 2;
  });
  const inOwner = new Map<string, number>();
  return new Set(
    two
      .filter((r) => {
        const n = (inOwner.get(r.owner) ?? 0) + 1;
        inOwner.set(r.owner, n);
        return n <= 3;
      })
      .map((r) => r.id),
  );
}

describe("the rounds", () => {
  // Owner X with two SPACES of 5 and 3 posts, Y with one of 4, Z with one of 1, written
  // in turn so the newest of each are interleaved. Identical bodies rank equal, so the
  // word search orders them newest first too, and one model answers for both functions.
  const scene: Row[] = [];
  before(async () => {
    await ready;
    const owners = { x: await peer("fill-x"), y: await peer("fill-y"), z: await peer("fill-z") };
    const spaces: [string, keyof typeof owners, number][] = [["fill-x1", "x", 5], ["fill-x2", "x", 3], ["fill-y1", "y", 4], ["fill-z1", "z", 1]];
    for (const [name, owner] of spaces) await publicSpace(owners[owner], name);
    for (let i = 0; i < 5; i++) {
      for (const [name, owner, count] of spaces) {
        if (i >= count) continue;
        const id = await post(name, owners[owner], "obsidianfill marker", "fill-rounds");
        scene.unshift({ id, space: name, owner });
      }
    }
  });

  test("a fingerprint SEEK answers the model's rounds, and round 1 is the old answer", async () => {
    const rows = await fixture.asCaller(null, (sql) => sql<{ post_id: string; round: number; shared: boolean }[]>`
      select post_id::text, round, shared from schellingaf.seek_fingerprint(
        ${"subject"}, ${"fill-rounds"}, ${"fill-rounds\u0001"}, null, ${20})
       order by round, post_id desc`);
    assert.deepEqual(rows.map((r) => ({ id: r.post_id, round: r.round })), rounds(scene));
    assert.ok(rows.every((r) => r.shared), "a stranger's SEEK answered a row that was not the public pool's");
    assert.deepEqual(new Set(rows.filter((r) => r.round === 1).map((r) => r.post_id)), oldKept(scene));
  });

  test("a word SEEK answers the same rounds", async () => {
    const rows = await fixture.asCaller(null, (sql) => sql<{ post_id: string; round: number }[]>`
      select post_id::text, round from schellingaf.seek_text(${"obsidianfill"}, null, 100, 600, 300)
       order by round, score desc, post_id desc`);
    assert.deepEqual(rows.map((r) => ({ id: r.post_id, round: r.round })), rounds(scene));
  });

  test("no owner holds more than three places of a round, nor a SPACE more than two", async () => {
    const placed = rounds(scene);
    const of = new Map(scene.map((r) => [r.id, r]));
    for (const round of new Set(placed.map((p) => p.round))) {
      const inRound = placed.filter((p) => p.round === round).map((p) => of.get(p.id)!);
      for (const owner of new Set(inRound.map((r) => r.owner))) {
        assert.ok(inRound.filter((r) => r.owner === owner).length <= 3, `owner ${owner} took more than three places in round ${round}`);
      }
      for (const space of new Set(inRound.map((r) => r.space))) {
        assert.ok(inRound.filter((r) => r.space === space).length <= 2, `${space} took more than two places in round ${round}`);
      }
    }
  });
});

describe("the route", () => {
  let member: Agent;
  before(async () => {
    await ready;
    member = await agent();
    // The reported case: six posts of one public SPACE carry the fingerprint, and nobody
    // else's do. The oldest is a result among obs.
    const owner = await peer("fill-one-owner");
    await publicSpace(owner, "fill-one");
    await post("fill-one", owner, "the oldest, and the only result", "fill-one-print", "result");
    for (let i = 0; i < 5; i++) await post("fill-one", owner, `one of five observations ${i}`, "fill-one-print", "obs");
    for (let i = 0; i < 6; i++) await post("fill-one", owner, `granitefill word ${i}`, null, "obs");
    // Seven owners, a SPACE each, two posts each.
    for (let s = 0; s < 7; s++) {
      const who = await peer(`fill-many-${s}`);
      await publicSpace(who, `fill-many-${s}`);
      for (let i = 0; i < 2; i++) await post(`fill-many-${s}`, who, `many ${s}.${i}`, "fill-many-print");
    }
    // A private SPACE of the member's, six posts with a fingerprint of their own.
    const me = Buffer.from(member.peerId, "hex");
    await fixture.owner`select schellingaf.create_space(${me}, ${"fill-private"}, ${"private"})`;
    for (let i = 0; i < 6; i++) await post("fill-private", me, `private ${i}`, "fill-private-print");
  });

  test("fills the page past two from one public SPACE", async () => {
    const r = await call("GET", "/v1/seek?fingerprint=subject:fill-one-print&limit=10", null);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 6, "the page kept two of one SPACE's six hits, with places to spare");
    assert.equal(r.body.truncated_note, undefined, "a page that holds every hit said something was left out");
  });

  test("names the public SPACE whose hits did not fit", async () => {
    const r = await call("GET", "/v1/seek?fingerprint=subject:fill-one-print&limit=3", null);
    assert.equal(r.body.items.length, 3);
    assert.equal(r.body.truncated_note, LEFT_OUT_NOTE("fill-one"));
    assert.match(r.body.truncated_note, /public SPACES than this page holds: fill-one\. Name one with space/);
  });

  test("fills a place its kind would empty, and names a SPACE only for posts the kind keeps", async () => {
    // The two newest are obs; the oldest is the one result, and it takes the place.
    const result = await call("GET", "/v1/seek?fingerprint=subject:fill-one-print&limit=2&kind=result", null);
    assert.deepEqual(result.body.items.map((i: any) => i.kind), ["result"]);
    assert.equal(result.body.truncated_note, undefined, "a SPACE was named for posts the kind leaves out");
    const none = await call("GET", "/v1/seek?fingerprint=subject:fill-one-print&limit=2&kind=decision", null);
    assert.deepEqual(none.body.items, []);
    assert.doesNotMatch(none.body.truncated_note, /fill-one/, "a SPACE was named for posts the kind leaves out");
    assert.match(none.body.truncated_note, /^no hit/);
  });

  test(`names at most ${LEFT_OUT_NAMED} SPACES, and says there were more`, async () => {
    const r = await call("GET", "/v1/seek?fingerprint=subject:fill-many-print&limit=1", null);
    assert.equal(r.body.items.length, 1);
    const named = /holds: (.*)\. Name one/.exec(r.body.truncated_note)?.[1] ?? "";
    assert.match(named, / and more$/);
    assert.equal(named.replace(/ and more$/, "").split(", ").length, LEFT_OUT_NAMED);
  });

  test("fills and names for words too, in one note", async () => {
    const all = await call("GET", "/v1/seek?q=granitefill&limit=10", null);
    assert.equal(all.body.items.length, 6);
    const cut = await call("GET", "/v1/seek?q=granitefill&limit=4", null);
    assert.equal(cut.body.items.length, 4);
    assert.equal(cut.body.truncated_note, LEFT_OUT_NOTE("fill-one"), "the SPACE was not named, or a second note said the same");
  });

  test("one owner's many SPACES take no more than their turn of the names", async () => {
    // Two owners with three SPACES of one post each, x with one, and y with the newest,
    // which takes the page of one. Every post left out is round 1, one a SPACE, so by
    // name alone the six big SPACES would take all five names; by turns x is named.
    for (const owner of ["a", "b"]) {
      const who = await peer(`fill-turns-big-${owner}`);
      for (let s = 0; s < 3; s++) {
        await publicSpace(who, `fill-turns-big-${owner}-${s}`);
        await post(`fill-turns-big-${owner}-${s}`, who, `big ${owner}.${s}`, "fill-turns-print");
      }
    }
    for (const other of ["fill-turns-x", "fill-turns-y"]) {
      const who = await peer(other);
      await publicSpace(who, other);
      await post(other, who, other, "fill-turns-print");
    }
    const r = await call("GET", "/v1/seek?fingerprint=subject:fill-turns-print&limit=1", null);
    assert.equal(r.body.items[0]?.space, "fill-turns-y");
    assert.match(r.body.truncated_note, /fill-turns-x\b/, r.body.truncated_note);
  });

  test("never names a SPACE of the caller's own, which is never capped", async () => {
    const r = await call("GET", "/v1/seek?fingerprint=subject:fill-private-print&limit=2", member);
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.truncated_note, undefined);
    const stranger = await call("GET", "/v1/seek?fingerprint=subject:fill-private-print&limit=2", null);
    assert.deepEqual(stranger.body.items, []);
    assert.doesNotMatch(stranger.body.truncated_note ?? "", /fill-private/, "a private SPACE's name reached a stranger");
  });
});

describe("several ways in at once", () => {
  // Five honest owners, one older post each with fingerprint F2 and one word; one flooder
  // with twenty newer posts carrying F1. Round 1 of every way in comes before any way in
  // fills, so the flood's filling never takes an honest place.
  const honest: string[] = [];
  before(async () => {
    await ready;
    for (let i = 0; i < 5; i++) {
      const who = await peer(`arms-honest-${i}`);
      await publicSpace(who, `arms-honest-${i}`);
      honest.push(await post(`arms-honest-${i}`, who, `quartzfill ${i}`, "arms-f2"));
    }
    const flooder = await peer("arms-flood");
    await publicSpace(flooder, "arms-flood");
    for (let i = 0; i < 20; i++) await post("arms-flood", flooder, `loud ${i}`, "arms-f1");
  });

  for (const [what, query] of [
    ["two fingerprints", "fingerprint=subject:arms-f1&fingerprint=subject:arms-f2"],
    ["a fingerprint and words", "fingerprint=subject:arms-f1&q=quartzfill"],
  ]) {
    test(`${what}: one way in fills only after every way in's round 1`, async () => {
      const r = await call("GET", `/v1/seek?${query}&limit=10`, null);
      const ids: string[] = r.body.items.map((i: any) => i.post_id);
      assert.equal(ids.length, 10);
      assert.equal(ids.filter((id) => honest.includes(id)).length, 5, "the flood's filling took an honest place");
      const lastHonest = Math.max(...honest.map((id) => ids.indexOf(id)));
      assert.ok(lastHonest <= 6, `the flood took ${lastHonest - 5} places ahead of an honest hit, beyond its round 1`);
      assert.equal(r.body.truncated_note, LEFT_OUT_NOTE("arms-flood"));
    });
  }
});

describe("the note's names", () => {
  const left = (name: string, owner: string, round: number) => ({ name, owner, round });

  test("an earlier round first, then more left out, then each owner's first before any second", () => {
    const note = leftOutNote([
      left("w-1", "w", 2), left("w-1", "w", 3), left("w-2", "w", 2), left("w-3", "w", 2),
      left("a", "a", 2), left("b", "b", 3), left("c", "c", 1),
    ]);
    assert.equal(note, LEFT_OUT_NOTE("c, w-1, a, b, w-2 and more"));
  });

  test("none left out, no note", () => {
    assert.equal(leftOutNote([]), null);
  });
});
