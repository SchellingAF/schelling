// The privacy rules, checked in the database. Every assertion below runs as the
// role the service actually uses, against a database built from the migrations on
// disk.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { MIGRATE_PASSWORD, PORT } from "./bootstrap.ts";
import { migrate, statementsOf } from "../src/db/migrate.ts";
import { publicSeekablePerDay } from "../src/http/postview.ts";
import { ORACLE_LIMITS } from "../src/surface/vocabulary.ts";
import { WAITING_REQUESTS_PER_KEY } from "../src/http/messages.ts";
import { fillPending, forget, pendingPages, SEARCH_INDEXES } from "./lib/pending.ts";

let fixture: Fixture;

const opened = setUp(async () => {
  fixture = await cloneDatabase("schema");
});
after(async () => {
  await opened;
  await fixture.end();
});

describe("catalog guards", () => {
  test("row-level security is on every space-scoped table except the public ones", async () => {
    const rows = await fixture.owner<{ relname: string; rls: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'schellingaf' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'space_id')
       order by 1`;
    const off = rows.filter((r) => !r.rls).map((r) => r.relname);
    // spaces is a public profile; withheld and withheld_spaces are the public
    // record of interventions — the fact and the time, never the reason or the
    // note, which the api role is not granted. space_categories holds what a
    // SPACE's profile already says in public, its name and its categories, once
    // for each category it is filed under.
    assert.deepEqual(off, ["space_categories", "spaces", "withheld", "withheld_spaces"]);
    assert.equal(rows.some((r) => r.force), false, "FORCE would break the owner-run functions");
  });

  test("the api role cannot bypass row-level security", async () => {
    const [row] = await fixture.owner<{ rolbypassrls: boolean }[]>`
      select rolbypassrls from pg_roles where rolname = 'schellingaf_api'`;
    assert.equal(row?.rolbypassrls, false);
  });

  test("the one read projection runs as the invoker", async () => {
    const [row] = await fixture.owner<{ reloptions: string[] | null }[]>`
      select reloptions from pg_class where relname = 'visible_posts'`;
    assert.ok(row?.reloptions?.includes("security_invoker=true"));
  });

  test("no function in the schema is world-executable", async () => {
    const rows = await fixture.owner<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf'
         and array_to_string(coalesce(p.proacl, '{}'), ',') ~ '(^|,)=X/'`;
    assert.deepEqual(rows.map((r) => r.proname), []);
  });

  test("the grant core and the revision bump stay internal", async () => {
    for (const signature of [
      "schellingaf.set_membership(text,bytea,bytea,text,text[],text,uuid)",
      "schellingaf.bump_revision(uuid,bytea,text,jsonb)",
    ]) {
      const [row] = await fixture.owner<{ ok: boolean }[]>`
        select has_function_privilege('schellingaf_api', ${signature}, 'execute') as ok`;
      assert.equal(row?.ok, false, `${signature} must not be callable by the api role`);
    }
  });

  test("every function a policy names is executable by the api role", async () => {
    // A policy runs with the querying role's privileges, so a policy that calls
    // a function the api role cannot execute fails every read on day one.
    //
    // Read inside a transaction that pins search_path to pg_catalog alone,
    // because pg_policies.qual is DEPARSED against the querying session's search
    // path: with schellingaf on it the calls come back as `is_member(...)`, the
    // pattern below matches nothing, and the test passes proving nothing.
    const rows = await fixture.owner.begin(async (tx) => {
      await tx`set local search_path = pg_catalog`;
      return tx<{ fn: string }[]>`
        select distinct m.f[1] as fn
          from pg_policies p,
               lateral regexp_matches(coalesce(p.qual, ''), 'schellingaf\\.(\\w+)\\(', 'g') as m(f)
         where p.schemaname = 'schellingaf'`;
    }) as unknown as { fn: string }[];
    assert.ok(rows.length > 0, "expected the policies to call at least one function");
    for (const { fn } of rows) {
      const [row] = await fixture.owner<{ ok: boolean }[]>`
        select bool_or(has_function_privilege('schellingaf_api', p.oid, 'execute')) as ok
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'schellingaf' and p.proname = ${fn}`;
      assert.equal(row?.ok, true, `policies call ${fn}, which the api role cannot execute`);
    }
  });

  test("the columns that would leak a private space are not granted", async () => {
    const forbidden: [string, string][] = [
      ["spaces", "last_seq"],
      ["spaces", "revision"],
      ["spaces", "updated_at"],
      ["withheld", "note"],
      ["peers", "blocked_reason"],
      ["service_epochs", "details"],
      ["invites", "code_hash"],
      // Who blocked a KEY or hid a post is in the SPACE's events, readable by its
      // members; the tables' revision is a private SPACE's counter.
      ["space_blocks", "blocked_by"],
      ["space_blocks", "revision"],
      ["space_hidden", "hidden_by"],
      ["space_hidden", "revision"],
    ];
    for (const [table, column] of forbidden) {
      const [row] = await fixture.owner<{ ok: boolean }[]>`
        select has_column_privilege('schellingaf_api', ${"schellingaf." + table}, ${column}, 'select') as ok`;
      assert.equal(row?.ok, false, `${table}.${column} is readable by the api role`);
    }
    const [search] = await fixture.owner<{ ok: boolean }[]>`
      select has_table_privilege('schellingaf_api', 'schellingaf.post_search', 'select') as ok`;
    assert.equal(search?.ok, false, "text search must go through seek_text()");
  });

  test("no authorisation decision reads a tag", async () => {
    // A field named like an authority grants none, checked by machine.
    const rows = await fixture.owner<{ qual: string | null }[]>`
      select qual from pg_policies where schemaname = 'schellingaf'`;
    for (const { qual } of rows) {
      assert.equal(/\btags\b/.test(qual ?? ""), false, `a policy reads tags: ${qual}`);
    }
    // Every helper that decides who reads, governs or admits, or whom a keeper may trust.
    // Read through pg_get_functiondef: prosrc is empty for a SQL-standard body, which most
    // of them have, and a guard reading it would pass whatever they read.
    const predicates = [
      "caller_space_ids", "governed_space_ids", "admitting_space_ids", "caller_seat_ids",
      "can_read_space", "can_govern_space", "can_admit_space",
      "caller_in_space", "space_is_public", "role_rank", "rank_in_space", "seat_now",
      "may_take_back", "can_read_message", "caller_conversation_ids", "is_keeper",
      "sealed_vouched", "sealed_vouching", "sealed_members", "knows_key",
    ];
    const preds = await fixture.owner<{ name: string; def: string }[]>`
      select p.proname as name, pg_get_functiondef(p.oid) as def
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf' and p.proname = any(${predicates})`;
    assert.equal(preds.length, predicates.length, "a predicate helper is missing or renamed");
    for (const { name, def } of preds) {
      assert.equal(/\btags\b/.test(def), false, `${name} reads tags`);
    }
  });
});

describe("the caller predicate", () => {
  const keyA = publicKey("owner-a");
  const keyB = publicKey("member-b");
  const keyC = publicKey("outsider-c");
  const A = peerIdOf(keyA);
  const B = peerIdOf(keyB);
  const C = peerIdOf(keyC);

  before(async () => {
    for (const k of [keyA, keyB, keyC]) {
      await fixture.owner`select schellingaf.register_peer(${k})`;
    }
    await fixture.owner`select schellingaf.create_space(${keyIdBuf(A)}, 'linux-repro', 'Reproducing a build failure')`;
    await fixture.owner`select schellingaf.grant_membership('linux-repro', ${keyIdBuf(A)}, ${keyIdBuf(B)}, 'writer', ${fixture.owner.array(["lead"])})`;
    await fixture.owner`
      select schellingaf.append_post('linux-repro', ${keyIdBuf(A)}, 'result',
        'Pinned numpy fixes the build',
        'Downgrading to numpy 1.26.4 makes the wheel build succeed on aarch64.',
        null, null, ${fixture.owner.array([keyIdBuf(B)])}::bytea[], null, null, null, null,
        '[{"scheme":"package.version","value":"numpy@1.26.4"}]'::jsonb, null)`;
  });

  test("an outsider reads nothing, and neither does a caller that was never bound", async () => {
    const noCaller = await fixture.api<{ n: number }[]>`select count(*)::int as n from schellingaf.posts`;
    assert.equal(noCaller[0]?.n, 0, "a query with no caller bound must return nothing");

    for (const [who, id, expected] of [
      ["owner", A, 1],
      ["member", B, 1],
      ["outsider", C, 0],
      ["anonymous", null, 0],
    ] as const) {
      const rows = await fixture.asCaller(id, (sql) => sql<{ n: number }[]>`
        select count(*)::int as n from schellingaf.posts`);
      assert.equal(rows[0]?.n, expected, `${who} saw the wrong number of posts`);
    }
  });

  test("an outsider sees no membership, event or fingerprint either", async () => {
    for (const table of ["memberships", "space_events", "post_fingerprints"]) {
      const rows = await fixture.asCaller(C, (sql) =>
        sql.unsafe(`select count(*)::int as n from schellingaf.${table}`));
      assert.equal((rows as unknown as { n: number }[])[0]?.n, 0, `outsider saw rows in ${table}`);
    }
  });

  test("a mailbox is private even from someone in the same space", async () => {
    const mine = await fixture.asCaller(B, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.mailbox_deliveries`);
    assert.equal(mine[0]?.n, 1, "B should see the delivery addressed to B");

    const theirs = await fixture.asCaller(A, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.mailbox_deliveries`);
    assert.equal(theirs[0]?.n, 0, "A must not see B's deliveries");
  });

  test("counters reach a reader and nobody else", async () => {
    const reader = await fixture.asCaller(B, (sql) => sql<{ head_seq: string | null }[]>`
      select h.head_seq::text from schellingaf.spaces s
        left join lateral schellingaf.space_heads(s.space_id) h on true
       where s.name = 'linux-repro'`);
    assert.equal(reader[0]?.head_seq, "1");

    const stranger = await fixture.asCaller(C, (sql) => sql<{ head_seq: string | null }[]>`
      select h.head_seq::text from schellingaf.spaces s
        left join lateral schellingaf.space_heads(s.space_id) h on true
       where s.name = 'linux-repro'`);
    assert.equal(stranger[0]?.head_seq, null, "a stranger must not learn how busy a space is");
  });

  test("contacts are public, because a stranger has to be able to ask", async () => {
    const rows = await fixture.asCaller(C, (sql) => sql<{ role: string }[]>`
      select c.role from schellingaf.spaces s,
             lateral schellingaf.space_contacts(s.space_id) c
       where s.name = 'linux-repro'`);
    assert.deepEqual(rows.map((r) => r.role), ["owner"]);
  });
});

describe("write function behaviour", () => {
  test("the content hash ignores the difference between absent, null and empty", async () => {
    const k = publicKey("hash-author");
    await fixture.owner`select schellingaf.register_peer(${k})`;
    const id = keyIdBuf(peerIdOf(k));
    await fixture.owner`select schellingaf.create_space(${id}, 'hash-space', 'Hashing')`;

    const hashes: string[] = [];
    for (const body of [null, ""] as const) {
      const [appended] = await fixture.owner<{ receipt: { post_id: string } }[]>`
        select schellingaf.append_post('hash-space', ${id}, 'obs', null, ${body},
          null, null, null, null, null, null, null, null, null) as receipt`;
      const [row] = await fixture.owner<{ h: string }[]>`
        select encode(content_hash, 'hex') as h from schellingaf.posts
         where post_id = ${appended!.receipt.post_id}::uuid`;
      hashes.push(row!.h);
    }
    assert.equal(hashes[0], hashes[1], "a null body and an empty body must hash the same");
  });

  test("a reader is refused a write, and the refusal says how to get in", async () => {
    const owner = publicKey("wd-owner");
    const reader = publicKey("wd-reader");
    await fixture.owner`select schellingaf.register_peer(${owner})`;
    await fixture.owner`select schellingaf.register_peer(${reader})`;
    const oid = keyIdBuf(peerIdOf(owner));
    const rid = keyIdBuf(peerIdOf(reader));
    await fixture.owner`select schellingaf.create_space(${oid}, 'wd-space', 'Write denied')`;
    await fixture.owner`select schellingaf.grant_membership('wd-space', ${oid}, ${rid}, 'reader', null)`;

    await assert.rejects(
      () => fixture.owner`select schellingaf.append_post('wd-space', ${rid}, 'obs', null, 'nope',
        null, null, null, null, null, null, null, null, null)`,
      (error: { message: string; detail?: string }) => {
        assert.match(error.message, /WRITE_DENIED/);
        assert.match(String(error.detail), /"role": ?"reader"/);
        return true;
      },
    );
  });

  test("a tagged reader is still a reader", async () => {
    // The tag says lead. It grants nothing, and this is the test that
    // says so in behaviour rather than in a comment.
    const owner = publicKey("tag-owner");
    const reader = publicKey("tag-reader");
    await fixture.owner`select schellingaf.register_peer(${owner})`;
    await fixture.owner`select schellingaf.register_peer(${reader})`;
    const oid = keyIdBuf(peerIdOf(owner));
    const rid = keyIdBuf(peerIdOf(reader));
    await fixture.owner`select schellingaf.create_space(${oid}, 'tag-space', 'Tags grant nothing')`;
    await fixture.owner`select schellingaf.grant_membership('tag-space', ${oid}, ${rid}, 'reader',
      ${fixture.owner.array(["lead"])})`;

    await assert.rejects(
      () => fixture.owner`select schellingaf.append_post('tag-space', ${rid}, 'obs', null, 'nope',
        null, null, null, null, null, null, null, null, null)`,
      /WRITE_DENIED/,
    );
  });

  test("an admin cannot touch another admin, and nobody can modify themselves", async () => {
    const owner = publicKey("rank-owner");
    const m1 = publicKey("rank-admin-1");
    const m2 = publicKey("rank-admin-2");
    for (const k of [owner, m1, m2]) await fixture.owner`select schellingaf.register_peer(${k})`;
    const oid = keyIdBuf(peerIdOf(owner));
    const a1 = keyIdBuf(peerIdOf(m1));
    const a2 = keyIdBuf(peerIdOf(m2));
    await fixture.owner`select schellingaf.create_space(${oid}, 'rank-space', 'The rank rule')`;
    await fixture.owner`select schellingaf.grant_membership('rank-space', ${oid}, ${a1}, 'admin', null)`;
    await fixture.owner`select schellingaf.grant_membership('rank-space', ${oid}, ${a2}, 'admin', null)`;

    await assert.rejects(
      () => fixture.owner`select schellingaf.grant_membership('rank-space', ${a1}, ${a2}, 'writer', null)`,
      /CONTROL_DENIED/,
      "an admin must not be able to demote another admin",
    );
    await assert.rejects(
      () => fixture.owner`select schellingaf.grant_membership('rank-space', ${a1}, ${a1}, 'reader', null)`,
      /CONTROL_DENIED/,
      "self-modification must be denied",
    );
    await assert.rejects(
      () => fixture.owner`select schellingaf.grant_membership('rank-space', ${a1}, ${oid}, 'reader', null)`,
      /OWNER_IS_NOT_A_MEMBER/,
    );
  });

  test("a stranger cannot spend more than half of another KEY's SPACE allowance", async () => {
    // A KEY belongs to a limited number of SPACES, owned plus member, and that
    // cap is what keeps caller_space_ids() cheap enough to hash once per
    // statement. It is the KEY's own resource. A grant requires nothing of its
    // target but a peer id, and peer ids are public, so without a ceiling of their
    // own, grants from throwaway KEYS could fill the whole allowance and leave the
    // target unable to create a SPACE or to be admitted to one, even by an honest
    // governor approving its own ask.
    const attackerKey = publicKey("cap-attacker");
    const victimKey = publicKey("cap-victim");
    const hostKey = publicKey("cap-host");
    for (const k of [attackerKey, victimKey, hostKey]) {
      await fixture.owner`select schellingaf.register_peer(${k})`;
    }
    const attacker = keyIdBuf(peerIdOf(attackerKey));
    const victim = keyIdBuf(peerIdOf(victimKey));
    const host = keyIdBuf(peerIdOf(hostKey));

    // The limits as the database holds them (cap()): the split between them is
    // what this test is about.
    const [caps] = await fixture.owner<{ grants: number; spaces: number }[]>`
      select schellingaf.cap('granted_spaces_per_key')::int as grants,
             schellingaf.cap('spaces_per_key')::int as spaces`;
    const grants = caps!.grants;
    assert.ok(grants * 2 <= caps!.spaces, "grants may take at most half of a KEY's SPACES");

    // The junk spaces, and every grant but the last few, written straight in: a
    // create_space and a grant call for each would test the write path thousands
    // of times over, and this test is about the cap.
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description)
      select 'junk-' || lpad(g::text, 5, '0'), ${attacker}, 'Junk ' || g, 'filler'
        from generate_series(1, ${grants + 3}) g`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select sp.space_id, ${victim}, 'reader', 'grant', ${attacker}, 1
        from schellingaf.spaces sp
       where sp.owner_id = ${attacker} and sp.name <= ${`junk-${String(grants - 1).padStart(5, "0")}`}`;

    let granted = grants - 1;
    const refusals = new Set<string>();
    for (let g = grants; g <= grants + 3; g++) {
      const name = `junk-${String(g).padStart(5, "0")}`;
      try {
        await fixture.owner`select schellingaf.grant_membership(${name}, ${attacker}, ${victim}, 'reader', null)`;
        granted++;
      } catch (error) {
        refusals.add(String((error as Error).message).trim());
      }
    }

    assert.equal(granted, grants, "a stranger took a different number of the victim's slots");
    assert.deepEqual([...refusals], ["SPACE_LIMIT"], "the grant past the ceiling was refused for the wrong reason");

    // What the victim keeps: grants have a ceiling of their own, so none of these
    // meets SPACE_LIMIT.
    await fixture.owner`select schellingaf.create_space(${victim}, 'still-mine', 'A SPACE of my own')`;

    await fixture.owner`select schellingaf.create_space(${host}, 'open-house', 'Asking still works')`;
    const [asked] = await fixture.owner<{ joined: { request_id: string } }[]>`
      select schellingaf.join_space('open-house', ${victim}, null, 'may I') as joined`;
    await fixture.owner`
      select schellingaf.decide_request(${asked!.joined.request_id}::uuid, ${host}, 'approve', 'reader', null)`;

    const [counts] = await fixture.owner<{ total: number; unconsented: number }[]>`
      select count(*)::int as total,
             count(*) filter (where mm.via = 'grant')::int as unconsented
        from schellingaf.memberships mm where mm.peer_id = ${victim}`;
    assert.equal(counts!.unconsented, grants, "the grant ceiling did not hold");
    assert.equal(counts!.total, grants + 1, "the victim's own admission did not go through");
  });

  test("the token bucket refills, denies without debiting, and says how long to wait", async () => {
    // The bucket refills with wall-clock time, so every balance is "about". A token
    // every hundred seconds keeps "about" within 0.05 for five seconds between calls,
    // which a busy machine takes and a token a second did not allow.
    const REFILL = 0.01;
    const near = (actual: number, expected: number, what: string) =>
      assert.ok(Math.abs(actual - expected) < 0.05, `${what}: ${actual} is not about ${expected}`);

    const first = await bucket("peer:x", 10, REFILL, 4);
    assert.equal(first.allowed, true);
    near(Number(first.tokens), 6, "after one call of cost 4");

    const second = await bucket("peer:x", 10, REFILL, 4);
    assert.equal(second.allowed, true);
    near(Number(second.tokens), 2, "after two calls of cost 4");

    const denied = await bucket("peer:x", 10, REFILL, 4);
    assert.equal(denied.allowed, false);
    assert.ok(Number(denied.tokens) >= 2, "a denied call must not debit the bucket");
    // Two tokens short, at a token every hundred seconds: two hundred, less what refilled.
    assert.ok(denied.retry_after_s >= 195 && denied.retry_after_s <= 200, `told to wait ${denied.retry_after_s} s`);

    const free = await bucket("peer:x", 10, REFILL, 0);
    assert.equal(free.allowed, true, "a zero-cost read reports the balance without spending it");
  });

  async function bucket(key: string, cap: number, refill: number, cost: number) {
    const [row] = await fixture.owner<{ take: { allowed: boolean; tokens: string; retry_after_s: number } }[]>`
      select schellingaf.take_tokens(${key}, ${cap}, ${refill}, ${cost}) as take`;
    return row!.take;
  }
});

function keyIdBuf(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

describe("a blocked KEY can do nothing that writes", () => {
  // `peers.blocked_at` is the operator's one lever against an abusive KEY, and
  // it only works if every write function honours it: a token minted before the
  // block stays valid for up to ninety days, so the block has to bite inside
  // the database rather than only at the door. runbooks/withhold.md states the
  // rule.
  //
  // A test that names functions one at a time misses the one nobody named, so
  // this reads the catalog instead: every function the api role may execute
  // that writes is required to test blocked_at, and the next one that forgets
  // fails here.
  test("every api-executable write function tests blocked_at", async () => {
    // pg_get_functiondef, never prosrc, which is empty for a SQL-standard body: a write
    // in one would go unseen.
    const functions = await fixture.owner<{ name: string; body: string }[]>`
      select p.proname as name, pg_get_functiondef(p.oid) as body
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf'
         and p.prosecdef
         and has_function_privilege('schellingaf_api', p.oid, 'execute')`;
    assert.ok(functions.length >= 10, `only ${functions.length} definer functions found`);

    // A function writes if its body contains a statement that changes a row.
    const writes = functions.filter((f) => /\b(INSERT|UPDATE|DELETE)\b/i.test(f.body));
    assert.ok(writes.length >= 8, `only ${writes.length} write functions found`);

    // The write functions that do not check, each with a reason that is not
    // "nobody thought of it". Named here so the exemption is a decision on the
    // record rather than a hole the guard happens not to cover.
    const EXEMPT: Record<string, string> = {
      // Housekeeping. src/db/prune.ts calls it at boot and hourly under an
      // advisory lock; no route exposes it, so no peer can reach it either.
      prune_rate_buckets: "not reachable by a caller",
      // The same job, for tokens dead ninety days.
      prune_tokens: "not reachable by a caller",
      // The service's own signatures. src/db/checkpoints.ts and
      // src/http/service.ts call them with the service's key; no route takes a
      // caller's input into either, and a checkpoint is the service speaking,
      // not a KEY, so there is no KEY to have been blocked.
      register_service_key: "the service acting for itself, never for a KEY",
      insert_checkpoint: "the service acting for itself, never for a KEY",
      // And for direct messages past their sender's retention. Deleting on
      // schedule is a promise to the sender, blocked or not.
      prune_messages: "not reachable by a caller",
      // Requests to connect an app, and apps that never got a token.
      prune_oauth: "not reachable by a caller",
      // Files no post attached, once their uploads are a day old.
      prune_files: "not reachable by a caller",
      // An upload: its first statement is check_file_upload(), which tests blocked_at,
      // the rule the route and the posts route meet too.
      put_file: "blocked is tested by check_file_upload, which it calls first",
      // Where a PEER row first comes into existence. The block is tested at
      // /v1/keys/verify before this is called, and the insert is ON CONFLICT DO
      // NOTHING, so calling it again can neither unblock nor duplicate.
      register_peer: "blocked is checked at the door, and re-registering changes nothing",
      // The rate limiter itself. Debiting a bucket is not a governance act, and
      // a blocked KEY that could not debit would simply be refused later with
      // the wrong error.
      take_tokens: "a bucket debit is not a governance write",
      // The same, for the debit that runs AFTER a write the service has already
      // accepted. It cannot refuse and must not: it exists to make the bucket
      // remember a burst it could not afford.
      charge_tokens: "a bucket debit is not a governance write",
    };

    const careless = writes
      .filter((f) => !/blocked_at/.test(f.body))
      .map((f) => f.name)
      .filter((name) => !(name in EXEMPT))
      .sort();
    assert.deepEqual(
      careless,
      [],
      `these write functions do not check blocked_at, so a blocked KEY can still call them: ${careless.join(", ")}`,
    );
  });
});

describe("the search index's pending lists", () => {
  // gin_clean_pending_list needs the index's owner, so the service empties the lists
  // through one definer function rather than holding ownership or MAINTAIN, which
  // would also let it lock and rebuild the table. src/db/search-upkeep.ts calls it.
  test("the api role empties both through clean_search_index, and through nothing wider", async () => {
    const rows = await fillPending(fixture.name, 400);
    try {
      const full = await pendingPages(fixture.name);
      for (const index of SEARCH_INDEXES) assert.ok(full[index]! > 0, `${index} has no pending list to empty`);

      const [first] = await fixture.api<{ pages: number }[]>`select schellingaf.clean_search_index()::int as pages`;
      assert.equal(first!.pages, full.post_search_gin! + full.post_search_seekable_gin!);
      assert.deepEqual(await pendingPages(fixture.name), { post_search_gin: 0, post_search_seekable_gin: 0 });
      const [again] = await fixture.api<{ pages: number }[]>`select schellingaf.clean_search_index()::int as pages`;
      assert.equal(again!.pages, 0, "an empty list was flushed again");

      await assert.rejects(
        fixture.api`select gin_clean_pending_list('schellingaf.post_search_gin'::regclass)`,
        /must be owner/,
        "the api role may flush an index of its own accord, so it owns more than this function",
      );
    } finally {
      await forget(fixture.name, rows);
    }
  });
});

describe("append-only records", () => {
  test("an append-only record refuses change, even from the owning role", async () => {
    // A SPACE with a hidden post carrying a fingerprint and a recipient, a KEY blocked
    // from posting there with an encryption key of its own, and one of each of the
    // service's key, checkpoint and recovery notice: a row in every table below, made
    // by the function the service calls wherever one makes it.
    const ownerKey = publicKey("record-owner");
    const writerKey = publicKey("record-writer");
    for (const k of [ownerKey, writerKey]) await fixture.owner`select schellingaf.register_peer(${k})`;
    const owner = keyIdBuf(peerIdOf(ownerKey));
    const writer = keyIdBuf(peerIdOf(writerKey));
    await fixture.owner`select schellingaf.create_space(${owner}, 'records', 'Records that never change')`;
    await fixture.owner`select schellingaf.grant_membership('records', ${owner}, ${writer}, 'writer', null)`;
    const [post] = await fixture.owner<{ r: { post_id: string } }[]>`
      select schellingaf.append_post('records', ${writer}, 'result', 'Recorded', 'once',
        null, null, ${fixture.owner.array([owner])}::bytea[], null, null, null, null,
        '[{"scheme":"git.commit","value":"b75e527"}]'::jsonb, null) as r`;
    await fixture.owner`select schellingaf.set_post_hidden(${post!.r.post_id}::uuid, ${owner}, true)`;
    await fixture.owner`select schellingaf.set_space_block('records', ${owner}, ${writer}, true)`;
    await fixture.owner`select schellingaf.register_encryption_key(${writer}, ${Buffer.alloc(32, 1)},
      ${Buffer.alloc(64, 2)}, ${fixture.owner.json({ alg: "ed25519", signature: "not checked here" })})`;
    const [serviceKey] = await fixture.owner<{ id: Buffer }[]>`
      select schellingaf.register_service_key(${Buffer.alloc(32, 3)}, ${Buffer.alloc(32, 4)},
        ${Buffer.from("a certificate")}, ${Buffer.alloc(64, 5)}, true) as id`;
    const [notice] = await fixture.owner<{ id: Buffer }[]>`
      select schellingaf.record_recovery_notice(
        convert_to(jsonb_build_object('service_epoch', (select epoch from schellingaf.service_epochs limit 1))::text, 'UTF8'),
        ${Buffer.alloc(64, 6)}, ${serviceKey!.id}) as id`;
    const [space] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = 'records'`;
    // Written straight in: the database's own checks on a checkpoint are not this test's.
    await fixture.owner`
      insert into schellingaf.space_checkpoints (checkpoint_id, space_id, stream, first_position, last_position,
        predecessor_hash, ending_hash, merkle_root, service_epoch, signer_key_id, canonical, signature, created_at)
      select sha256(schellingaf.domain_bytes('agent-state:checkpoint:v1') || c.canonical), o.space_id, 'posts', 1, 1,
             o.previous_hash, o.chain_hash, o.chain_hash, (select epoch from schellingaf.service_epochs limit 1),
             ${serviceKey!.id}, c.canonical, ${Buffer.alloc(64, 7)}, now()
        from schellingaf.post_objects o, (select convert_to('a checkpoint', 'UTF8') as canonical) c
       where o.space_id = ${space!.id}::uuid and o.seq = 1`;

    // Each table, a column an UPDATE sets to itself, the rows of the scene, and whether a
    // DELETE is refused too.
    const records: [table: string, column: string, key: string, value: string | Buffer, deletes: boolean][] = [
      ["posts", "seq", "space_id", space!.id, true],
      ["post_fingerprints", "value", "space_id", space!.id, true],
      ["post_objects", "seq", "space_id", space!.id, true],
      ["space_events", "revision", "space_id", space!.id, true],
      ["space_event_objects", "revision", "space_id", space!.id, true],
      ["mailbox_deliveries", "mailbox_seq", "space_id", space!.id, true],
      ["space_checkpoints", "last_position", "space_id", space!.id, true],
      ["service_keys", "development", "key_id", serviceKey!.id, true],
      ["recovery_notices", "created_at", "notice_id", notice!.id, true],
      ["encryption_keys", "kem", "peer_id", writer, true],
      // Lifting a block and showing a post again delete the row; nothing changes one.
      ["space_blocks", "revision", "space_id", space!.id, false],
      ["space_hidden", "revision", "space_id", space!.id, false],
    ];
    for (const [table, column, key, value, deletes] of records) {
      await assert.rejects(
        fixture.owner.unsafe(`update schellingaf.${table} set ${column} = ${column} where ${key} = $1`, [value]),
        /IMMUTABLE_RECORD/,
        `${table} took an UPDATE`,
      );
      if (!deletes) continue;
      await assert.rejects(
        fixture.owner.unsafe(`delete from schellingaf.${table} where ${key} = $1`, [value]),
        /IMMUTABLE_RECORD/,
        `${table} took a DELETE`,
      );
    }

    // Two that change in one narrow way, and refuse every other change: a KEY, whose id,
    // key and kind never change, and a join request, of which only a pending one's
    // state and decision do.
    const ask = async (label: string): Promise<string> => {
      const k = publicKey(label);
      await fixture.owner`select schellingaf.register_peer(${k})`;
      const [asked] = await fixture.owner<{ r: { request_id: string } }[]>`
        select schellingaf.join_space('records', ${keyIdBuf(peerIdOf(k))}, null, 'let me in') as r`;
      return asked!.r.request_id;
    };
    const pending = await ask("record-asker");
    const declined = await ask("record-declined");
    await fixture.owner`select schellingaf.decide_request(${declined}::uuid, ${owner}, 'decline')`;
    const narrow: [change: string, statement: string, value: string | Buffer][] = [
      ["a KEY deleted", "delete from schellingaf.peers where peer_id = $1", writer],
      ["a KEY's id changed", "update schellingaf.peers set peer_id = sha256(peer_id) where peer_id = $1", writer],
      ["a KEY's key changed", "update schellingaf.peers set public_key = sha256(public_key) where peer_id = $1", writer],
      ["a KEY's kind changed", "update schellingaf.peers set key_type = 'passkey' where peer_id = $1", writer],
      ["a request deleted", "delete from schellingaf.join_requests where request_id = $1", pending],
      ["a pending request's words changed", "update schellingaf.join_requests set message = 'other words' where request_id = $1", pending],
      ["a decided request reopened", "update schellingaf.join_requests set state = 'pending' where request_id = $1", declined],
    ];
    for (const [change, statement, value] of narrow) {
      await assert.rejects(fixture.owner.unsafe(statement, [value]), /IMMUTABLE_RECORD/, `${change}, and it was taken`);
    }

    // A SPACE that has been replaced stays replaced by that SPACE: re-pointed or
    // cleared, it would send a reader following it somewhere else.
    await fixture.owner`select schellingaf.recover_space('records', 'records-continued', 'the chain lost links')`;
    for (const to of ["null", "space_id"]) {
      await assert.rejects(
        fixture.owner.unsafe(`update schellingaf.spaces set replaced_by = ${to} where name = 'records'`),
        /IMMUTABLE_RECORD/,
        `a replaced SPACE's replaced_by became ${to}`,
      );
    }
  });
});

describe("the migration runner", () => {
  const runMigrations = () =>
    migrate({
      host: "127.0.0.1",
      port: PORT,
      database: fixture.name,
      username: "schellingaf_migrate",
      password: MIGRATE_PASSWORD,
      max: 1,
      onnotice: () => {},
    });

  test("refuses a database built from migrations the files on disk replaced", async () => {
    // A ledger version below the first file on disk: the files would build the schema a
    // second time on top of that database, so nothing here can carry it forward.
    await fixture.owner`insert into schellingaf.schema_migrations (version, name, sha256) values (1, 'core', 'retired')`;
    try {
      await assert.rejects(
        runMigrations(),
        /built from migrations that are no longer in migrations\/ \(versions 1\): rebuild it/,
      );
    } finally {
      await fixture.owner`delete from schellingaf.schema_migrations where version = 1`;
    }
  });

  test("runs a no-transaction file one statement at a time, and again from the start after it stopped", async () => {
    assert.deepEqual(
      statementsOf("-- migrate: no-transaction\n-- A comment; and one more.\nDROP INDEX CONCURRENTLY IF EXISTS a;\nCREATE INDEX CONCURRENTLY a\n  ON t (x);\n\n-- the end\n"),
      ["-- migrate: no-transaction\n-- A comment; and one more.\nDROP INDEX CONCURRENTLY IF EXISTS a", "CREATE INDEX CONCURRENTLY a\n  ON t (x)"],
    );
    assert.throws(() => statementsOf("-- migrate: no-transaction\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$;\n"), /no function body/);
    // 0126 builds its indexes concurrently. Unrecorded, as a run that stopped part way
    // leaves it, it runs again and leaves every index valid.
    const built = async () => [...await fixture.owner<{ name: string; valid: boolean }[]>`
      select c.relname as name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in ('posts_space_posted_idx', 'space_hidden_space_post_idx', 'withheld_space_post_idx',
                           'spaces_name_c_idx', 'space_categories_name_c_idx') order by 1`];
    const all = [
      { name: "posts_space_posted_idx", valid: true }, { name: "space_categories_name_c_idx", valid: true },
      { name: "space_hidden_space_post_idx", valid: true }, { name: "spaces_name_c_idx", valid: true },
      { name: "withheld_space_post_idx", valid: true },
    ];
    assert.deepEqual(await built(), all);
    const [row] = await fixture.owner<{ name: string; sha256: string }[]>`
      select name, sha256 from schellingaf.schema_migrations where version = 126`;
    await fixture.owner`delete from schellingaf.schema_migrations where version = 126`;
    try {
      const result = await runMigrations();
      assert.deepEqual(result.applied.map((m) => m.file), ["0126_space_stages_indexes.sql"]);
    } finally {
      await fixture.owner`
        insert into schellingaf.schema_migrations (version, name, sha256) values (126, ${row!.name}, ${row!.sha256})
        on conflict (version) do nothing`;
    }
    assert.deepEqual(await built(), all);
  });

  test("starts on a database a later release migrated, as a rolled-back release must", async () => {
    // A ledger version above every file on disk: the database is ahead of this checkout,
    // not from another history, and rebuilding it would destroy what it holds.
    await fixture.owner`insert into schellingaf.schema_migrations (version, name, sha256) values (9999, 'later', 'a later release')`;
    try {
      const result = await runMigrations();
      assert.deepEqual(result.applied, [], "every file on disk is applied already");
    } finally {
      await fixture.owner`delete from schellingaf.schema_migrations where version = 9999`;
    }
  });
});

describe("limits written in SQL and in TypeScript agree", () => {
  // Each of these is written twice: the route passes the TypeScript constant, and
  // the SQL function carries the same number as its default or as a literal. A
  // change to one without the other would leave the other path on a stale limit.
  test("append_post's defaults are the limits the route passes", async () => {
    const rows = await fixture.owner<{ args: string }[]>`
      select pg_get_function_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf' and p.proname = 'append_post'`;
    assert.equal(rows.length, 1, "append_post is not one function");
    const defaultOf = (name: string): number => {
      const found = rows[0]!.args.match(new RegExp(`\\b${name} integer DEFAULT (\\d+)`));
      assert.ok(found, `append_post has no integer default for ${name}`);
      return Number(found[1]);
    };
    const saved = process.env.PUBLIC_SEEKABLE_PER_DAY;
    delete process.env.PUBLIC_SEEKABLE_PER_DAY;
    try {
      assert.equal(defaultOf("p_public_seekable_per_day"), publicSeekablePerDay());
    } finally {
      if (saved !== undefined) process.env.PUBLIC_SEEKABLE_PER_DAY = saved;
    }
    assert.equal(defaultOf("p_pending_per_key"), ORACLE_LIMITS.waitingPerKey);
    assert.equal(defaultOf("p_pending_per_space"), ORACLE_LIMITS.waitingPerSpace);
  });

  test("make_room_for_request holds as many waiting requests as the route counts", async () => {
    const [row] = await fixture.owner<{ src: string }[]>`
      select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'schellingaf' and p.proname = 'make_room_for_request'`;
    const found = row?.src.match(/v_waiting < (\d+)/);
    assert.ok(found, "make_room_for_request no longer compares the waiting count to a number");
    assert.equal(Number(found[1]), WAITING_REQUESTS_PER_KEY);
  });
});
