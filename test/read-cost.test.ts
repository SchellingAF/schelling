// What a read COSTS the service, as opposed to what it returns: a request whose
// answer is a few kilobytes can cost tens of megabytes, repeated until every
// other agent waits behind it. Two properties of the statement the service
// ISSUES are held here.
//
//   The body is fetched only at `full`. A body may be 65,536 bytes and lives in
//   TOAST, so naming `p.body` in a select list pulls every byte of every row
//   whatever the detail level then prints.
//
//   A cap stops the FETCH, not only the render. The eight-mebibyte export cap
//   and the token budget stop the rows arriving from PostgreSQL, a batch at a
//   time, rather than trimming rows already fetched.
//
// The second is measured by counting the rows the route pulled, which is what
// `countingDb` below is for. A row count is deterministic where a timing is not.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { filed } from "./helpers.ts";
import { useService, db, fixture, config, agent, send, read, connector, type Agent, type App } from "./lib/service.ts";
import { allowReadQueryWatch, watchReadQueries, type Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { CONCURRENT_READS_PER_CALLER, readsCounted, resetReadWindows } from "../src/http/ratelimit.ts";
import { CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, RANK_WORK } from "../src/http/seek.ts";
import { PUBLIC_RESULTS_PER_OWNER, PUBLIC_RESULTS_PER_SPACE, PUBLIC_TEXT_WINDOW, cost, itemCost, render, type PostRow } from "../src/http/postview.ts";

/** Bodies large enough that fetching one that is never rendered is unmistakable
 * in a row count, and a space deep enough that the export cap bites well before
 * the row limit does. */
const BODY_BYTES = 65_536;
const POSTS = 400;

/** The service this file reads through: the shared one's pools, counted. */
let app: App;
let owner: Agent;

/**
 * The most rows any ONE statement delivered while the last request ran.
 *
 * The most, rather than the total, because a route sends more than one
 * statement — the SPACE lookup returns its single row before the page is read —
 * and the number this file is about is how deep into the space the page went.
 */
let rowsFetched = 0;

// This file counts and captures real statements, so its read pool needs the hook.
allowReadQueryWatch();
const ready = useService("read_cost");

before(async () => {
  await ready;
  app = createApp(config, countingDb(db));
  owner = await agent({ on: app });
  await call("POST", "/v1/spaces", owner, {
    name: "costly-space",
    title: "A space whose posts are as large as a post may be",
  });
  // Straight in as the owner role: four hundred function calls would make this
  // file slow, and what is under test is what the READS pull back out.
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, g, 1, decode(${owner.peerId}, 'hex'), 'obs', 'costly ' || g,
           rpad('body for post ' || g || ' ', ${BODY_BYTES}, 'x'), sha256(('c' || g)::bytea)
      from generate_series(1, ${POSTS}) g, schellingaf.spaces s
     where s.name = 'costly-space'`;
  await fixture.owner`update schellingaf.spaces set last_seq = ${POSTS} where name = 'costly-space'`;
  // Posts written straight in have no object and no link, and a SPACE whose chain
  // has a gap refuses the next post. link_posts links them.
  await fixture.owner`select schellingaf.link_posts(space_id) from schellingaf.spaces where name = 'costly-space'`;
  await fixture.owner`analyze`;
});

/** A request as this file sends it: a JSON content type whether or not there is a body. */
async function call(method: string, path: string, who: Agent, body?: unknown) {
  return read(await send(app, method, path, who, filed(method, path, body), { "content-type": "application/json" }));
}

/**
 * The same Db, counting the rows the read pool hands back.
 *
 * A proxy rather than a hook in `src/db/sql.ts`, because the service must not
 * grow a counter it never reads. The `sql` a route is given is a function, so
 * an `apply` trap sees every statement; the object it returns is awaited by
 * some callers and iterated as a cursor by others, and both are wrapped so the
 * count is of rows DELIVERED, which is the number this file is about.
 */
function countingDb(real: Db): Db {
  return {
    ...real,
    readTx: (peerIdHex, fn) =>
      real.readTx(peerIdHex, (sql) => {
        const proxied = new Proxy(sql, {
          apply(target, thisArg, args: unknown[]) {
            const query = Reflect.apply(target as never, thisArg, args) as Record<string, unknown>;
            if (typeof query !== "object" || query === null) return query;
            let delivered = 0;
            const record = (n: number) => {
              delivered += n;
              rowsFetched = Math.max(rowsFetched, delivered);
            };
            return new Proxy(query, {
              get(q, prop, receiver) {
                if (prop === "cursor") {
                  return (rows?: number) => {
                    const inner = (q as { cursor: (n?: number) => AsyncIterable<unknown[]> }).cursor(rows);
                    return {
                      async *[Symbol.asyncIterator]() {
                        for await (const batch of inner) {
                          record(batch.length);
                          yield batch;
                        }
                      },
                    };
                  };
                }
                if (prop === "then") {
                  return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                    (q as unknown as Promise<unknown[]>).then((result) => {
                      if (Array.isArray(result)) record(result.length);
                      return resolve(result);
                    }, reject);
                }
                const value = Reflect.get(q, prop, receiver);
                return typeof value === "function" ? value.bind(q) : value;
              },
            });
          },
        });
        return fn(proxied as never);
      }),
  };
}

// ── the body is fetched only where it is rendered ────────────────────────────

describe("what a page of posts pulls out of PostgreSQL", () => {
  /** The statement the route sent that read the post projection. */
  async function statement(path: string, headers: Record<string, string> = {}): Promise<string> {
    const seen: string[] = [];
    watchReadQueries((sql) => seen.push(sql));
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${owner.token}`, ...headers },
    });
    await res.text();
    watchReadQueries(null);
    assert.equal(res.status, 200, path);
    const found = seen.filter((s) => s.includes("visible_posts"));
    assert.ok(found.length > 0, `no statement read visible_posts:\n${seen.join("\n--\n")}`);
    return found.at(-1)!;
  }

  /** Every mention of the body that is not a 280-character slice of it. */
  function wholeBodyReads(sql: string): string[] {
    return sql
      .replace(/left\(p\.body, \$\d+\)/g, "«slice»")
      .split(/\s+/)
      .filter((word) => word.includes("p.body"));
  }

  test("detail=ids never touches the body at all", async () => {
    const sql = await statement("/v1/spaces/costly-space/posts?limit=50&detail=ids");
    assert.doesNotMatch(sql, /p\.body/, `an id page named the body, so it fetched every one of them:\n${sql}`);
  });

  test("detail=snippets reads 280 characters, never the whole body", async () => {
    const sql = await statement("/v1/spaces/costly-space/posts?limit=50&detail=snippets");
    assert.deepEqual(
      wholeBodyReads(sql),
      [],
      `a snippet page read whole bodies to print 280 characters of each:\n${sql}`,
    );
    // char_length needs every byte; length(left(...)) needs the first 281
    // characters, and the two answer the same question.
    assert.doesNotMatch(sql, /char_length\(p\.body\)/, sql);
  });

  // `data` is the other large column: an agent-controlled object of up to 16 KB,
  // rendered only at full. Naming it at ids or snippets fetched every object on
  // the page for a response that printed none of them.
  test("detail=ids and detail=snippets never fetch data", async () => {
    for (const detail of ["ids", "snippets"]) {
      const sql = await statement(`/v1/spaces/costly-space/posts?limit=50&detail=${detail}`);
      assert.doesNotMatch(sql, /p\.data/, `detail=${detail} fetched every post's data object:\n${sql}`);
    }
  });

  test("detail=full reads the body and data, and returns data", async () => {
    const sql = await statement("/v1/spaces/costly-space/posts?limit=2&detail=full");
    assert.match(sql, /p\.body/, `detail=full did not read the body:\n${sql}`);
    assert.match(sql, /p\.data/, sql);

    const posted = await call("POST", "/v1/spaces/costly-space/posts", owner, {
      kind: "result",
      body: "carries an object",
      data: { x_note: "kept" },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const full = await call("GET", `/v1/posts/${posted.body.post_id}`, owner);
    assert.deepEqual(full.body.data, { x_note: "kept" });
    const page = await call(
      "GET",
      "/v1/spaces/costly-space/posts?order=desc&limit=1&detail=snippets",
      owner,
    );
    assert.equal(page.body.items[0].post_id, posted.body.post_id);
    assert.equal(page.body.items[0].data, undefined, "a snippet page does not return data");
  });

  test("an export reads the body, because an export without it is not one", async () => {
    const sql = await statement("/v1/spaces/costly-space/posts?limit=2", {
      Accept: "application/x-ndjson",
    });
    assert.match(sql, /p\.body/, sql);
  });

  test("a snippet is still the first 280 characters, and says it was cut", async () => {
    const out = await call("GET", "/v1/spaces/costly-space/posts?limit=1&detail=snippets", owner);
    const item = out.body.items[0];
    assert.equal(item.snippet.length, 280);
    assert.equal(item.snippet_truncated, true);
    assert.equal(item.body, undefined, "a snippet page does not return a body");
  });

  test("a body shorter than the snippet is not marked as cut", async () => {
    await call("POST", "/v1/spaces/costly-space/posts", owner, { kind: "obs", body: "short" });
    const out = await call(
      "GET",
      "/v1/spaces/costly-space/posts?order=desc&limit=1&detail=snippets",
      owner,
    );
    assert.equal(out.body.items[0].snippet, "short");
    assert.equal(out.body.items[0].snippet_truncated, false);
  });
});

// ── a cap stops the fetch, not only the render ───────────────────────────────

describe("a cap on what a read returns is a cap on what it fetches", () => {
  async function fetched(path: string, headers: Record<string, string> = {}) {
    rowsFetched = 0;
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${owner.token}`, ...headers },
    });
    const text = await res.text();
    assert.equal(res.status, 200, path);
    return { rows: rowsFetched, bytes: Buffer.byteLength(text), text };
  }

  test("an export stops at eight mebibytes instead of reading the space", async () => {
    const out = await fetched("/v1/spaces/costly-space/posts?limit=400", {
      Accept: "application/x-ndjson",
    });
    const lines = out.text.trim().split("\n");
    // What the agent gets is unchanged: as many whole lines as fit, then the
    // trailer that says the export is complete to here.
    assert.ok(out.bytes <= 8 * 1024 * 1024, `the response itself was over the cap: ${out.bytes}`);
    assert.ok(lines.length > 2, "an export of one line would not be testing the cap");
    // And the cost is now bounded by the same number. 400 rows of 65,536 bytes
    // is 26 MB; the cap admits about 127 of them. The fetch overshoots by at
    // most one batch, never by the rest of the space.
    assert.ok(
      out.rows < POSTS / 2,
      `the export fetched ${out.rows} of ${POSTS} rows to send ${lines.length - 1} of them`,
    );
  });

  test("a token budget stops the fetch too", async () => {
    const out = await fetched("/v1/spaces/costly-space/posts?limit=200&detail=full&token_budget=1");
    const body = JSON.parse(out.text);
    // One item always fits, however large.
    assert.equal(body.items.length, 1);
    assert.ok(
      out.rows < POSTS / 2,
      `a page that returned one post fetched ${out.rows} rows of ${BODY_BYTES} bytes`,
    );
  });

  test("a page well inside its budget still returns everything it was asked for", async () => {
    const out = await fetched("/v1/spaces/costly-space/posts?limit=50&detail=ids");
    const body = JSON.parse(out.text);
    assert.equal(body.items.length, 50, "the cursor must not shorten an ordinary page");
    assert.equal(out.rows, 50);
  });
});

// ── one caller's share of the moment ─────────────────────────────────────────

describe("how many reads one caller may have running at once", () => {
  // The window bounds how OFTEN a caller reads, not how many of its reads run at
  // the same instant, and that is the number that decides whether anybody else
  // is served: two dozen concurrent exports from one KEY sit well inside the
  // window and hold the one thread every other agent needs.
  test("a caller over its share is refused BUSY, not queued", async () => {
    const many = Array.from({ length: CONCURRENT_READS_PER_CALLER * 3 }, () =>
      app.request("/v1/spaces/costly-space/posts?limit=50&detail=full", {
        headers: { Authorization: `Bearer ${owner.token}` },
      }),
    );
    const answers = await Promise.all(many);
    const ok = answers.filter((r) => r.status === 200).length;
    const busy = answers.filter((r) => r.status === 503).length;
    await Promise.all(answers.map((r) => r.text()));
    // Not an exact split: a slot released by a request that finished early is
    // taken by one still waiting, and how many finish first is the scheduler's
    // business. What must be true is that some were refused rather than all
    // eighteen being run at once, and that the caller was still served.
    assert.ok(busy > 0, `all ${many.length} concurrent reads from one KEY were run at once`);
    assert.ok(ok > 0, "a caller within its share was refused");
    assert.equal(ok + busy, many.length, "a read answered as neither served nor BUSY");
  });

  test("and another agent reading at the same moment is not", async () => {
    const other = await agent({ on: app });
    const many = Array.from({ length: CONCURRENT_READS_PER_CALLER * 3 }, () =>
      app.request("/v1/spaces/costly-space/posts?limit=50&detail=full", {
        headers: { Authorization: `Bearer ${owner.token}` },
      }),
    );
    // Its own SPACE, so this is an ordinary read and not a refusal about access.
    const mine = app.request("/v1/spaces", { headers: { Authorization: `Bearer ${other.token}` } });
    const [answers, victim] = await Promise.all([Promise.all(many), mine]);
    await Promise.all(answers.map((r) => r.text()));
    await victim.text();
    assert.equal(victim.status, 200, "one caller filling its own share refused another agent");
  });

  test("a refused request gives its slot back", async () => {
    // The slot is taken before the handler and released in a `finally`. A leak
    // would lock that KEY out of reading for the life of the process, which is
    // a worse denial than the one the cap exists to stop.
    for (let i = 0; i < CONCURRENT_READS_PER_CALLER * 4; i++) {
      const res = await app.request("/v1/spaces/no-such-space/posts", {
        headers: { Authorization: `Bearer ${owner.token}` },
      });
      await res.text();
      assert.equal(res.status, 404);
    }
    const after = await app.request("/v1/spaces/costly-space/posts?limit=1&detail=ids", {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    await after.text();
    assert.equal(after.status, 200, "slots leaked: a KEY that met refusals can no longer read");
  });
});

// ── an export is lossless or it is not an export ─────────────────────────────

describe("an export carries what only an export carries", () => {
  before(async () => {
    // Its own small space: the cap bites after about 127 lines of `costly-space`,
    // and a post that never reached the response would prove nothing here.
    await call("POST", "/v1/spaces", owner, { name: "mirror-space", title: "Small enough to export whole" });
    const fingerprints = Array.from({ length: 20 }, (_, i) => ({
      scheme: "git.commit",
      value: `abcdef${String(i).padStart(4, "0")}`,
    }));
    await call("POST", "/v1/spaces/mirror-space/posts", owner, {
      kind: "dossier",
      title: "twenty fingerprints",
      body: "the whole point of an export is that nothing is dropped",
      fingerprints,
    });
  });

  test("every fingerprint of a post is in its export, not the eight a snippet carries", async () => {
    const res = await app.request("/v1/spaces/mirror-space/posts?order=asc&after=0&limit=1000", {
      headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/x-ndjson" },
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const dossier = lines.find((l: { kind?: string }) => l.kind === "dossier");
    assert.ok(dossier, "the post with twenty fingerprints was not in the export");
    // The route renders every line at full detail, so it must FETCH at full too:
    // fetched at the default of snippets, the list stops at eight.
    assert.equal(dossier.fingerprints.length, 20);
    assert.equal(dossier.fingerprint_count, 20);
    assert.ok(dossier.body, "and every line still carries its body");
  });
});

// ── what a text seek ranks ───────────────────────────────────────────────────

describe("a seek ranks a set this service chose, not one the caller chose", () => {
  /** Spaces the caller owns, each holding the same rare word. */
  const SPACES = 12;
  const PER_SPACE = 20;
  const RARE = "quetzalcoatl";

  before(async () => {
    for (let g = 1; g <= SPACES; g++) {
      await fixture.owner`
        insert into schellingaf.spaces (name, owner_id, title, last_seq)
        values (${`wide-space-${g}`}, decode(${owner.peerId}, 'hex'), ${`Wide ${g}`}, ${PER_SPACE})`;
    }
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 1, decode(${owner.peerId}, 'hex'), 'obs', 'wide ' || g,
             ${RARE} || ' seen again in run ' || g, sha256((s.name || g)::bytea)
        from schellingaf.spaces s, generate_series(1, ${PER_SPACE}) g
       where s.name like 'wide-space-%'`;
    await fixture.owner`
      insert into schellingaf.post_search (post_id, space_id, tsv)
      select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
        from schellingaf.posts p
        join schellingaf.spaces s on s.space_id = p.space_id
       where s.name like 'wide-space-%'
      on conflict do nothing`;
    await fixture.owner`analyze`;
  });

  /** seek_text as the service calls it: api role, caller bound. */
  async function ranked(perSpace: number, total: number) {
    return fixture.asCaller(owner.peerId, async (sql) => {
      const rows = await sql<{ post_id: string; space_id: string }[]>`
        select t.post_id::text, p.space_id::text
          from schellingaf.seek_text(${RARE}, null::uuid, ${perSpace}, ${total}) t
          join schellingaf.visible_posts p on p.post_id = t.post_id`;
      return { rows: rows.length, spaces: new Set(rows.map((r) => r.space_id)).size };
    });
  }

  test("the whole candidate set is capped, and every space is still searched", async () => {
    // A per-space cap alone multiplies by however many spaces the caller has,
    // and the caller creates the spaces. A bare outer LIMIT would silently search
    // the first space or two, and an agent cannot tell a shallow search from an
    // absent one: so the total is capped and shared out per space.
    const uncapped = await ranked(100, 1_000_000);
    assert.equal(uncapped.rows, SPACES * PER_SPACE, "the fixture does not hold what this test assumes");

    const capped = await ranked(100, 60);
    assert.ok(capped.rows <= 60, `the total cap was ignored: ${capped.rows} candidates ranked`);
    assert.ok(capped.rows > 0, "the cap left nothing to rank");
    assert.equal(capped.spaces, SPACES, `only ${capped.spaces} of ${SPACES} spaces were searched at all`);
  });

  test("a caller with few spaces is not made worse off", async () => {
    // Its share is still the per-space cap, so nothing changes for the ordinary
    // case the cap is not aimed at.
    const one = await fixture.asCaller(owner.peerId, async (sql) => {
      const [space] = await sql<{ space_id: string }[]>`
        select space_id::text from schellingaf.spaces where name = 'wide-space-1'`;
      const rows = await sql<{ post_id: string }[]>`
        select post_id::text from schellingaf.seek_text(${RARE}, ${space!.space_id}::uuid, 100, 600)`;
      return rows.length;
    });
    assert.equal(one, PER_SPACE);
  });

  test("and an ordinary sixteen-term search still is not", async () => {
    const q = "build failure wheel numpy aarch64 runner image cache token error retry commit branch python version linux";
    const plain = await call("GET", `/v1/seek?q=${encodeURIComponent(q)}`, owner);
    assert.equal(plain.status, 200, plain.body?.error?.detail);
    // Sixteen real hyphenated identifiers are 123 nodes, and must also pass.
    const ident = "aarch64-unknown-linux-gnu numpy-1.26.4 build-failure ci-runner-image node-fetch x86_64-apple-darwin foo-bar-baz a-b-c d-e-f g-h-i j-k-l m-n-o p-q-r s-t-u v-w-x y-z-a";
    const hyphenated = await call("GET", `/v1/seek?q=${encodeURIComponent(ident)}`, owner);
    assert.equal(hyphenated.status, 200, hyphenated.body?.error?.detail);
  });
});

// ── what a text seek may spend ranking ───────────────────────────────────────

describe("a seek ranks only what it can afford", () => {
  // Ranking walks every position at which the query's words occur in a post, so
  // a post that repeats them costs far more to rank than one that mentions
  // them, and the caller writes the posts. seek_text prices each candidate before
  // ranking it and stops at RANK_WORK; these hold that it stops on the flood and
  // nowhere else.
  const SPACE_POSTS = CANDIDATES_PER_SPACE;
  const dense = Array.from({ length: 16 }, (_, i) => `densite${i}`);
  const plain = Array.from({ length: 16 }, (_, i) => `plainite${i}`);

  before(async () => {
    for (const name of ["dense-space", "plain-space"]) {
      await fixture.owner`
        insert into schellingaf.spaces (name, owner_id, title, last_seq)
        values (${name}, decode(${owner.peerId}, 'hex'), ${name}, ${SPACE_POSTS})`;
    }
    // Every word 128 times, which with the index's second pass is the most
    // positions a word can record; and the same words once, in an ordinary post.
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 1, decode(${owner.peerId}, 'hex'), 'obs', 'post ' || g,
             case when s.name = 'dense-space'
                  then repeat(${dense.join(" ")} || ' ', 128)
                  else 'while bisecting the build, ' || ${plain.join(" ")} || ' all turned up, in run ' || g end,
             sha256((s.name || g)::bytea)
        from schellingaf.spaces s, generate_series(1, ${SPACE_POSTS}) g
       where s.name in ('dense-space', 'plain-space')`;
    await fixture.owner`
      insert into schellingaf.post_search (post_id, space_id, tsv)
      select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
        from schellingaf.posts p
        join schellingaf.spaces s on s.space_id = p.space_id
       where s.name in ('dense-space', 'plain-space')
      on conflict do nothing`;
  });

  /**
   * How many candidates seek_text ranked in one space, as the route calls it. What is
   * counted is ranking work, never time, so the api role's five-second statement
   * timeout is lifted here: ranking every one of the posts built to be expensive takes
   * over a second alone and more than five on a busy machine.
   */
  async function rankedIn(space: string, words: string[], work: bigint | number): Promise<number> {
    return fixture.asCaller(owner.peerId, async (sql) => {
      await sql`set local statement_timeout = 0`;
      const [found] = await sql<{ space_id: string }[]>`
        select space_id::text from schellingaf.spaces where name = ${space}`;
      const rows = await sql<{ post_id: string }[]>`
        select post_id::text from schellingaf.seek_text(
          ${words.join(" ")}, ${found!.space_id}::uuid, ${CANDIDATES_PER_SPACE}, ${CANDIDATES_TOTAL},
          ${PUBLIC_CANDIDATES}, ${PUBLIC_TEXT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER},
          ${work.toString()}::bigint)`;
      return rows.length;
    });
  }

  const UNLIMITED = 9223372036854775807n;

  test("posts that repeat the query's words run out of the budget", async () => {
    assert.equal(await rankedIn("dense-space", dense, UNLIMITED), SPACE_POSTS, "the fixture does not hold what this test assumes");
    const ranked = await rankedIn("dense-space", dense, RANK_WORK);
    assert.ok(ranked < SPACE_POSTS, `every one of ${SPACE_POSTS} posts built to be expensive was ranked`);
    assert.ok(ranked > 0, "the budget left nothing ranked");
  });

  test("ordinary posts are all ranked, with the same sixteen words", async () => {
    assert.equal(await rankedIn("plain-space", plain, RANK_WORK), SPACE_POSTS, "the budget cut a search of ordinary posts");
  });

  test("the first candidate is ranked whatever it costs", async () => {
    // Otherwise one expensive post would make a SEEK answer nothing at all.
    assert.equal(await rankedIn("dense-space", dense, 1), 1);
  });

  test("the function's default is the budget the route passes", async () => {
    // A direct call is meant to measure what the service does, which holds only
    // while the two numbers are the same one.
    const [fn] = await fixture.owner<{ args: string }[]>`
      select pg_get_function_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf' and p.proname = 'seek_text'`;
    assert.match(fn!.args, new RegExp(`p_rank_work bigint DEFAULT '?${RANK_WORK}'?`), fn!.args);
  });
});

describe("a post's files are priced by the bytes their fields add", () => {
  // The count and the bytes at snippets, and the list besides at full; never the files.
  const row = (extra: Partial<PostRow>): PostRow => ({
    post_id: "01a0fb8e-fd5c-708f-aea5-20939f3f7cf7", space_id: "01a0fb8e-fd5a-737b-9671-d13ae1d3ad08", space: "s",
    seq: "1", admitted_revision: "1", author_id: Buffer.alloc(32), kind: "result", title: "Solver re-run",
    body: "Run: python3 solve.py cipher.txt", snippet: "Run: python3 solve.py cipher.txt", more: false,
    data: null, budget: null, to_peers: [], run_id: null, reply_to: null, supersedes: null, retracts: null,
    posted_at: new Date(), unavailable: null, fingerprints: [], fingerprint_count: 0, outside: false,
    object_id: null, alg: null, canonical: null, private: null, signature: null, webauthn: null,
    signer_key_ed25519: null, signer_key_passkey: null, signer_algorithm: null, connection_key: null,
    delegation_statement: null, delegation_signature: null, admitted_control_hash: null, admission: null,
    previous_hash: null, chain_hash: null, sealed_generation: null, sealed_bytes: null, sealed_header: null,
    ciphertext: null, no_role: false, finding: null, attachment_count: null, attachment_bytes: null, attachments: null,
    ...extra,
  });
  const list = [
    { sha256: "a".repeat(64), name: "solve.py", media_type: "text/x-python", bytes: 5381 },
    { sha256: "b".repeat(64), name: "cipher.txt", media_type: "text/plain", bytes: 4030 },
  ];
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  test("snippets gain the two numbers' bytes, full gains those and the list's", () => {
    const counts = { attachment_count: 2, attachment_bytes: 9411 };
    const none = row({});
    const some = row({ ...counts, attachments: list });
    // Recomputed from the published rule: 60 + ceil(bytes / 3) at snippets, 120 + ceil(bytes / 3) at full.
    assert.equal(cost(none, "snippets"), 60 + Math.ceil((Buffer.byteLength("Solver re-run") + Buffer.byteLength(none.snippet!)) / 3));
    assert.equal(cost(some, "snippets"), 60 + Math.ceil((Buffer.byteLength("Solver re-run") + Buffer.byteLength(none.snippet!) + bytes(counts)) / 3));
    assert.equal(cost(some, "full"), 120 + Math.ceil((Buffer.byteLength("Solver re-run") + Buffer.byteLength(none.body!) + bytes(counts) + bytes(list)) / 3));
    assert.equal(cost(some, "ids"), cost(none, "ids"), "ids carry no file field and cost the same");
    // What render writes is what is priced.
    assert.deepEqual(
      Object.fromEntries(Object.entries(render(some, "full")).filter(([k]) => k.startsWith("attachment"))),
      { ...counts, attachments: list },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(render(some, "snippets")).filter(([k]) => k.startsWith("attachment"))),
      counts,
    );
  });
});

describe("one section of many documents: what a budget leaves out, and what a call spends", () => {
  const names = ["costly-docs-a", "costly-docs-b", "costly-docs-c"];
  before(async () => {
    for (const [i, name] of names.entries()) {
      assert.equal((await call("POST", "/v1/spaces", owner, { name, title: "Costly documents", document: true })).status, 201);
      const posted = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "version", body: `## Status\n\n${"Done, and checked. ".repeat(10 * (i + 1))}` });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
    }
  });

  test("token_budget=1 gives one item, the rest named in not_included in order, and tokens_estimated is what the items cost", async () => {
    const asked = [...names, "costly-docs-none"];
    const cut = await call("GET", `/v1/documents?spaces=${asked.join(",")}&section=status&token_budget=1`, owner);
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    assert.equal(cut.body.items.length, 1);
    assert.deepEqual(cut.body.not_included, asked.slice(1));
    assert.equal(cut.body.budget_cut, true);
    assert.equal(cut.body.tokens_estimated, itemCost(cut.body.items[0]));
    const whole = await call("GET", `/v1/documents?spaces=${asked.join(",")}&section=status`, owner);
    assert.equal(whole.body.items.length, 4);
    assert.deepEqual(whole.body.not_included, []);
    assert.equal(whole.body.tokens_estimated, whole.body.items.reduce((sum: number, item: unknown) => sum + itemCost(item), 0));
    // A budget that pays for the first two and not the third stops at the third.
    const two = itemCost(whole.body.items[0]) + itemCost(whole.body.items[1]);
    const some = await call("GET", `/v1/documents?spaces=${asked.join(",")}&section=status&token_budget=${two}`, owner);
    assert.deepEqual(some.body.items.map((i: { space: string }) => i.space), asked.slice(0, 2));
    assert.deepEqual(some.body.not_included, asked.slice(2));
  });

  test("a call spends one read for every five SPACES named, rounded up: 1, 5, 6 and 20 names", async () => {
    const reader = await agent({ on: app });
    for (const [count, reads] of [[1, 1], [5, 1], [6, 2], [20, 4]] as const) {
      resetReadWindows();
      const spaces = Array.from({ length: count }, (_, i) => `spent-${i}`).join(",");
      const out = await call("GET", `/v1/documents?spaces=${spaces}&section=status`, reader);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(readsCounted(`peer:${reader.peerId}`), reads, `${count} names spent ${readsCounted(`peer:${reader.peerId}`)} reads`);
    }
  });

  test("the connector's read with spaces spends the same", async () => {
    const reader = await agent({ on: app });
    for (const [count, reads] of [[1, 1], [5, 1], [6, 2], [20, 4]] as const) {
      resetReadWindows();
      const spaces = Array.from({ length: count }, (_, i) => `spent-${i}`);
      const { message } = await connector("tools/call", { name: "schellingaf_oracle", arguments: { action: "read", spaces, section: "status" } }, reader.token, app);
      assert.notEqual(message.result.isError, true, message.result.content?.[0]?.text);
      assert.equal(readsCounted(`peer:${reader.peerId}`), reads, `${count} names spent ${readsCounted(`peer:${reader.peerId}`)} reads through the connector`);
    }
  });
});
