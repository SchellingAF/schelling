// What each SPACE stores (migrations/0148_space_storage.sql): the counter of its shown
// posts' bytes, kept by triggers as posts are written, hidden and withheld; the backfill
// that fills it for the posts written before it; and the recount that corrects either
// counter, the files' total too, without losing a post written while it runs. The
// database is touched as the owner only to set a scene a route cannot, and to read the
// true sums the counter is held to.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { useService, fixture, db, config, call, agent, type Agent } from "./lib/service.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { recountStorage } from "../src/db/storage.ts";
import type { Db } from "../src/db/sql.ts";
import * as sealed from "../content/sealed.mjs";

useService("space_storage");

let n = 0;
const newName = () => `storage-${process.pid}-${n++}`;

async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<{ name: string; id: string }> {
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Storage", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { name, id: await spaceIdOf(name) };
}

async function spaceIdOf(name: string): Promise<string> {
  const [s] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return s!.id;
}

async function post(who: Agent, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "obs", body: `words ${randomUUID()}`, ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id;
}

async function writerIn(owner: Agent, name: string): Promise<Agent> {
  const w = await agent();
  const out = await call("PUT", `/v1/spaces/${name}/members/${w.peerId}`, owner.token, { role: "writer" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return w;
}

/** The counter, 0 when there is no row. */
async function counted(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`select post_bytes::text as b from schellingaf.space_storage where space_id = ${id}::uuid`;
  return Number(row?.b ?? 0);
}

/** The true sum, written out here rather than through the migration's functions. */
async function trueSum(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`
    select (coalesce((select sum(octet_length(o.canonical) + coalesce(octet_length(o.private), 0))
                        from schellingaf.post_objects o
                       where o.space_id = ${id}::uuid
                         and not exists (select 1 from schellingaf.space_hidden h where h.post_id = o.post_id)
                         and not exists (select 1 from schellingaf.withheld w where w.post_id = o.post_id and w.released_at is null)), 0)
          + coalesce((select sum(octet_length(s.header) + octet_length(s.ciphertext))
                        from schellingaf.sealed_posts s
                       where s.space_id = ${id}::uuid
                         and not exists (select 1 from schellingaf.space_hidden h where h.post_id = s.post_id)
                         and not exists (select 1 from schellingaf.withheld w where w.post_id = s.post_id and w.released_at is null)), 0))::text as b`;
  return Number(row!.b);
}

/** One post's object, canonical and private, and its sealed parts, as stored. */
async function postBytes(postId: string): Promise<{ object: number; privatePart: number; sealedPart: number }> {
  const [row] = await fixture.owner<{ object: number; private_part: number; sealed_part: number }[]>`
    select coalesce((select octet_length(o.canonical) from schellingaf.post_objects o where o.post_id = ${postId}::uuid), 0)::int as object,
           coalesce((select octet_length(o.private) from schellingaf.post_objects o where o.post_id = ${postId}::uuid), 0)::int as private_part,
           coalesce((select octet_length(s.header) + octet_length(s.ciphertext) from schellingaf.sealed_posts s where s.post_id = ${postId}::uuid), 0)::int as sealed_part`;
  return { object: row!.object, privatePart: row!.private_part, sealedPart: row!.sealed_part };
}

async function withhold(postId: string, id: string) {
  await fixture.owner`
    insert into schellingaf.withheld (post_id, space_id, reason, note) values (${postId}::uuid, ${id}::uuid, 'malware', 'a test')`;
}
async function release(postId: string) {
  await fixture.owner`update schellingaf.withheld set released_at = now() where post_id = ${postId}::uuid and released_at is null`;
}

describe("the counter follows each post", () => {
  test("a plain post adds exactly its object and its members-only part", async () => {
    const owner = await agent();
    const s = await space(owner);
    assert.equal(await counted(s.id), 0);
    const p = await post(owner, s.name, { data: { note: "members only", n: 1 }, run_id: randomUUID() });
    const bytes = await postBytes(p);
    assert.ok(bytes.object > 0 && bytes.privatePart > 0, JSON.stringify(bytes));
    assert.equal(await counted(s.id), bytes.object + bytes.privatePart);
    const q = await post(owner, s.name);
    const more = await postBytes(q);
    assert.equal(await counted(s.id), bytes.object + bytes.privatePart + more.object + more.privatePart);
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("a sealed post adds its object, its header and its ciphertext", async () => {
    const owner = await agent({ encryptionKey: true });
    const s = await sealedSpace(owner);
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { body: "sealed words" }) });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const bytes = await postBytes(out.body.post_id);
    assert.ok(bytes.object > 0 && bytes.sealedPart > 0, JSON.stringify(bytes));
    assert.equal(await counted(s.id), bytes.object + bytes.privatePart + bytes.sealedPart);
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("hide and unhide, withhold and release, in every order, end where they began", async () => {
    const owner = await agent();
    const s = await space(owner);
    const w = await writerIn(owner, s.name);
    await post(owner, s.name);
    const p = await post(w, s.name, { data: { k: "v" } });
    const all = await counted(s.id);
    const mine = (await postBytes(p)).object + (await postBytes(p)).privatePart;
    assert.equal(all, await trueSum(s.id));

    assert.equal((await call("PUT", `/v1/posts/${p}/hidden`, owner.token)).status, 200);
    assert.equal(await counted(s.id), all - mine, "hidden takes its bytes off");
    assert.equal((await call("DELETE", `/v1/posts/${p}/hidden`, owner.token)).status, 200);
    assert.equal(await counted(s.id), all, "shown puts them back");

    await withhold(p, s.id);
    assert.equal(await counted(s.id), all - mine, "withheld takes them off");
    await release(p);
    assert.equal(await counted(s.id), all, "released puts them back");

    // Hidden, then withheld, then shown, then released: off once, back once.
    assert.equal((await call("PUT", `/v1/posts/${p}/hidden`, owner.token)).status, 200);
    await withhold(p, s.id);
    assert.equal(await counted(s.id), all - mine);
    assert.equal((await call("DELETE", `/v1/posts/${p}/hidden`, owner.token)).status, 200);
    assert.equal(await counted(s.id), all - mine, "still withheld");
    await release(p);
    assert.equal(await counted(s.id), all);

    // A withheld row written already released changes nothing.
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note, released_at)
      values (${p}::uuid, ${s.id}::uuid, 'malware', 'a test', now())`;
    assert.equal(await counted(s.id), all);
    assert.equal(await counted(s.id), await trueSum(s.id));
  });
});

describe("the counter's checks", () => {
  test("an object linked to a hidden post adds nothing until the post is shown", async () => {
    const owner = await agent();
    const s = await space(owner);
    // A post the owner wrote with no object, hidden, then linked as the recovery path does.
    const author = Buffer.from(owner.peerId, "hex");
    const [row] = await fixture.owner<{ id: string }[]>`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      values (${s.id}::uuid, 1, 1, ${author}, 'obs', ${`no object ${randomUUID()}`}, ${randomBytes(32)})
      returning post_id::text as id`;
    await fixture.owner`update schellingaf.spaces set last_seq = 1 where space_id = ${s.id}::uuid`;
    await fixture.owner`
      insert into schellingaf.space_hidden (post_id, space_id, hidden_by, revision) values (${row!.id}::uuid, ${s.id}::uuid, ${author}, 1)`;
    const [linked] = await fixture.owner<{ n: number }[]>`select schellingaf.link_posts(${s.id}::uuid) as n`;
    assert.equal(linked!.n, 1);
    const bytes = await postBytes(row!.id);
    assert.ok(bytes.object > 0, JSON.stringify(bytes));
    assert.equal(await counted(s.id), 0, "a hidden post's object is not counted");
    await fixture.owner`delete from schellingaf.space_hidden where post_id = ${row!.id}::uuid`;
    assert.equal(await counted(s.id), bytes.object + bytes.privatePart, "shown, it counts");
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("a withheld row that does not change whether the post is withheld takes nothing off again", async () => {
    const owner = await agent();
    const s = await space(owner);
    await post(owner, s.name);
    const p = await post(owner, s.name, { data: { k: 1 } });
    const all = await counted(s.id);
    const mine = (await postBytes(p)).object + (await postBytes(p)).privatePart;
    // An old withholding, released, then a new one that holds.
    await withhold(p, s.id);
    await release(p);
    await withhold(p, s.id);
    assert.equal(await counted(s.id), all - mine);
    // A row written already released, while the post is withheld.
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note, released_at)
      values (${p}::uuid, ${s.id}::uuid, 'malware', 'a test', now())`;
    assert.equal(await counted(s.id), all - mine, "an inserted released row");
    // A released row's time changed, while the post is withheld.
    await fixture.owner`
      update schellingaf.withheld set released_at = released_at + interval '1 second'
       where post_id = ${p}::uuid and released_at is not null`;
    assert.equal(await counted(s.id), all - mine, "a released row updated");
    await release(p);
    assert.equal(await counted(s.id), all);
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("a withholding that names another SPACE moves the post's own SPACE's counter", async () => {
    const owner = await agent();
    const s = await space(owner);
    const other = await space(owner);
    const p = await post(owner, s.name);
    await post(owner, other.name);
    const mine = await counted(s.id);
    const theirs = await counted(other.id);
    // withheld.space_id is typed by the operator, with no foreign key.
    await withhold(p, other.id);
    assert.equal(await counted(s.id), 0, "the post's own SPACE gives its bytes back");
    assert.equal(await counted(other.id), theirs, "the SPACE named by mistake is untouched");
    await release(p);
    assert.equal(await counted(s.id), mine);
    assert.equal(await counted(other.id), theirs);
  });
});

describe("the migration's locks", () => {
  test("every lock is taken up front in one statement, waiting less than the api role's 2 s", () => {
    const text = readFileSync(new URL("../migrations/0148_space_storage.sql", import.meta.url), "utf8");
    const code = text.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    const lock = code.indexOf("LOCK TABLE");
    assert.ok(lock >= 0, "the file takes its locks with LOCK TABLE");
    assert.ok(lock < code.indexOf("CREATE "), "before the first CREATE");
    assert.equal(code.split("LOCK TABLE").length, 2, "in one statement");
    const statement = code.slice(lock, code.indexOf(";", lock));
    for (const table of ["spaces", "posts", "post_objects", "sealed_posts", "space_hidden", "withheld"]) {
      assert.match(statement, new RegExp(`schellingaf\\.${table}[,\\s]`), table);
    }
    assert.match(statement, /IN SHARE ROW EXCLUSIVE MODE$/);
    const timeout = /SET LOCAL lock_timeout = '(\d+)ms';/.exec(code.slice(0, lock));
    assert.ok(timeout, "a lock_timeout in milliseconds before the lock");
    assert.ok(Number(timeout[1]) < 2000, `lock_timeout is ${timeout[1]}ms`);
  });
});

describe("the backfill", () => {
  test("counts every SPACE with a post, a hidden and a withheld post left out", async () => {
    const owner = await agent();
    const a = await space(owner);
    const b = await space(owner);
    const w = await writerIn(owner, a.name);
    const shown = await post(owner, a.name, { data: { x: 1 } });
    const hidden = await post(w, a.name);
    const withheld = await post(owner, a.name, { data: { y: 2 } });
    await post(owner, b.name);
    assert.equal((await call("PUT", `/v1/posts/${hidden}/hidden`, owner.token)).status, 200);
    await withhold(withheld, a.id);
    const want = { a: await trueSum(a.id), b: await trueSum(b.id) };
    assert.ok(want.a > 0 && want.b > 0);
    const only = await postBytes(shown);
    assert.equal(want.a, only.object + only.privatePart, "the true sum is the one shown post");

    // Before 0148 there was no counter: take it away, then run the migration's statement.
    await fixture.owner`delete from schellingaf.space_storage`;
    const migration = readFileSync(new URL("../migrations/0148_space_storage.sql", import.meta.url), "utf8").split("\n");
    const from = migration.indexOf("-- backfill begin");
    const to = migration.indexOf("-- backfill end");
    assert.ok(from >= 0 && to > from + 1, "the migration marks its backfill");
    const statement = migration.slice(from + 1, to).join("\n");
    assert.ok(statement.startsWith("INSERT INTO schellingaf.space_storage"), statement);
    await fixture.owner.unsafe(statement);
    assert.equal(await counted(a.id), want.a, "the hidden and the withheld post are left out");
    assert.equal(await counted(b.id), want.b);
    // A SPACE with no post gets no row; every SPACE with one does.
    const [missing] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.spaces s
       where exists (select 1 from schellingaf.posts p where p.space_id = s.space_id)
         and not exists (select 1 from schellingaf.space_storage t where t.space_id = s.space_id)`;
    assert.equal(missing!.n, 0);
  });
});

describe("the recount", () => {
  test("corrects both counters, logs one line naming the SPACE by id, and a second run corrects nothing", async () => {
    const owner = await agent();
    const s = await space(owner);
    await post(owner, s.name, { data: { x: 1 } });
    // Every other SPACE true first, so this one is the only correction.
    await recountStorage(db, () => {});
    const truth = await trueSum(s.id);
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 12345 where space_id = ${s.id}::uuid`;
    await fixture.owner`
      insert into schellingaf.space_file_totals as t (space_id, attached_bytes) values (${s.id}::uuid, 7)
      on conflict (space_id) do update set attached_bytes = t.attached_bytes + 7`;
    const lines: string[] = [];
    const out = await recountStorage(db, (line) => lines.push(line));
    assert.equal(out.corrected, 1, JSON.stringify(out));
    assert.equal(out.failed, 0);
    assert.equal(out.post_bytes_delta, -12345);
    assert.equal(out.file_bytes_delta, -7);
    assert.ok(out.spaces >= 1);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [
      { event: "storage.recount", space_id: s.id, post_bytes_delta: -12345, file_bytes_delta: -7, task_bytes_delta: 0 },
    ]);
    assert.ok(!lines[0]!.includes(s.name), "the line names the SPACE by id, never by name");
    assert.equal(await counted(s.id), truth);
    const [files] = await fixture.owner<{ b: string }[]>`select attached_bytes::text as b from schellingaf.space_file_totals where space_id = ${s.id}::uuid`;
    assert.equal(Number(files!.b), 0);

    const again: string[] = [];
    const second = await recountStorage(db, (line) => again.push(line));
    assert.deepEqual({ corrected: second.corrected, post: second.post_bytes_delta, files: second.file_bytes_delta }, { corrected: 0, post: 0, files: 0 });
    assert.deepEqual(again, []);
  });

  test("leaves a withheld post out of the count it corrects to", async () => {
    const owner = await agent();
    const s = await space(owner);
    const kept = await post(owner, s.name, { data: { x: 1 } });
    const withheld = await post(owner, s.name, { data: { y: 2 } });
    await withhold(withheld, s.id);
    await recountStorage(db, () => {});
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 4321 where space_id = ${s.id}::uuid`;
    const out = await recountStorage(db, () => {});
    assert.equal(out.failed, 0, JSON.stringify(out));
    const only = await postBytes(kept);
    assert.equal(await counted(s.id), only.object + only.privatePart, "the kept post alone");
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("a SPACE held by a writer fails fast and is counted failed, whatever the connection's timeouts", async () => {
    const owner = await agent();
    const s = await space(owner);
    await post(owner, s.name);
    await recountStorage(db, () => {});
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 77 where space_id = ${s.id}::uuid`;
    // A connection with no lock or statement timeout of its own: the recount sets its own.
    const patient = postgres({
      host: config.db.host, port: config.db.port, database: config.db.database,
      username: config.db.username, password: config.db.password, max: 2, onnotice: () => {},
      // Strings: the driver sends no parameter for a number 0, and the role's 2 s would hold.
      connection: { lock_timeout: "0" as unknown as number, statement_timeout: "0" as unknown as number },
    });
    const held = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const holding = fixture.owner.begin(async (tx) => {
      await tx`select 1 from schellingaf.spaces where space_id = ${s.id}::uuid for update`;
      held.resolve();
      await go.promise;
    });
    holding.catch((e) => held.reject(e));
    // Without the recount's own timeouts it would wait for the writer, which lets go at 8 s.
    const letGo = setTimeout(() => go.resolve(), 8000);
    try {
      await held.promise;
      const began = Date.now();
      const out = await recountStorage({ write: patient } as unknown as Db, () => {});
      const took = Date.now() - began;
      assert.equal(out.failed, 1, JSON.stringify(out));
      assert.ok(took < 5000, `the recount took ${took} ms`);
    } finally {
      clearTimeout(letGo);
      go.resolve();
      await holding;
      await patient.end({ timeout: 5 });
    }
    assert.equal((await recountStorage(db, () => {})).failed, 0, "the next run corrects it");
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("the unlocked comparison may wait past the correction's 1.5 s, and the correction still holds the SPACE alone", async () => {
    const owner = await agent();
    const s = await space(owner);
    await post(owner, s.name);
    await recountStorage(db, () => {});
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 55 where space_id = ${s.id}::uuid`;
    // The comparison reads the counter table; held here for 2.5 s, as a slow count of a
    // large SPACE would hold the comparison. Under the correction's 1.5 s it would fail.
    const held = Promise.withResolvers<void>();
    const holding = fixture.owner.begin(async (tx) => {
      await tx`lock table schellingaf.space_storage in access exclusive mode`;
      held.resolve();
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    holding.catch((e) => held.reject(e));
    await held.promise;
    const out = await recountStorage(db, () => {});
    await holding;
    assert.equal(out.failed, 0, JSON.stringify(out));
    assert.equal(out.corrected, 1, JSON.stringify(out));
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("a post committed while the recount waits for the SPACE is not lost", async () => {
    const owner = await agent();
    const s = await space(owner);
    await post(owner, s.name);
    await recountStorage(db, () => {});
    // Wrong, so the recount takes the SPACE's lock, behind a writer that holds it.
    await fixture.owner`update schellingaf.space_storage set post_bytes = post_bytes + 999 where space_id = ${s.id}::uuid`;
    const author = Buffer.from(owner.peerId, "hex");
    const held = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const writing = fixture.owner.begin(async (tx) => {
      await tx`set local lock_timeout = '10s'`;
      await tx`select schellingaf.append_post(${s.name}, ${author}, 'obs', 'A held POST', ${`held ${randomUUID()}`},
                 null, null, '{}'::bytea[], null, null, null, null, null, null)`;
      held.resolve();
      await go.promise;
    });
    writing.catch((e) => held.reject(e));
    await held.promise;
    const recounting = recountStorage(db, () => {});
    try {
      await waitingOnLock("storage_recount");
    } finally {
      go.resolve();
    }
    await writing;
    const out = await recounting;
    assert.equal(out.failed, 0, JSON.stringify(out));
    assert.equal(await counted(s.id), await trueSum(s.id), "the held post is counted");
    const [posts] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where space_id = ${s.id}::uuid`;
    assert.equal(posts!.n, 2);
  });
});

describe("privacy", () => {
  test("the api role reads no counter, and of the new functions it runs only the three recount functions", async () => {
    await assert.rejects(fixture.api`select space_id from schellingaf.space_storage`, /permission denied/);
    await assert.rejects(
      fixture.asCaller(null, (sql) => sql`select space_id from schellingaf.space_storage`),
      /permission denied/,
    );
    const rows = await fixture.owner<{ name: string; api: boolean }[]>`
      select p.oid::regprocedure::text as name, has_function_privilege('schellingaf_api', p.oid, 'execute') as api
        from pg_proc p
       where p.pronamespace = 'schellingaf'::regnamespace
         and p.proname in ('post_stored_bytes', 'post_shown', 'space_post_bytes_true', 'space_file_bytes_true',
                           'storage_count_insert', 'storage_follow', 'storage_recount', 'storage_recount_drift',
                           'storage_recount_spaces')
       order by 1`;
    assert.equal(rows.length, 9);
    assert.deepEqual(rows.filter((r) => r.api).map((r) => r.name), [
      "storage_recount(uuid)",
      "storage_recount_drift(uuid)",
      "storage_recount_spaces(uuid,integer)",
    ]);
  });
});

// ── Helpers: a sealed SPACE as the owner's software makes one (test/sealed-spaces.test.ts) ──

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function sealedSpace(owner: Agent): Promise<{ name: string; id: string }> {
  const name = newName();
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: bytes(owner.peerId), sender: bytes(owner.peerId),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  const out = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { name, id: spaceId };
}

async function sealedPost(author: Agent, name: string, content: Record<string, unknown>) {
  const st = await call("GET", `/v1/spaces/${name}/sealed`, author.token);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const mine = st.body.locks.find((l: any) => l.generation === st.body.generation);
  const senderKey = await sealed.checkedEncryptionKey({
    statement: mine.sender.encryption_key.statement, envelope: mine.sender.encryption_key.signature, signer: mine.sender, passkeys: undefined,
  });
  const secret = await sealed.openLock({
    container: sealed.spaceContainer(st.body.space_id), g: Number(st.body.generation), recipient: bytes(author.peerId),
    sender: bytes(mine.sender.peer_id), commitment: bytes(st.body.commitment), lock: bytes(mine.lock),
    skR: author.enc!.sk, pkS: senderKey,
  });
  return sealed.sealPost({ secret, generation: Number(st.body.generation), author: author.peerId, spaceId: st.body.space_id, kind: "obs", content });
}

/** Waits until a statement naming `text` waits on a lock. */
async function waitingOnLock(text: string) {
  // As the superuser, which sees every session's statement.
  const su = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
  try {
    for (let i = 0; i < 500; i++) {
      const [row] = await su<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${text}%`}
           and pid <> pg_backend_pid()`;
      if (row!.n >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`nothing waited in ${text}`);
  } finally {
    await su.end({ timeout: 5 });
  }
}

