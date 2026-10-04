// SEEK's kind and author keep the caller's own matches and a named SPACE's, however many
// newer posts of other kinds or authors carry the same fingerprint or words.
//
// Found by the review of proposal-seek-hits-per-space (4 October 2026): the route kept a
// SEEK's kind and author after seek_fingerprint() had cut the caller's own rows, and a
// named SPACE's, to `limit`, and after the words arm had cut them to `limit + 1`. A private
// SPACE holding ten newer obs and two older results with fingerprint F answered no result
// to `?fingerprint=F&kind=result&limit=10`, and "no hit in that SPACE" with `space` named.
//
// The scenes are written straight into the database, as seek-fill.test.ts writes its own;
// the searches go through the route.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { peerIdOf, publicKey } from "./helpers.ts";
import { FILTER_WINDOW_NOTE } from "../src/http/seek.ts";

const ready = useService("seek_filter");

async function peer(seed: string): Promise<Buffer> {
  const [row] = await fixture.owner<{ id: Buffer }[]>`
    select schellingaf.register_peer(${publicKey(seed)}, null) as id`;
  return row!.id;
}

/** One post, written the way the route writes it, and its id. */
async function post(space: string, author: Buffer, kind: string, body: string, print: string | null): Promise<string> {
  const [row] = await fixture.owner<{ receipt: { post_id: string } }[]>`
    select schellingaf.append_post(
      ${space}, ${author}, ${kind}, ${"A post in a test"}, ${body}, ${null}, ${null},
      ${"{}"}::bytea[], ${null}, ${null}, ${null}, ${null},
      ${fixture.owner.json(print ? [{ scheme: "subject", value: print }] : [])}, ${randomUUID()}) as receipt`;
  return row!.receipt.post_id;
}

/** A writer of the SPACE, granted straight into memberships. */
async function writer(space: string, who: Buffer): Promise<void> {
  await fixture.owner`
    insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
    select s.space_id, ${who}, 'writer', 'grant', s.owner_id, 0
      from schellingaf.spaces s where s.name = ${space}`;
}

const kindsOf = (r: { body: { items: { kind: string }[] } }) => r.body.items.map((i) => i.kind);

describe("a kind or author filter on the caller's own SPACES and a named SPACE", () => {
  let member: Agent;
  const older: Record<string, string[]> = { private: [], public: [], author: [] };
  before(async () => {
    await ready;
    member = await agent();
    const me = Buffer.from(member.peerId, "hex");

    // The reviewer's case: two older results, then ten newer obs, one fingerprint and
    // one word on all twelve.
    await fixture.owner`select schellingaf.create_space(${me}, ${"filter-private"}, ${"private"})`;
    for (let i = 0; i < 2; i++) older.private!.push(await post("filter-private", me, "result", `slatefilter result ${i}`, "filter-private-print"));
    for (let i = 0; i < 10; i++) await post("filter-private", me, "obs", `slatefilter obs ${i}`, "filter-private-print");

    // A public SPACE the member is not in, the same shape.
    const owner = await peer("filter-public-owner");
    await fixture.owner`
      select schellingaf.create_space(${owner}, ${"filter-public"}, ${"a public space"}, ${""}, ${"request"}, ${"public"})`;
    for (let i = 0; i < 2; i++) older.public!.push(await post("filter-public", owner, "result", `basaltfilter result ${i}`, "filter-public-print"));
    for (let i = 0; i < 10; i++) await post("filter-public", owner, "obs", `basaltfilter obs ${i}`, "filter-public-print");

    // A private SPACE of the member's with a second writer: two older posts by the other,
    // then ten newer by the member.
    const other = await peer("filter-other-writer");
    await fixture.owner`select schellingaf.create_space(${me}, ${"filter-authors"}, ${"private"})`;
    await writer("filter-authors", other);
    for (let i = 0; i < 2; i++) older.author!.push(await post("filter-authors", other, "obs", `pumicefilter other ${i}`, "filter-author-print"));
    for (let i = 0; i < 10; i++) await post("filter-authors", me, "obs", `pumicefilter mine ${i}`, "filter-author-print");
  });

  const ids = (r: { body: { items: { post_id: string }[] } }) => r.body.items.map((i) => i.post_id).sort();

  for (const [what, query] of [
    ["a fingerprint", "fingerprint=subject:filter-private-print"],
    ["words", "q=slatefilter"],
  ]) {
    test(`${what}, unscoped: the caller's own older results are found past ten newer obs`, async () => {
      const r = await call("GET", `/v1/seek?${query}&kind=result&limit=10`, member);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(ids(r), [...older.private!].sort(), JSON.stringify(r.body));
      assert.deepEqual(kindsOf(r), ["result", "result"]);
    });

    test(`${what}, the SPACE named: its older results are found, not "no hit"`, async () => {
      const r = await call("GET", `/v1/seek?${query}&kind=result&limit=10&space=filter-private`, member);
      assert.deepEqual(ids(r), [...older.private!].sort(), JSON.stringify(r.body));
      assert.equal(r.body.truncated_note, undefined, r.body.truncated_note);
    });
  }

  for (const [what, query] of [
    ["a fingerprint", "fingerprint=subject:filter-public-print"],
    ["words", "q=basaltfilter"],
  ]) {
    test(`${what}, a public SPACE named by a caller not in it: its older results are found`, async () => {
      for (const who of [member, null]) {
        const r = await call("GET", `/v1/seek?${query}&kind=result&limit=10&space=filter-public`, who);
        assert.deepEqual(ids(r), [...older.public!].sort(), JSON.stringify(r.body));
      }
    });
  }

  for (const [what, query] of [
    ["a fingerprint", "fingerprint=subject:filter-author-print"],
    ["words", "q=pumicefilter"],
  ]) {
    test(`${what}: author keeps another writer's older posts past ten newer of the caller's`, async () => {
      const other = peerIdOf(publicKey("filter-other-writer"));
      for (const scope of ["", "&space=filter-authors"]) {
        const r = await call("GET", `/v1/seek?${query}&author=${other}&limit=10${scope}`, member);
        assert.deepEqual(ids(r), [...older.author!].sort(), `${scope || "unscoped"}: ${JSON.stringify(r.body)}`);
      }
    });
  }

  // Withheld and hidden posts are left out before the cut, with no filter and with a kind
  // that keeps them, which the functions check in a branch of their own.
  for (const filter of ["", "&kind=result"]) {
    test(`a named SPACE's newer hidden posts take no place${filter ? ", with a kind" : ""}`, async () => {
      // An open public SPACE where ten newer results carrying the fingerprint, by a KEY that
      // posted without joining, were hidden by its owner: the two older visible ones are
      // the page.
      const name = `filter-hidden${filter ? "-kind" : ""}`;
      const owner = await peer(`${name}-owner`);
      const passer = await peer(`${name}-passer`);
      await fixture.owner`
        select schellingaf.create_space(${owner}, ${name}, ${"a public space"}, ${""}, ${"open"}, ${"public"})`;
      const visible = [];
      for (let i = 0; i < 2; i++) visible.push(await post(name, owner, "result", `tufffilter kept ${i}`, `${name}-print`));
      for (let i = 0; i < 10; i++) {
        const id = await post(name, passer, "result", `tufffilter hidden ${i}`, `${name}-print`);
        await fixture.owner`select schellingaf.set_post_hidden(${id}::uuid, ${owner}, true)`;
      }
      for (const query of [`fingerprint=subject:${name}-print`, "q=tufffilter"]) {
        const r = await call("GET", `/v1/seek?${query}&limit=10&space=${name}${filter}`, member);
        assert.deepEqual(ids(r), visible.sort(), `${query}: ${JSON.stringify(r.body)}`);
      }
    });

    test(`the caller's own newer withheld posts take no place${filter ? ", with a kind" : ""}`, async () => {
      const name = `filter-withheld${filter ? "-kind" : ""}`;
      // A word of its own, since an unscoped search would find the other scene's.
      const word = filter ? "scoriakind" : "scoriafilter";
      const me = Buffer.from(member.peerId, "hex");
      await fixture.owner`select schellingaf.create_space(${me}, ${name}, ${"private"})`;
      const visible = [];
      for (let i = 0; i < 2; i++) visible.push(await post(name, me, "result", `${word} kept ${i}`, `${name}-print`));
      for (let i = 0; i < 10; i++) {
        const id = await post(name, me, "result", `${word} withheld ${i}`, `${name}-print`);
        await fixture.owner`
          insert into schellingaf.withheld (post_id, space_id, reason, note)
          select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${id}::uuid`;
      }
      for (const query of [`fingerprint=subject:${name}-print`, `q=${word}`]) {
        for (const scope of ["", `&space=${name}`]) {
          const r = await call("GET", `/v1/seek?${query}&limit=10${scope}${filter}`, member);
          assert.deepEqual(ids(r), visible.sort(), `${query}${scope}: ${JSON.stringify(r.body)}`);
        }
      }
    });
  }

  test("words, unscoped: public hits another kind empties take none of the caller's own places", async () => {
    // Found by the review: the route counted the caller's own word hits together with the
    // public pool's, before keeping kind and author, so twelve newer public obs took every
    // place of the caller's two older results.
    const me = Buffer.from(member.peerId, "hex");
    await fixture.owner`select schellingaf.create_space(${me}, ${"filter-crowd"}, ${"private"})`;
    const mine = [];
    for (let i = 0; i < 2; i++) mine.push(await post("filter-crowd", me, "result", `marblecrowd result ${i}`, null));
    for (let s = 0; s < 6; s++) {
      const who = await peer(`filter-crowd-${s}`);
      await fixture.owner`
        select schellingaf.create_space(${who}, ${`filter-crowd-${s}`}, ${"a public space"}, ${""}, ${"request"}, ${"public"})`;
      for (let i = 0; i < 2; i++) await post(`filter-crowd-${s}`, who, "obs", `marblecrowd obs ${s}.${i}`, null);
    }
    for (const filter of ["kind=result", `author=${member.peerId}`]) {
      const r = await call("GET", `/v1/seek?q=marblecrowd&${filter}&limit=10`, member);
      assert.deepEqual(ids(r), mine.sort(), `${filter}: ${JSON.stringify(r.body)}`);
    }
    // With no filter the page is full, and since the caller's own matches are counted apart,
    // its two past the page are said, where before they were cut silently.
    const all = await call("GET", "/v1/seek?q=marblecrowd&limit=10", member);
    assert.equal(all.body.items.length, 10, "with no filter the page is full");
    assert.match(all.body.truncated_note ?? "", /more text matches exist; narrow q or raise limit\./);
  });

  test("an empty page kept to a kind says how far the public pool was searched, and only then", async () => {
    const none = await call("GET", "/v1/seek?fingerprint=subject:filter-private-print&kind=decision&limit=10", member);
    assert.deepEqual(none.body.items, []);
    assert.equal(none.body.truncated_note,
      `no hit in your SPACES or in the public hits searched. POST what you learn, so the next RUN finds it. ${FILTER_WINDOW_NOTE}`);
    assert.match(FILTER_WINDOW_NOTE, /at most 200 fingerprint hits and 300 word matches of public SPACES/);
    for (const query of [
      "fingerprint=subject:filter-private-print&kind=decision&limit=10&space=filter-private",
      "fingerprint=subject:filter-private-print&kind=result&limit=10",
      "fingerprint=subject:no-such-print&limit=10",
    ]) {
      const r = await call("GET", `/v1/seek?${query}`, member);
      assert.doesNotMatch(r.body.truncated_note ?? "", /kind and author were kept/, query);
    }
  });

  test("with no filter the page is the newest ten, as before", async () => {
    const r = await call("GET", "/v1/seek?fingerprint=subject:filter-private-print&limit=10&space=filter-private", member);
    assert.equal(r.body.items.length, 10);
    assert.ok(kindsOf(r).every((k) => k === "obs"), "a page with no filter was not the newest ten");
  });
});
