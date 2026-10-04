// SEEK kept to one category, and the categories an answer's hits are filed under.
//
// A category is not a filter on the hits: the candidates are chosen before anything
// is ranked, so the category's own SPACES are what is probed. This holds that to what
// it promises: a category and everything below it and nothing else, a private space
// only to those who can read it, a flood from one owner held to three places a round,
// the approved sentence when a category holds more public SPACES than the window
// probes, and a wrong id refused before anything is spent.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, fixture, send, read, agent, type Agent } from "./lib/service.ts";
import { refileAll } from "../src/db/refile.ts";
import { CATEGORY_WINDOW_NOTE, forgetCategoryWindows } from "../src/http/seek.ts";
import { SEEKS_PER_MINUTE } from "../src/http/ratelimit.ts";

let honest: Agent;
let flooder: Agent;
let stranger: Agent;

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("seek_category");
before(async () => {
  await ready;
  honest = await agent();
  flooder = await agent();
  stranger = await agent();

  await makeSpace(honest, "cat-coding", ["coding-agents"], "public");
  await post(honest, "cat-coding", "zircaloy runner images build again", [{ scheme: "task.reference", value: "zircaloy-42" }]);
  await makeSpace(honest, "cat-maths", ["mathematics"], "public");
  await post(honest, "cat-maths", "zircaloy appears in this proof too", [{ scheme: "task.reference", value: "zircaloy-42" }]);
  await makeSpace(honest, "cat-private", ["claude-code"], "private");
  await post(honest, "cat-private", "zircaloy in a space nobody else reads");
  // A second category after the main one: found under either, counted under both.
  await makeSpace(honest, "cat-two", ["python", "coding-agents"], "public");
  await post(honest, "cat-two", "zircaloy wheels for python");

  // One owner flooding the category from five spaces of its own.
  for (let r = 1; r <= 5; r++) {
    await makeSpace(flooder, `cat-flood-${r}`, ["coding-agents"], "public");
    // Six a space: thirty posts and five spaces stay inside one KEY's write burst.
    for (let i = 0; i < 6; i++) await post(flooder, `cat-flood-${r}`, `zircaloy zircaloy zircaloy flood ${r}.${i}`);
  }
});

/** Sent as it is: every SPACE made here names its own categories. */
async function call(method: string, path: string, who: Agent | null = null, body?: unknown) {
  return read(await send(app, method, path, who, body));
}

async function makeSpace(who: Agent, name: string, categories: string[], visibility: string) {
  const r = await call("POST", "/v1/spaces", who, { name, title: name, categories, visibility });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

let counter = 0;
async function post(who: Agent, name: string, body: string, fingerprints: unknown[] = []) {
  const r = await call("POST", `/v1/spaces/${name}/posts`, who, { kind: "obs", title: "A POST in a test", body, fingerprints, idempotency_key: `k${counter++}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

const spacesOf = (items: any[]) => [...new Set(items.map((i) => i.space))].sort();

describe("a SEEK kept to a category", () => {
  test("finds the category and everything below it, and nothing else", async () => {
    const coding = await call("GET", "/v1/seek?q=zircaloy&category=coding-agents&limit=50");
    assert.equal(coding.status, 200, JSON.stringify(coding.body));
    const found = spacesOf(coding.body.items);
    assert.ok(found.includes("cat-coding") && found.includes("cat-two"), found.join(","));
    assert.ok(!found.includes("cat-maths"), "a SPACE in another category was searched");
    assert.deepEqual(coding.body.category, { id: "coding-agents", label: "Coding agents" });
    const above = await call("GET", "/v1/seek?q=zircaloy&category=artificial-intelligence&limit=50");
    assert.ok(spacesOf(above.body.items).includes("cat-coding"), "the category above did not include the one below");
    const maths = await call("GET", "/v1/seek?q=zircaloy&category=science&limit=50");
    assert.deepEqual(spacesOf(maths.body.items), ["cat-maths"]);
  });

  test("a private space is searched for those who can read it, and for nobody else", async () => {
    const own = await call("GET", "/v1/seek?q=zircaloy&category=claude-code", honest);
    assert.deepEqual(spacesOf(own.body.items), ["cat-private"]);
    for (const who of [null, stranger]) {
      const outside = await call("GET", "/v1/seek?q=zircaloy&category=coding-agents&limit=50", who);
      assert.ok(!spacesOf(outside.body.items).includes("cat-private"), "a private post reached an outsider");
      const exact = await call("GET", "/v1/seek?q=zircaloy&category=claude-code", who);
      assert.deepEqual(exact.body.items, []);
      assert.match(exact.body.truncated_note, /no hit in that category/);
    }
  });

  test("one owner's flood takes three places of the first round, and fills only places left after it", async () => {
    // Round 1 is the honest posts and three of the flood, best first; the rest of the
    // flood comes after, in the rounds that fill a page nobody else wanted. The window
    // probes three of the flooder's five SPACES, three an owner, so eighteen posts.
    const r = await call("GET", "/v1/seek?q=zircaloy&category=coding-agents&limit=50");
    const spaces: string[] = r.body.items.map((i: any) => i.space);
    const lastHonest = Math.max(spaces.lastIndexOf("cat-coding"), spaces.lastIndexOf("cat-two"));
    assert.ok(spaces.includes("cat-coding") && spaces.includes("cat-two"), "an honest result was buried");
    const ahead = spaces.slice(0, lastHonest).filter((s) => s.startsWith("cat-flood-")).length;
    assert.ok(ahead <= 3, `the flooder took ${ahead} places of the first round`);
    assert.equal(spaces.filter((s) => s.startsWith("cat-flood-")).length, 18, "places nobody else wanted stayed empty");
  });

  test("a fingerprint keeps to the category too", async () => {
    const r = await call("GET", "/v1/seek?fingerprint=task.reference:zircaloy-42&category=coding-agents");
    assert.deepEqual(spacesOf(r.body.items), ["cat-coding"]);
    const unscoped = await call("GET", "/v1/seek?fingerprint=task.reference:zircaloy-42");
    assert.deepEqual(spacesOf(unscoped.body.items), ["cat-coding", "cat-maths"]);
  });

  test("the answer says which categories its hits are filed under, counted from the page alone", async () => {
    const r = await call("GET", "/v1/seek?q=zircaloy%20proof&limit=5");
    assert.deepEqual(r.body.hit_categories, [{ id: "mathematics", label: "Mathematics", hits: 1 }]);
    const two = await call("GET", "/v1/seek?q=zircaloy%20wheels");
    assert.deepEqual(two.body.hit_categories.map((h: any) => h.id), ["coding-agents", "python"]);
    const none = await call("GET", "/v1/seek?q=nothing-matches-this-at-all");
    assert.deepEqual(none.body.hit_categories, []);
  });

  test("category and space together are refused, and a wrong id costs nothing", async () => {
    const both = await call("GET", "/v1/seek?q=zircaloy&category=coding-agents&space=cat-coding");
    assert.equal(both.status, 400);
    assert.match(both.body.error.detail, /category or space, not both/);
    const unknown = await call("GET", "/v1/seek?q=zircaloy&category=claude-kode");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "INVALID_CATEGORY");
    assert.match(unknown.body.error.detail, /claude-code/);
    // More wrong ids from one KEY than its SEEK window holds, and then a real SEEK.
    // A KEY, because a caller with no KEY meets the general read ceiling at the same
    // number, and that one does count every read.
    for (let i = 0; i < SEEKS_PER_MINUTE + 5; i++) {
      assert.equal((await call("GET", "/v1/seek?q=zircaloy&category=not-a-category", stranger)).status, 400);
    }
    assert.equal((await call("GET", "/v1/seek?q=zircaloy&category=coding-agents", stranger)).status, 200);
  });

  test("still needs words or a fingerprint", async () => {
    const r = await call("GET", "/v1/seek?category=coding-agents");
    assert.equal(r.status, 400);
    assert.match(r.body.error.detail, /give q, fingerprint or fingerprint_prefix/);
  });

  test("the category and its window are the last arguments, and default to none", async () => {
    const [text] = await fixture.owner<{ args: string }[]>`
      select pg_get_function_arguments('schellingaf.seek_text'::regproc) as args`;
    // And p_oracle after them, defaulting to none too.
    assert.match(text!.args, /p_rank_work bigint DEFAULT 16000000, p_category text DEFAULT NULL::text, p_window uuid\[\] DEFAULT NULL::uuid\[\], p_oracle boolean DEFAULT NULL::boolean$/);
    const [prints] = await fixture.owner<{ args: string }[]>`
      select pg_get_function_arguments('schellingaf.seek_fingerprint'::regproc) as args`;
    assert.match(prints!.args, /p_category text DEFAULT NULL::text, p_oracle boolean DEFAULT NULL::boolean$/);
  });
});

describe("a category with more public SPACES than the window probes", () => {
  before(async () => {
    // 601 public SPACES in one rare category from 201 owners, straight in: what is
    // under test is what the search says, not how the spaces were made.
    await fixture.owner`
      insert into schellingaf.peers (peer_id, public_key)
      select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(('owner' || g)::bytea)),
             sha256(('owner' || g)::bytea) from generate_series(1, 201) g
      on conflict do nothing`;
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description, visibility, categories)
      select 'welfare-space-' || g,
             sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(('owner' || (1 + g % 201))::bytea)),
             'Welfare ' || g, 'x', 'public', array['model-welfare']
        from generate_series(1, 601) g`;
    await refileAll(fixture.owner);
    // Filed within the minute a window is held for, so the next SEEK takes a fresh one.
    forgetCategoryWindows();
  });

  test("says it searched the first six hundred, in the words the service is held to", async () => {
    const r = await call("GET", "/v1/seek?q=zircaloy&category=model-welfare");
    assert.equal(r.status, 200);
    assert.ok((r.body.truncated_note ?? "").includes(CATEGORY_WINDOW_NOTE), r.body.truncated_note);
    assert.match(CATEGORY_WINDOW_NOTE, /^Searched 600 of this category's public spaces, not all: those filed here as their main category first, then the most recently written\. Narrow to a category below it, or name a space\.$/);
  });

  test("a SPACE written longer ago is still searched when two hundred owners fill the category with fresher ones", async () => {
    // Every one of the six hundred and one is filed here first and was written more
    // recently than this one. Each owner's first SPACE comes before any owner's
    // second, so it is probed.
    await makeSpace(stranger, "welfare-honest", ["model-welfare"], "public");
    await post(stranger, "welfare-honest", "zircaloy in the welfare notes");
    await fixture.owner`update schellingaf.spaces set updated_at = now() - interval '1 day' where name = 'welfare-honest'`;
    forgetCategoryWindows();
    const r = await call("GET", "/v1/seek?q=zircaloy&category=model-welfare");
    assert.equal(r.status, 200);
    assert.ok(spacesOf(r.body.items).includes("welfare-honest"), JSON.stringify(spacesOf(r.body.items)));
    assert.ok((r.body.truncated_note ?? "").includes(CATEGORY_WINDOW_NOTE));
  });

  test("and says nothing of the kind for a category the window covers", async () => {
    const r = await call("GET", "/v1/seek?q=zircaloy&category=coding-agents");
    assert.ok(!(r.body.truncated_note ?? "").includes("Searched 600"));
  });

  test("an unscoped SEEK is not held to a category", async () => {
    const r = await call("GET", "/v1/seek?q=zircaloy&limit=50");
    assert.equal(r.status, 200);
    assert.equal(r.body.category, undefined);
    assert.ok(spacesOf(r.body.items).includes("cat-maths"));
  });
});
