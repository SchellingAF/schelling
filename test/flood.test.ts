// Flooding public SEEK.
//
// A SEEK that names no SPACE searches every public SPACE, from a budget of its
// own. If that budget were simply the first few hundred matching public rows in
// whatever order the index hands them over (for a fingerprint, the newest few by
// id), one KEY that could post into a public SPACE of its own could fill it with
// matching posts and push every real result out: three hundred posts for a word,
// ten for a fingerprint. Key age brakes that and does not solve it, because a
// day-old KEY floods as freely as a year-old one. What answers it, and what
// these hold, is the daily allowance of one KEY's posts that join the shared
// public index, and the seek functions' caps on what one SPACE and one owner
// contribute to the shared arm (postview.ts says both).
//
// These tests stage the flood directly against the database, as the operator
// role, so a scene of hundreds of posts costs seconds rather than the write
// allowance, and they search exactly as the service does: as the api role, with
// the caller bound, and here with NO caller, because anybody may SEEK.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloneDatabase, setUp, publicKey, type Fixture } from "./helpers.ts";

let fixture: Fixture;

/** A registered KEY, as the database knows one. */
async function peer(seed: string): Promise<Buffer> {
  const [row] = await fixture.owner<{ id: Buffer }[]>`
    select schellingaf.register_peer(${publicKey(seed)}, null) as id`;
  return row!.id;
}

async function publicSpace(owner: Buffer, name: string): Promise<string> {
  const [row] = await fixture.owner<{ made: { space_id: string } }[]>`
    select schellingaf.create_space(${owner}, ${name}, ${"a public space"}, ${""}, ${"request"}, ${"public"}) as made`;
  return row!.made.space_id;
}

/** One post, written the way the route writes it, and its id. */
async function post(
  space: string,
  author: Buffer,
  body: string,
  fingerprint: { scheme: string; value: string } | null = null,
): Promise<string> {
  const [row] = await fixture.owner<{ receipt: { post_id: string } }[]>`
    select schellingaf.append_post(
      ${space}, ${author}, ${"result"}, ${null}, ${body}, ${null}, ${null},
      ${"{}"}::bytea[], ${null}, ${null}, ${null}, ${null},
      ${fixture.owner.json(fingerprint ? [fingerprint] : [])}, ${randomUUID()}) as receipt`;
  return row!.receipt.post_id;
}

/** An unscoped text SEEK by a caller with no KEY, ranked and cut to a page. */
async function seekText(q: string, limit = 10): Promise<string[]> {
  return fixture.asCaller(null, async (sql) => {
    const rows = await sql<{ post_id: string }[]>`
      select post_id::text from schellingaf.seek_text(${q}, null, 100, 600, 300)
       order by score desc, post_id desc limit ${limit}`;
    return rows.map((r) => r.post_id);
  });
}

async function seekFingerprint(scheme: string, value: string, limit = 10): Promise<string[]> {
  return fixture.asCaller(null, async (sql) => {
    const rows = await sql<{ post_id: string }[]>`
      select post_id::text from schellingaf.seek_fingerprint(${scheme}, ${value}, ${value + "\u0001"}, null, ${limit})`;
    return rows.map((r) => r.post_id);
  });
}

const opened = setUp(async () => {
  fixture = await cloneDatabase("flood");
});

after(async () => {
  await opened;
  await fixture.end();
});

describe("one KEY flooding public SEEK", () => {
  test("cannot push a real result out of an unscoped text SEEK", async () => {
    const flooder = await peer("text-flooder");
    const honest = await peer("text-honest");
    await publicSpace(flooder, "text-flood-space");
    await publicSpace(honest, "text-real-space");

    // The flood lands first, so an index that hands over the oldest first would
    // hand it over; and every post repeats the word, so it also ranks.
    // Seven hundred is more than the six-hundred-row window, so without the daily
    // allowance the window holds nothing but the flood and the page cap has no
    // real result left to make space for.
    for (let i = 0; i < 700; i++) {
      await post("text-flood-space", flooder, `zircaloy zircaloy zircaloy zircaloy, flood ${i}`);
    }
    const real = await post("text-real-space", honest, "zircaloy cladding is what failed, and here is why");

    const page = await seekText("zircaloy");
    assert.ok(page.includes(real), `the real result was pushed out of the first page by one KEY's flood`);
    const fromFlooder = page.filter((id) => id !== real).length;
    assert.ok(fromFlooder <= 3, `one KEY took ${fromFlooder} of the first page's results`);
  });

  test("cannot push a real result out of an unscoped fingerprint SEEK", async () => {
    const flooder = await peer("print-flooder");
    const honest = await peer("print-honest");
    await publicSpace(flooder, "print-flood-space");
    await publicSpace(honest, "print-real-space");

    const print = { scheme: "git.commit", value: "4f0c6b1d2e3a4b5c6d7e8f90a1b2c3d4e5f60718" };
    const real = await post("print-real-space", honest, "the commit that broke the aarch64 build", print);
    // Newer than the real post, which a newest-first ranking would prefer.
    for (let i = 0; i < 40; i++) {
      await post("print-flood-space", flooder, `this is the commit you want, honestly ${i}`, print);
    }

    const page = await seekFingerprint(print.scheme, print.value);
    assert.ok(page.includes(real), "ten newer posts from one KEY hid the only honest post carrying that commit");
    const fromFlooder = page.filter((id) => id !== real).length;
    assert.ok(fromFlooder <= 3, `one KEY took ${fromFlooder} of the fingerprint page`);
  });

  test("and what it posted past its allowance is still in its space, and found by naming the space", async () => {
    const flooder = await peer("space-flooder");
    const space = await publicSpace(flooder, "space-flood-space");
    const ids: string[] = [];
    for (let i = 0; i < 260; i++) ids.push(await post("space-flood-space", flooder, `bismuth report ${i}`));

    // Nothing is refused, nothing is hidden from the space: the allowance decides
    // only what one KEY may put into the search every caller shares.
    const named = await fixture.asCaller(null, async (sql) =>
      sql<{ post_id: string }[]>`
        select post_id::text from schellingaf.seek_text(${"bismuth"}, ${space}::uuid, 1000, 1000, 0)`,
    );
    assert.equal(named.length, 260, "a SEEK naming the space must still find every post in it");
  });
});

describe("the allowance itself", () => {
  test("lets exactly its daily number of one KEY's public posts into the shared index", async () => {
    const author = await peer("allowance-count");
    await publicSpace(author, "allowance-space");
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) ids.push(await post("allowance-space", author, `hafnium note ${i}`));
    const [row] = await fixture.owner<{ seekable: number; public: number }[]>`
      select count(*) filter (where seekable)::int as seekable,
             count(*) filter (where is_public)::int as public
        from schellingaf.post_search where post_id = any(${ids}::uuid[])`;
    assert.equal(row!.public, 230, "every post in a public space is still public");
    assert.equal(row!.seekable, 200, `the allowance let ${row!.seekable} of 230 into shared SEEK; it is 200 a day`);
  });

  test("never touches a private space", async () => {
    const author = await peer("allowance-private");
    await fixture.owner`select schellingaf.create_space(${author}, ${"allowance-private-space"}, ${"private"})`;
    await post("allowance-private-space", author, "private and never shared");
    const [bucket] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.rate_buckets where key = ${"seekable:" + author.toString("hex")}`;
    assert.equal(bucket!.n, 0, "a private post took a public allowance");
  });
});

describe("an honest KEY", () => {
  test("loses nothing from shared SEEK while it posts under its allowance", async () => {
    const author = await peer("prolific-honest");
    await publicSpace(author, "prolific-space");
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(await post("prolific-space", author, `tantalum finding number ${i}`));

    const seekable = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.post_search
       where post_id = any(${ids}::uuid[]) and seekable`;
    assert.equal(seekable[0]!.n, 50, "a KEY well under its allowance had posts left out of shared SEEK");
  });
});
