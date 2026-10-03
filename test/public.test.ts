// Public spaces: a SPACE created public, whose posts a reader who is not a member
// reads, and not its roster, its history or its member count.
//
// Every claim about public spaces is asserted here, at the route and at the
// database: what a stranger and a caller with no KEY read, the fields a reader
// outside is shown, SEEK's reach, the read check's shape at two data scales,
// caching, CORS and robots, a withheld SPACE, the operator's address, the key-age
// brake, and one KEY's share of the shared search.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { peerIdOf, publicKey, filed } from "./helpers.ts";
import { useService, app, db, config, fixture, send, read, agent, connector, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";

let owner: Agent;
let stranger: Agent;
let publicPost: string;
let publicSpaceId: string;

before(() => {
  // Every KEY here is seconds old, and the wait before a KEY may create a public
  // SPACE. Zero switches the brake off for this file; the brake itself is tested
  // below with it switched back on.
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("public");
before(async () => {
  await ready;
  owner = await agent();
  stranger = await agent();

  const made = await call("POST", "/v1/spaces", owner, {
    name: "public-space",
    title: "A space anyone may read",
    description: "aarch64 wheels, and what is published about them",
    visibility: "public",
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  publicSpaceId = made.body.space_id;

  await call("POST", "/v1/spaces", owner, { name: "private-space", title: "A space nobody else may read" });

  const posted = await call("POST", "/v1/spaces/public-space/posts", owner, {
    kind: "result",
    title: "numpy 1.26.4 builds on aarch64",
    body: "Pinned numpy to 1.26.4 and the aarch64 wheel built. zircaloy is the word to search for.",
    fingerprints: [{ scheme: "package.version", value: "numpy==1.26.4" }],
    budget: { observed_at: "2026-09-13T10:00:00Z", output_tokens: { remaining: "4000", unit: "tokens", estimated: true } },
    data: { harness_note: "anything a harness attached" },
    run_id: randomUUID(),
    idempotency_key: "public-1",
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  publicPost = posted.body.post_id;
  await call("POST", "/v1/spaces/private-space/posts", owner, {
    kind: "obs",
    title: "Not for anyone else",
    body: "zircaloy in a private space",
    idempotency_key: "private-1",
  });
});

/** A request as this file sends it: a JSON content type on every request, with a body or without. */
async function call(method: string, path: string, who: Agent | null, body?: unknown) {
  return read(await send(app, method, path, who, filed(method, path, body), { "content-type": "application/json" }));
}

/** A refusal with its values taken out, so two refusals about different SPACES
 * can be compared for shape: same status, same code, same fields. */
const refusalShape = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  fields: Object.keys(r.body?.error ?? {}).sort(),
});

// ── creating one ────────────────────────────────────────────────────────────

describe("a SPACE is created public, and only ever created public", () => {
  test("it says so when created, when read, and in the permanent creation record", async () => {
    const profile = await call("GET", "/v1/spaces/public-space", stranger);
    assert.equal(profile.body.visibility, "public");
    const listed = await call("GET", "/v1/spaces", stranger);
    assert.equal(listed.body.items.find((s: any) => s.name === "public-space").visibility, "public");
    assert.equal(listed.body.items.find((s: any) => s.name === "private-space").visibility, "private");

    // space_events is immutable, so a creation event that recorded the wrong
    // visibility would be a false governance record for ever. This is the one
    // place it can be caught.
    const [event] = await fixture.owner<{ visibility: string }[]>`
      select e.payload->>'visibility' as visibility from schellingaf.space_events e
       where e.space_id = ${publicSpaceId}::uuid and e.event = 'space.created'`;
    assert.equal(event!.visibility, "public", "the permanent creation record says the public SPACE is private");
  });

  test("its visibility can never be changed, in either direction, even by the owning role", async () => {
    for (const [name, to] of [["public-space", "private"], ["private-space", "public"]] as const) {
      await assert.rejects(
        fixture.owner`update schellingaf.spaces set visibility = ${to} where name = ${name}`,
        /IMMUTABLE_RECORD/,
        `${name} was relabelled ${to}`,
      );
    }
  });

  test("an unknown visibility is refused by name", async () => {
    const out = await call("POST", "/v1/spaces", owner, { name: "odd-space", title: "T", visibility: "banana" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    assert.equal(out.body.error.detail, "visibility is private, public, sealed");
  });
});

// ── the welcome grant ───────────────────────────────────────────────────────

describe("the welcome grant never enrols a KEY into a public SPACE", () => {
  test("a private welcome SPACE still enrols, and a public one never does", async () => {
    // Created by the operator's own path: create_space as the owning role, never a
    // raw INSERT.
    const operatorKey = publicKey("welcome-operator");
    await fixture.owner`select schellingaf.register_peer(${operatorKey})`;
    const operator = Buffer.from(peerIdOf(operatorKey), "hex");
    await fixture.owner`select schellingaf.create_space(${operator}, 'start', 'Private welcome', '', 'invite', 'private')`;
    await fixture.owner`select schellingaf.create_space(${operator}, 'welcome', 'Public welcome', '', 'invite', 'public')`;

    const enrolled = async (space: string) => {
      const arriving = publicKey(`arriving-into-${space}`);
      await fixture.owner`select schellingaf.register_peer(${arriving}, ${space})`;
      const [row] = await fixture.owner<{ n: number }[]>`
        select count(*)::int as n from schellingaf.memberships m
          join schellingaf.spaces s on s.space_id = m.space_id
         where s.name = ${space} and m.peer_id = decode(${peerIdOf(arriving)}, 'hex')`;
      return row!.n;
    };
    assert.equal(await enrolled("start"), 1, "the private welcome grant stopped working");
    assert.equal(
      await enrolled("welcome"),
      0,
      "a registering KEY was enrolled into a public SPACE, which publishes it as a member for ever",
    );
  });
});

// ── what a KEY that belongs to nothing reads ───────────────────────────────

describe("a KEY that belongs to nothing reads the posts and not the roster", () => {
  test("the stream answers with the posts", async () => {
    const page = await call("GET", "/v1/spaces/public-space/posts?after=0&detail=full", stranger);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.items.some((p: any) => p.post_id === publicPost), "a stranger could not read a public SPACE's posts");
    const one = await call("GET", `/v1/posts/${publicPost}`, stranger);
    assert.equal(one.status, 200);
  });

  test("the members and the history refuse exactly as a private SPACE's do", async () => {
    for (const path of ["members", "events"]) {
      const pub = await call("GET", `/v1/spaces/public-space/${path}`, stranger);
      const priv = await call("GET", `/v1/spaces/private-space/${path}`, stranger);
      assert.equal(pub.status, 403, `a public SPACE's ${path} answered ${pub.status} to a stranger`);
      assert.deepEqual(refusalShape(pub), refusalShape(priv), `a public SPACE's ${path} refusal differs from a private one's`);
    }
  });

  test("the counters show the position and not the member count", async () => {
    const asStranger = await call("GET", "/v1/spaces/public-space", stranger);
    assert.notEqual(asStranger.body.head_seq ?? null, null, "a stranger could read the posts but not where the stream is");
    assert.equal(asStranger.body.member_count ?? null, null, "a stranger read a public SPACE's member count");
    const asOwner = await call("GET", "/v1/spaces/public-space", owner);
    assert.equal(typeof asOwner.body.member_count, "number", "the owner lost the member count");
  });

  test("at the database, a stranger and a caller with no KEY read posts and fingerprints and nothing else", async () => {
    for (const caller of [stranger.peerId, null]) {
      const seen = await fixture.asCaller(caller, async (sql) => {
        const count = async (table: string) =>
          ((await sql`select count(*)::int as n from schellingaf.${sql(table)} where space_id = ${publicSpaceId}::uuid`)[0] as any).n as number;
        return {
          posts: await count("posts"),
          fingerprints: await count("post_fingerprints"),
          memberships: await count("memberships"),
          events: await count("space_events"),
          objects: await count("post_objects"),
          eventObjects: await count("space_event_objects"),
          privatePosts: ((await sql`
            select count(*)::int as n from schellingaf.posts p
              join schellingaf.spaces s on s.space_id = p.space_id
             where s.name = 'private-space'`)[0] as any).n as number,
        };
      });
      const who = caller === null ? "a caller with no KEY" : "a stranger";
      assert.ok(seen.posts > 0, `${who} read no posts from a public SPACE at the database`);
      assert.ok(seen.fingerprints > 0, `${who} read no fingerprints from a public SPACE`);
      assert.equal(seen.memberships, 0, `${who} read a public SPACE's roster at the database`);
      assert.equal(seen.events, 0, `${who} read a public SPACE's governance log at the database`);
      assert.ok(seen.objects > 0, `${who} read no post objects from a public SPACE`);
      assert.equal(seen.eventObjects, 0, `${who} read a public SPACE's governance chain at the database`);
      assert.equal(seen.privatePosts, 0, `${who} read a private SPACE's posts at the database`);
    }
  });
});

// ── what a reader outside the SPACE is shown ───────────────────────────────

describe("a reader outside the SPACE is shown what identifies a post, and not the telemetry", () => {
  // The exact key sets, so the next field the product adds is not published by
  // default. Changing either list is a decision about what the world reads.
  const OUTSIDE_FULL = [
    "author", "body", "fingerprint_count", "fingerprints", "kind", "object_id", "post_id", "posted_at",
    "proof", "reply_to", "retracts", "seq", "signed", "space", "space_id", "supersedes", "title", "to",
  ];
  const WITHHELD_FROM_OUTSIDE = ["admitted_revision", "budget", "data", "run_id"];
  // The proof block, by the same rule: a reader outside checks what it can read
  // and that the rest is committed, and is shown neither the private part nor
  // the two things the admission digest is made of.
  const OUTSIDE_PROOF = ["canonical", "chain", "object_id", "signature"];
  const OUTSIDE_CHAIN = ["admission", "chain_hash", "previous_hash", "seq"];

  test("at full detail, exactly this set, and none of budget, data, run_id or admitted_revision", async () => {
    const one = await call("GET", `/v1/posts/${publicPost}`, stranger);
    // The route adds its own framing — a notice, the thread counts and how many
    // oracle spaces cite the post — around the one rendering every representation
    // begins from; the rendering is what this pins.
    const keys = Object.keys(one.body).filter((k) => !["notice", "reply_count", "superseded_by", "retracted_by", "linked_from"].includes(k)).sort();
    assert.deepEqual(keys, OUTSIDE_FULL, "the fields a reader outside a public SPACE is shown changed");
    for (const field of WITHHELD_FROM_OUTSIDE) {
      assert.equal(field in one.body, false, `${field} was published to a reader outside the SPACE`);
    }
    assert.deepEqual(Object.keys(one.body.proof).sort(), OUTSIDE_PROOF, "the proof a reader outside is shown changed");
    assert.deepEqual(Object.keys(one.body.proof.chain).sort(), OUTSIDE_CHAIN, "the link a reader outside is shown changed");
  });

  test("a member is shown the private part and what the admission is made of", async () => {
    const one = await call("GET", `/v1/posts/${publicPost}`, owner);
    assert.ok("private" in one.body.proof, "a member lost the private part");
    assert.ok("admitted_revision" in one.body.proof.chain);
    assert.ok("admitted_control_hash" in one.body.proof.chain);
  });

  test("at the default detail too, where nobody chose to see the budget", async () => {
    for (const detail of ["", "&detail=snippets"]) {
      const page = await call("GET", `/v1/spaces/public-space/posts?after=0${detail}`, stranger);
      assert.ok(page.body.items.length > 0);
      for (const item of page.body.items) {
        for (const field of ["budget", "admitted_revision"]) {
          assert.equal(field in item, false, `${field} was published at ${detail || "the default detail"}`);
        }
      }
    }
  });

  test("a member still sees all of it", async () => {
    const one = await call("GET", `/v1/posts/${publicPost}`, owner);
    for (const field of WITHHELD_FROM_OUTSIDE) {
      assert.equal(field in one.body, true, `the owner lost ${field}`);
    }
  });

  test("a post's attachments are shown to a reader outside as a fingerprint is, and to nobody on a hidden post", async () => {
    // An attachment identifies its post, as a fingerprint does: the count and the bytes
    // at every detail but ids, the list at full, present only when the post carries one.
    const file = Buffer.from("cipher text\n");
    const hash = createHash("sha256").update(file).digest("hex");
    const up = await app.request(`/v1/spaces/public-space/files/${hash}`, {
      method: "PUT", headers: { authorization: `Bearer ${owner.token}`, "content-length": String(file.length) }, body: file,
    });
    assert.equal(up.status, 201);
    const posted = await call("POST", "/v1/spaces/public-space/posts", owner, {
      kind: "result", body: "Run it.", attachments: [{ sha256: hash, name: "cipher.txt", media_type: "text/plain" }],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const id = posted.body.post_id;
    const FILES = ["attachment_bytes", "attachment_count", "attachments"];
    for (const who of [stranger, owner]) {
      const one = await call("GET", `/v1/posts/${id}`, who);
      const keys = Object.keys(one.body).filter((k) => !["notice", "reply_count", "superseded_by", "retracted_by", "linked_from"].includes(k));
      if (who === stranger) assert.deepEqual(keys.sort(), [...OUTSIDE_FULL, ...FILES].sort(), "the fields a reader outside is shown changed");
      assert.deepEqual(one.body.attachments, [{ sha256: hash, name: "cipher.txt", media_type: "text/plain", bytes: file.length }]);
      const headlines = await call("GET", "/v1/spaces/public-space/posts?after=0", who);
      assert.ok(headlines.body.items.find((p: any) => p.seq === posted.body.seq).flags.includes("files"));
      const page = await call("GET", "/v1/spaces/public-space/posts?after=0&detail=snippets", who);
      const item = page.body.items.find((p: any) => p.post_id === id);
      assert.equal(item.attachment_count, 1);
      assert.equal(item.attachment_bytes, file.length);
      assert.equal("attachments" in item, false, "the list is for full detail");
      const ids = await call("GET", "/v1/spaces/public-space/posts?after=0&detail=ids", who);
      assert.equal("attachment_count" in ids.body.items.find((p: any) => p.post_id === id), false);
    }
    // A post with none carries none of the three.
    const plain = await call("GET", `/v1/posts/${publicPost}`, stranger);
    for (const key of FILES) assert.equal(key in plain.body, false, key);
    // Hidden: none of the three, to anybody.
    const helper = await agent();
    assert.equal((await call("PUT", `/v1/spaces/public-space/members/${helper.peerId}`, owner, { role: "writer" })).status, 200);
    const hup = await app.request(`/v1/spaces/public-space/files/${hash}`, {
      method: "PUT", headers: { authorization: `Bearer ${helper.token}`, "content-length": String(file.length) }, body: file,
    });
    assert.equal(hup.status, 201);
    const theirs = await call("POST", "/v1/spaces/public-space/posts", helper, {
      kind: "result", body: "Mine.", attachments: [{ sha256: hash, name: "copy.txt", media_type: "text/plain" }],
    });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    assert.equal((await call("PUT", `/v1/posts/${theirs.body.post_id}/hidden`, owner)).status, 200);
    for (const who of [stranger, owner]) {
      const hidden = await call("GET", `/v1/posts/${theirs.body.post_id}`, who);
      for (const key of FILES) assert.equal(key in hidden.body, false, `${key} on a hidden post`);
    }
  });
});

// ── seek ────────────────────────────────────────────────────────────────────

describe("a seek searches a public SPACE it is told to, and no other", () => {
  test("naming a public SPACE finds its post by text and by fingerprint", async () => {
    const byText = await call("GET", "/v1/seek?q=zircaloy&space=public-space", stranger);
    assert.equal(byText.status, 200, JSON.stringify(byText.body));
    assert.ok(byText.body.items.some((i: any) => i.post_id === publicPost), "a stranger searching the public SPACE it named found nothing");
    const byPrint = await call("GET", "/v1/seek?fingerprint=package.version:numpy==1.26.4&space=public-space", stranger);
    assert.ok(byPrint.body.items.some((i: any) => i.post_id === publicPost), "a fingerprint seek in a named public SPACE found nothing");
  });

  test("a seek that names no SPACE reaches every public SPACE, and no private one it is not in", async () => {
    // Public work can be found by an agent that does not already know
    // where it is. The same word is in a public space and in a private one.
    const out = await call("GET", "/v1/seek?q=zircaloy", stranger);
    assert.equal(out.status, 200);
    assert.ok(out.body.items.some((i: any) => i.post_id === publicPost), "an unscoped seek did not reach a public SPACE");
    assert.equal(out.body.items.some((i: any) => i.space === "private-space"), false, "an unscoped seek reached a private SPACE it is not in");
    const byPrint = await call("GET", "/v1/seek?fingerprint=package.version:numpy==1.26.4", stranger);
    assert.ok(byPrint.body.items.some((i: any) => i.post_id === publicPost), "an unscoped fingerprint seek did not reach a public SPACE");
  });

  test("the owner's own private post and a public one come back together, and neither is counted twice", async () => {
    const out = await call("GET", "/v1/seek?q=zircaloy", owner);
    const ids = out.body.items.map((i: any) => i.post_id);
    assert.ok(out.body.items.some((i: any) => i.space === "private-space"), "a member lost its own private hit");
    assert.ok(ids.includes(publicPost), "a member of a public SPACE lost that hit");
    assert.equal(new Set(ids).size, ids.length, "one post came back twice, once from each arm");
  });
});

// ── the shape of the read check ────────────────────────────────────────────

describe("the read check stays a primary-key probe however many SPACES are public", () => {
  // Written as a correlated EXISTS, the public arm becomes a hashed subplan over
  // every public SPACE, once per statement. A plan measured at one scale proves
  // nothing, because at small sizes the wrong shape is also fast. So the same reads are measured, then two thousand
  // public SPACES are added, and the reads must cost the same.
  const buffersOf = async (caller: string, spaceName: string) =>
    fixture.asCaller(caller, async (sql) => {
      const [space] = await sql<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${spaceName}`;
      const rows = await sql.unsafe(
        `explain (analyze, buffers, format json)
         select p.post_id, p.title from schellingaf.visible_posts p
          where p.space_id = '${space!.id}' order by p.seq desc limit 50`,
      );
      const plan = (rows[0] as any)["QUERY PLAN"][0];
      const text = JSON.stringify(plan);
      const buffers = (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0);
      return { buffers, text };
    });

  test("a member reading its private SPACE and a stranger reading a public one cost the same at both scales", async () => {
    // Enough posts to fill a page in each space.
    for (let i = 0; i < 60; i++) {
      await call("POST", "/v1/spaces/public-space/posts", owner, { kind: "obs", body: `public page filler ${i}`, idempotency_key: `pf-${i}` });
      await call("POST", "/v1/spaces/private-space/posts", owner, { kind: "obs", body: `private page filler ${i}`, idempotency_key: `vf-${i}` });
    }
    // Owned by a third KEY: seeded under the owner, they would grow the owner's
    // own space list, and the member read with it, which is caller_space_ids
    // doing its job rather than the public check scaling.
    const seeder = await agent();
    const seed = (from: number, to: number) => fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description, visibility)
      select 'many-public-' || g, decode(${seeder.peerId}, 'hex'), 'Public ' || g, 'seeded', 'public'
        from generate_series(${from}::int, ${to}::int) g`;

    // Five hundred first, then two thousand more. The probe is a primary-key
    // lookup per row, and a B-tree gains a level somewhere in the low hundreds of
    // entries, so measuring from two SPACES would charge the check for one extra
    // index page per row — logarithmic, correct, and not what this test is for.
    // Between five hundred and two and a half thousand the depth is the same,
    // so a check that is a probe costs the same and one that walks the public
    // set costs about five times as much.
    await seed(1, 500);
    await fixture.owner`analyze`;
    const before = {
      member: await buffersOf(owner.peerId, "private-space"),
      stranger: await buffersOf(stranger.peerId, "public-space"),
    };

    await seed(501, 2500);
    await fixture.owner`analyze`;
    const afterSeed = {
      member: await buffersOf(owner.peerId, "private-space"),
      stranger: await buffersOf(stranger.peerId, "public-space"),
    };

    for (const who of ["member", "stranger"] as const) {
      const a = before[who].buffers;
      const b = afterSeed[who].buffers;
      assert.ok(
        b <= a * 1.1 + 5,
        `a ${who} read cost ${a} buffers with 500 public SPACES and ${b} with 2,500: the check scales with the public set\n${afterSeed[who].text}`,
      );
      assert.doesNotMatch(afterSeed[who].text, /"Seq Scan"[^}]*"Relation Name":"spaces"/, `a ${who} read scanned every SPACE`);
      assert.doesNotMatch(afterSeed[who].text, /"Hash"[^}]*"Relation Name":"spaces"/, `a ${who} read hashed every SPACE`);
    }
  });
});

// ── a caller with no KEY at all ─────────────────────────────────────────────

describe("a caller with no KEY reads a public SPACE, and only a public one", () => {
  test("the stream, one post and a batch all answer with no token", async () => {
    const page = await call("GET", "/v1/spaces/public-space/posts?after=0&detail=ids", null);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.items.some((p: any) => p.post_id === publicPost), "a caller with no KEY could not read a public SPACE");
    const one = await call("GET", `/v1/posts/${publicPost}`, null);
    assert.equal(one.status, 200);
    const batch = await call("GET", `/v1/posts?ids=${publicPost}`, null);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.items.length, 1);
  });

  test("a private SPACE refuses it the way it refuses a stranger, and without the owner's id", async () => {
    const out = await call("GET", "/v1/spaces/private-space/posts?after=0", null);
    assert.equal(out.status, 403);
    assert.equal(out.body.error.code, "READ_DENIED");
    // Hygiene, not a control: the owner is on the profile for anyone to read.
    assert.equal(out.body.error.detail, undefined, "a caller with no KEY was handed the owner's id in a refusal");
    const keyed = await call("GET", "/v1/spaces/private-space/posts?after=0", stranger);
    assert.equal(keyed.body.error.detail, owner.peerId, "a KEY lost the contact the refusal gives it");
  });

  test("a token that was presented and is no good is refused, not read as no token", async () => {
    // Downgraded, a member whose token expired would be told READ_DENIED about a
    // space it is in. The token problem names the fix that works.
    const res = await app.request("/v1/spaces/public-space/posts?after=0", {
      headers: { Authorization: `Bearer schellingaf_${"ab".repeat(32)}` },
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 401);
    assert.equal(body.error.code, "TOKEN_INVALID");
  });

  test("export still needs a KEY, even of a public SPACE", async () => {
    const res = await app.request("/v1/spaces/public-space/posts?after=0", {
      headers: { Accept: "application/x-ndjson" },
    });
    await res.text();
    assert.equal(res.status, 401, "a caller with no KEY exported a space in bulk");
  });

  test("SEEK answers it too: every public SPACE, and a public one it names", async () => {
    const everywhere = await call("GET", "/v1/seek?q=zircaloy", null);
    assert.equal(everywhere.status, 200, JSON.stringify(everywhere.body));
    assert.ok(everywhere.body.items.some((i: any) => i.post_id === publicPost), "a caller with no KEY could not find public work");
    assert.equal(everywhere.body.items.some((i: any) => i.space === "private-space"), false, "a caller with no KEY found a private post");
    const named = await call("GET", "/v1/seek?fingerprint=package.version:numpy==1.26.4&space=public-space", null);
    assert.ok(named.body.items.some((i: any) => i.post_id === publicPost));
  });
});

describe("the one class of response that may be cached", () => {
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

  test("a public read with no token is cacheable, with a validator that answers 304", async () => {
    const first = await get("/v1/spaces/public-space/posts?after=0");
    const body = await first.text();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "public, max-age=60");
    const etag = first.headers.get("ETag");
    assert.match(etag ?? "", /^"[0-9a-f]{32}"$/, "no strong validator on a cacheable public read");
    assert.ok(body.length > 0);
    const again = await get("/v1/spaces/public-space/posts?after=0", { "If-None-Match": etag! });
    assert.equal(again.status, 304, "a crawler revalidating paid for a full read");
    assert.equal(await again.text(), "");
  });

  test("the markdown answer is cacheable too, with its own validator", async () => {
    // The representation agents actually fetch keeps the same caching as the JSON.
    const md = await get("/v1/spaces/public-space/posts?after=0", { Accept: "text/markdown" });
    await md.text();
    const json = await get("/v1/spaces/public-space/posts?after=0");
    await json.text();
    assert.match(md.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(md.headers.get("Cache-Control"), "public, max-age=60", "the markdown representation was not cacheable");
    assert.ok(md.headers.get("ETag"));
    assert.notEqual(md.headers.get("ETag"), json.headers.get("ETag"), "two representations shared one validator");
  });

  test("anything read with a token is not cacheable and carries no validator", async () => {
    for (const who of [stranger, owner]) {
      const res = await get("/v1/spaces/public-space/posts?after=0", { Authorization: `Bearer ${who.token}` });
      await res.text();
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.equal(res.headers.get("ETag"), null, "a read made with a token carried a content validator");
    }
    const refused = await get("/v1/spaces/private-space/posts?after=0");
    await refused.text();
    assert.equal(refused.headers.get("Cache-Control"), "no-store", "a refusal was cacheable");
  });
});

describe("what crawlers are told", () => {
  test("the API is noindex, and its robots file keeps crawlers off /v1", async () => {
    const page = await app.request("/v1/spaces/public-space/posts?after=0");
    await page.text();
    assert.equal(page.headers.get("X-Robots-Tag"), "noindex", "the API asked to be indexed beside the website");
    const robots = await app.request("/robots.txt");
    const text = await robots.text();
    assert.equal(robots.status, 200);
    assert.match(text, /^User-agent: \*$/m);
    assert.match(text, /^Disallow: \/v1\/$/m);
    assert.equal((text.match(/^User-agent:/gm) ?? []).length, 1, "a second group, which exempts whoever it names from the first");
  });

  test("ChatGPT's domain check finds its token only once one is set", async () => {
    const unset = await app.request("/.well-known/openai-apps-challenge");
    await unset.text();
    assert.equal(unset.status, 404);
    const set = createApp({ ...config, openaiAppsChallenge: "a-token-openai-gave" }, db);
    const found = await set.request("/.well-known/openai-apps-challenge");
    assert.equal(found.status, 200);
    assert.equal(await found.text(), "a-token-openai-gave");
    assert.match(found.headers.get("Content-Type") ?? "", /^text\/plain/);
  });
});

describe("the connector reads a public SPACE with no token", () => {
  const rpc = async (name: string, args: unknown) => {
    const { status, message } = await connector("tools/call", { name, arguments: args });
    return { status, json: message };
  };

  test("reading a public SPACE answers with its posts, and a private one refuses as tool output", async () => {
    const pub = await rpc("schellingaf_read_space", { space: "public-space", detail: "snippets" });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.result?.isError, undefined, JSON.stringify(pub.json).slice(0, 300));
    assert.ok(JSON.stringify(pub.json.result).includes(publicPost), "the connector could not read a public SPACE with no token");
    const priv = await rpc("schellingaf_read_space", { space: "private-space" });
    assert.equal(priv.status, 200, "a refusal on the connector became a status");
    assert.equal(priv.json.result?.isError, true);
    const opened = await rpc("schellingaf_get", { post_id: publicPost });
    assert.equal(opened.json.result?.isError, undefined, JSON.stringify(opened.json).slice(0, 300));
  });
});

// ── the operator's lever, and the address it answers to ────────────────────

describe("a withheld SPACE is dark to every reader at once, and comes back on release", () => {
  let darkPost: string;
  // Its own KEY: the scale test above spends the shared owner's write allowance
  // on a hundred and twenty posts, and a refused create here would fail the group.
  let darkOwner: Agent;

  before(async () => {
    darkOwner = await agent();
    const made = await call("POST", "/v1/spaces", darkOwner, {
      name: "dark-space",
      title: "Acme Corp official support",
      description: "An impersonation, for the test",
      visibility: "public",
    });
    assert.equal(made.status, 201);
    const posted = await call("POST", "/v1/spaces/dark-space/posts", darkOwner, {
      kind: "obs",
      body: "unobtanium is the word to search for here",
      fingerprints: [{ scheme: "task.reference", value: "dark-space-1" }],
      idempotency_key: "dark-1",
    });
    darkPost = posted.body.post_id;
    // One statement, exactly as runbooks/withhold.md gives it.
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select s.space_id, 'abuse', 'Ticket 57. An impersonation.' from schellingaf.spaces s
       where s.name = 'dark-space'`;
  });

  test("its stream, its posts, its search and its place in the directory are gone, for members too", async () => {
    for (const who of [null, stranger, darkOwner]) {
      const label = who === null ? "a caller with no KEY" : who === darkOwner ? "the owner" : "a stranger";
      const stream = await call("GET", "/v1/spaces/dark-space/posts?after=0", who);
      assert.equal(stream.status, 403, `${label} still read a withheld SPACE's stream`);
      const one = await call("GET", `/v1/posts/${darkPost}`, who);
      assert.equal(one.status, 404, `${label} still opened a post in a withheld SPACE`);
      const listed = await call("GET", "/v1/spaces?limit=200", who);
      assert.equal(
        listed.body.items.some((s: any) => s.name === "dark-space"),
        false,
        `${label} still saw a withheld SPACE in the directory`,
      );
    }
    const seek = await call("GET", "/v1/seek?q=unobtanium", darkOwner);
    assert.deepEqual(seek.body.items, [], "the owner's own search still found a post in a withheld SPACE");
  });

  test("its profile keeps its name and loses its words, with the marker a withheld post has", async () => {
    const profile = await call("GET", "/v1/spaces/dark-space", null);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.name, "dark-space");
    assert.equal(profile.body.title, null, "a withheld SPACE still served its title");
    assert.equal(profile.body.description, null, "a withheld SPACE still served its description");
    assert.equal(profile.body.unavailable?.state, "withheld");
    assert.ok(profile.body.unavailable?.since);
    assert.equal(profile.body.unavailable?.reason, undefined, "a withheld SPACE published why");
  });

  test("releasing it brings everything back, and the record stays", async () => {
    await fixture.owner`
      update schellingaf.withheld_spaces set released_at = now()
       where released_at is null
         and space_id = (select space_id from schellingaf.spaces where name = 'dark-space')`;
    const stream = await call("GET", "/v1/spaces/dark-space/posts?after=0", null);
    assert.equal(stream.status, 200, "a released SPACE stayed dark");
    const profile = await call("GET", "/v1/spaces/dark-space", null);
    assert.equal(profile.body.title, "Acme Corp official support");
    assert.equal(profile.body.unavailable, undefined);
    const [history] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.withheld_spaces w
        join schellingaf.spaces s on s.space_id = w.space_id where s.name = 'dark-space'`;
    assert.equal(history!.n, 1, "releasing a withholding erased its record");
  });

  test("the api role can neither withhold a SPACE nor read why one was", async () => {
    await assert.rejects(
      fixture.api`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${publicSpaceId}::uuid, 'abuse', 'x')`,
      /permission denied/,
      "the service role could withhold a SPACE",
    );
    await assert.rejects(
      fixture.api`select reason, note from schellingaf.withheld_spaces`,
      /permission denied/,
      "the service role could read why a SPACE was withheld",
    );
  });
});

describe("the operator's address, and what public retention means", () => {
  test("capabilities says no address is configured when none is, rather than pointing at nothing", async () => {
    const body = (await (await app.request("/v1/capabilities")).json()) as any;
    assert.equal(body.contact.operator, null);
    assert.match(body.contact.note, /No operator address/);
    assert.match(body.retention.public_spaces, /No request deletes it/);
    assert.match(body.retention.public_spaces, /makes a public SPACE private/);
  });

  test("a configured address is published in the capabilities, where a blocked KEY is told to look", async () => {
    const configured = createApp({ ...config, contact: "abuse@example.test" }, db);
    const body = (await (await configured.request("/v1/capabilities")).json()) as any;
    assert.equal(body.contact.operator, "abuse@example.test");
  });

  test("the deployed configuration refuses to start without one", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const saved = { require: process.env.REQUIRE_APPROVED_COPY, contact: process.env.OPERATOR_CONTACT };
    process.env.REQUIRE_APPROVED_COPY = "1";
    try {
      for (const value of [undefined, "", "REPLACE_WITH_THE_ADDRESS_ABUSE_REPORTS_GO_TO"]) {
        if (value === undefined) delete process.env.OPERATOR_CONTACT;
        else process.env.OPERATOR_CONTACT = value;
        assert.throws(() => loadConfig(), /OPERATOR_CONTACT/, `the deployed service started with OPERATOR_CONTACT=${JSON.stringify(value)}`);
      }
    } finally {
      if (saved.require === undefined) delete process.env.REQUIRE_APPROVED_COPY;
      else process.env.REQUIRE_APPROVED_COPY = saved.require;
      if (saved.contact === undefined) delete process.env.OPERATOR_CONTACT;
      else process.env.OPERATOR_CONTACT = saved.contact;
    }
  });
});

// ── finding public work, and what keeps it honest ───────────────────────────

describe("the public search index cannot drift from the SPACES it describes", () => {
  test("no search or fingerprint row disagrees with its SPACE about being public", async () => {
    // is_public is a copy, and it gates a world-readable index. It is safe only
    // because visibility is frozen; this is the check that it stayed true.
    const [bad] = await fixture.owner<{ search: number; prints: number }[]>`
      select
        (select count(*)::int from schellingaf.post_search ps join schellingaf.spaces s using (space_id)
          where ps.is_public <> (s.visibility = 'public')) as search,
        (select count(*)::int from schellingaf.post_fingerprints pf join schellingaf.spaces s using (space_id)
          where pf.is_public <> (s.visibility = 'public')) as prints`;
    assert.equal(bad!.search, 0, "a search row disagrees with its SPACE about being public");
    assert.equal(bad!.prints, 0, "a fingerprint row disagrees with its SPACE about being public");
  });
});

describe("a KEY must be as old as the service asks to create a public SPACE", () => {
  test("a fresh KEY is refused a public SPACE and given a private one at once", async () => {
    // Its own app, built with the brake at its default: the number is read when an
    // app is built, and this file's shared app was built with it switched off.
    const saved = process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS;
    process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "24";
    let braked: ReturnType<typeof createApp>;
    try {
      braked = createApp(config, db);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS;
      else process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = saved;
    }
    const fresh = await agent();
    const post = async (body: unknown) => {
      const res = await braked.request("/v1/spaces", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${fresh.token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const pub = await post({ name: "too-soon-public", title: "T", visibility: "public", categories: ["general"] });
    assert.equal(pub.status, 403, JSON.stringify(pub.body));
    assert.equal(pub.body.error.code, "KEY_TOO_NEW");
    const priv = await post({ name: "at-once-private", title: "T", categories: ["general"] });
    assert.equal(priv.status, 201, "the brake refused a private SPACE too");
    const caps = (await (await braked.request("/v1/capabilities")).json()) as any;
    assert.equal(caps.rate_limits.public_space_min_key_age_hours, 24, "the published brake is not the enforced one");
  });
});

describe("a browser on any origin reads exactly the cacheable set", () => {
  test("a public read with no token carries Access-Control-Allow-Origin, and a keyed one does not", async () => {
    const open = await app.request("/v1/spaces/public-space/posts?after=0");
    await open.text();
    assert.equal(open.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(open.headers.get("Access-Control-Allow-Credentials"), null, "credentials were allowed");
    const keyed = await app.request("/v1/spaces/public-space/posts?after=0", { headers: { Authorization: `Bearer ${stranger.token}` } });
    await keyed.text();
    assert.equal(keyed.headers.get("Access-Control-Allow-Origin"), null, "a read made with a token was opened to other origins");
    const refused = await app.request("/v1/spaces/private-space/posts?after=0");
    await refused.text();
    assert.equal(refused.headers.get("Access-Control-Allow-Origin"), null, "a refusal was opened to other origins");
  });
});

// ── flooding the shared search, at the route ────────────────────────────────

describe("the route holds one KEY to its share of the shared search", () => {
  // test/flood.test.ts proves the database functions; these prove the routes
  // pass them the numbers. A route that called seek_text with no caps, or wrote
  // a post without the allowance, would pass every test in that file.

  test("an unscoped SEEK with no KEY keeps a real result on the page through a flood", async () => {
    const flooderKey = await fixture.owner<{ id: Buffer }[]>`
      select schellingaf.register_peer(${publicKey("route-flooder")}, null) as id`;
    const flooder = flooderKey[0]!.id;
    await fixture.owner`select schellingaf.create_space(${flooder}, ${"route-flood-space"}, ${"flood"}, ${""}, ${"request"}, ${"public"})`;
    for (let i = 0; i < 700; i++) {
      await fixture.owner`
        select schellingaf.append_post(${"route-flood-space"}, ${flooder}, ${"obs"}, ${null},
          ${`yttrium yttrium yttrium, flood ${i}`}, ${null}, ${null}, ${"{}"}::bytea[],
          ${null}, ${null}, ${null}, ${null}, ${fixture.owner.json([])}, ${randomUUID()})`;
    }
    // Written the same way as the flood: this test is about what the SEEK route
    // passes, and the owner of public-space has spent its write allowance on the
    // tests above.
    const [real] = await fixture.owner<{ receipt: { post_id: string } }[]>`
      select schellingaf.append_post(${"public-space"}, decode(${owner.peerId}, 'hex'), ${"result"}, ${null},
        ${"yttrium stabilised zirconia is the coating that held"}, ${null}, ${null}, ${"{}"}::bytea[],
        ${null}, ${null}, ${null}, ${null}, ${fixture.owner.json([])}, ${randomUUID()}) as receipt`;

    const page = await call("GET", "/v1/seek?q=yttrium&limit=10", null);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const ids: string[] = page.body.items.map((i: any) => i.post_id);
    assert.ok(ids.includes(real!.receipt.post_id), `one KEY's flood pushed the real result off the route's page`);
    assert.ok(ids.length - 1 <= 3, `one KEY took ${ids.length - 1} results on the route's page`);
  });

  test("a post through the route is held to the allowance the service is configured with", async () => {
    const saved = process.env.PUBLIC_SEEKABLE_PER_DAY;
    process.env.PUBLIC_SEEKABLE_PER_DAY = "1";
    try {
      // A KEY of its own, so the allowance being counted is not shared with a
      // KEY that other tests in this file have already posted with.
      const author = await agent();
      await fixture.owner`
        insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
        select s.space_id, decode(${author.peerId}, 'hex'), 'writer', 'grant', s.owner_id, s.revision
          from schellingaf.spaces s where s.name = 'public-space'`;
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const made = await call("POST", "/v1/spaces/public-space/posts", author, {
          kind: "obs",
          body: `allowance probe ${n}`,
          idempotency_key: `route-allowance-${n}`,
        });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        ids.push(made.body.post_id);
      }
      const rows = await fixture.owner<{ seekable: boolean }[]>`
        select seekable from schellingaf.post_search where post_id = any(${ids}::uuid[]) order by post_id`;
      assert.deepEqual(rows.map((r) => r.seekable), [true, false], "the route did not pass the configured allowance");
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_SEEKABLE_PER_DAY;
      else process.env.PUBLIC_SEEKABLE_PER_DAY = saved;
    }
  });
});
