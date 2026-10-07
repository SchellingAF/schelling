// A restore that loses links is found before a single write, and the SPACE
// continues in a replacement that says why.
//
// This is the restore drill, run in the suite rather than once a month: a
// database that signed checkpoints is copied as a backup would copy it, writes and
// checkpoints continue on the original, and then the copy is brought back as a
// restore would bring it back. The checkpoint log
// outside the database is the only thing that still remembers what was signed.
// A second copy is written differently after the backup, which is a fork rather
// than a loss, and must be told apart from a clean database.
//
// The log is compacted daily to each chain's latest entry, and a log that is not
// there, while the database holds checkpoints, stops the start unless the operator
// gives the token that refusal printed, which says the fresh start is deliberate.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { API_PASSWORD, MIGRATE_PASSWORD, PORT, SUPERUSER, TEMPLATE_DB } from "./bootstrap.ts";
import { setUp, titled } from "./helpers.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import { underOf } from "../src/surface/categories.ts";
import { createApp } from "../src/http/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { developmentServiceKey, verifyStatement } from "../src/domain/service.ts";
import { checkpointPass, compactCheckpointLog, latestSigned, makeCheckpoints, CHECKPOINT_LOG, CHECKPOINT_LOG_PREVIOUS, type CheckpointRun } from "../src/db/checkpoints.ts";
import { checkRestore, RESTORE_REPORT } from "../src/db/restore-check.ts";
import { recover } from "../src/db/recover.ts";
import { verifyExport, type Fetcher } from "../scripts/verify-export.ts";

const HOST = "api.restore.test";
const key = developmentServiceKey();
const logDir = mkdtempSync(path.join(tmpdir(), "schellingaf-restore-"));
const tag = `${process.pid}_${Date.now() % 100000}`;
const ORIGINAL = `schellingaf_t_restore_a_${tag}`;
const RESTORED = `schellingaf_t_restore_b_${tag}`;
const FORKED = `schellingaf_t_restore_c_${tag}`;
// A database that never signed a checkpoint, a copy of the original that the
// compaction's tests write to, and a database whose only checkpoints are a private
// SPACE's, which the api role cannot see at startup.
const UNSIGNED = `schellingaf_t_restore_d_${tag}`;
const LATER = `schellingaf_t_restore_e_${tag}`;
const PRIVATE = `schellingaf_t_restore_f_${tag}`;

type Service = { db: Db; app: ReturnType<typeof createApp>; owner: postgres.Sql };
type Agent = { token: string; peerId: string; privateKey: KeyObject };

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(SUPERUSER);
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function open(database: string): Service {
  const config: Config = {
    apiHost: HOST,
    publicOrigin: `https://${HOST}`,
    challengeKey: Buffer.from("a-test-challenge-key-not-a-secret", "utf8"),
    readOnly: false,
    logDir: null,
    welcomeSpace: null,
    serviceKey: key,
    db: { host: "127.0.0.1", port: PORT, database, username: "schellingaf_api", password: API_PASSWORD },
  };
  const db = openDb(config);
  const owner = postgres({ host: "127.0.0.1", port: PORT, database, username: "schellingaf_migrate", password: MIGRATE_PASSWORD, max: 2, onnotice: () => {} });
  return { db, app: createApp(config, db), owner };
}

async function close(s: Service) {
  await s.db.end();
  await s.owner.end({ timeout: 5 });
}

async function call(s: Service, method: string, p: string, token?: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await s.app.request(p, {
    method,
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(method === "POST" && p.endsWith("/posts") ? titled(payload) : payload) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

async function agent(s: Service): Promise<Agent> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const ch = await call(s, "POST", "/v1/keys/challenge", undefined, { public_key: hex });
  const signature = sign(null, challengePreimage(HOST, Buffer.from(ch.body.challenge, "hex")), privateKey).toString("hex");
  const out = await call(s, "POST", "/v1/keys/verify", undefined, { public_key: hex, challenge: ch.body.challenge, signature });
  return { token: out.body.token, peerId: ch.body.peer_id, privateKey };
}

const fetcherFor = (s: Service): Fetcher => async (url, init) => {
  const res = await s.app.request(url.replace("http://service", ""), { headers: init?.headers ?? {} });
  return { status: res.status, text: () => res.text() };
};

let owner: Agent;
let writer: Agent;
let spaceName = "";
let spaceId = "";
const witness = path.join(logDir, "witness.json");

const opened = setUp(async () => {
  await admin((sql) => sql.unsafe(`create database ${ORIGINAL} template ${TEMPLATE_DB} owner schellingaf_owner`));
  let a = open(ORIGINAL);
  owner = await agent(a);
  writer = await agent(a);
  spaceName = `drill-${randomUUID().slice(0, 8)}`;
  const [made] = await a.owner<{ created: { space_id: string } }[]>`
    select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${spaceName}, ${"Restore drill"}, ${""}, ${"invite"}, ${"public"},
                                    ${false}, ${["mathematics", "python"]}::text[],
                                    ${underOf(["mathematics", "python"]).under}::text[],
                                    ${underOf(["mathematics", "python"]).main}::text[]) as created`;
  spaceId = made!.created.space_id;
  assert.equal((await call(a, "PUT", `/v1/spaces/${spaceName}/members/${writer.peerId}`, owner.token, { role: "writer" })).status, 200);
  for (let i = 1; i <= 3; i++) assert.equal((await call(a, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: `before the backup ${i}` })).status, 201);
  await makeCheckpoints(a.db, key, { minAgeSeconds: 0, logDir });
  await close(a);

  // The backup: two copies of the database as it stood.
  await admin(async (sql) => {
    await sql.unsafe(`create database ${RESTORED} template ${ORIGINAL} owner schellingaf_owner`);
    await sql.unsafe(`create database ${FORKED} template ${ORIGINAL} owner schellingaf_owner`);
    await sql.unsafe(`create database ${UNSIGNED} template ${TEMPLATE_DB} owner schellingaf_owner`);
  });

  // Life goes on after the backup, and the service signs it.
  a = open(ORIGINAL);
  for (let i = 4; i <= 6; i++) assert.equal((await call(a, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: `after the backup ${i}` })).status, 201);
  await makeCheckpoints(a.db, key, { minAgeSeconds: 0, logDir });
  assert.deepEqual((await verifyExport({ fetch: fetcherFor(a), api: "http://service", space: spaceName, token: owner.token, root: null, witness })).problems, []);
  await close(a);

  // The fork: the second copy is written to differently, as a service that came
  // back from the backup and carried on would write it.
  const c = open(FORKED);
  for (let i = 4; i <= 6; i++) assert.equal((await call(c, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: `a different history ${i}` })).status, 201);
  await close(c);

  await admin(async (sql) => {
    await sql.unsafe(`create database ${LATER} template ${ORIGINAL} owner schellingaf_owner`);
    await sql.unsafe(`create database ${PRIVATE} template ${TEMPLATE_DB} owner schellingaf_owner`);
  });
  const p = open(PRIVATE);
  const keeper = await agent(p);
  const privateName = `private-${randomUUID().slice(0, 8)}`;
  await p.owner`select schellingaf.create_space(${Buffer.from(keeper.peerId, "hex")}, ${privateName}, ${"Private"}, ${""}, ${"invite"}, ${"private"})`;
  assert.equal((await call(p, "POST", `/v1/spaces/${privateName}/posts`, keeper.token, { kind: "obs", body: "kept to the members" })).status, 201);
  const signed = await makeCheckpoints(p.db, key, { minAgeSeconds: 0 });
  assert.ok(signed.state === "done" && signed.made > 0, JSON.stringify(signed));
  await close(p);
});

after(async () => {
  await opened;
  await admin(async (sql) => {
    for (const name of [ORIGINAL, RESTORED, FORKED, UNSIGNED, LATER, PRIVATE]) await sql.unsafe(`drop database if exists ${name} with (force)`);
  });
  rmSync(logDir, { recursive: true, force: true });
});

describe("a restore that lost links", () => {
  test("the original database reaches every checkpoint it signed", async () => {
    const a = open(ORIGINAL);
    try {
      const result = await checkRestore(a.db, logDir);
      assert.ok(result.checked >= 2);
      assert.deepEqual(result.findings, []);
    } finally {
      await close(a);
    }
  });

  test("a forked copy is found forked, before it writes anything", async () => {
    const c = open(FORKED);
    try {
      const result = await checkRestore(c.db, logDir);
      assert.deepEqual(result.findings.map((f) => [f.space_id, f.stream, f.state, f.signed_last]), [[spaceId, "posts", "forked", "6"]]);
      // And a witness that checked the original names the fork, however
      // consistent the forked chain is with itself.
      const seen = await verifyExport({ fetch: fetcherFor(c), api: "http://service", space: spaceName, token: owner.token, root: null, witness });
      assert.ok(seen.problems.some((p) => /no longer served: the history changed/.test(p)), seen.problems.join("\n"));
    } finally {
      await close(c);
    }
  });

  test("a log of many chains, each written many times, is compared by each chain's latest checkpoint", async () => {
    // Twelve thousand chains of SPACES this database never held, which are not
    // findings, then the drill's own: its first posts checkpoint written three
    // thousand times on either side of its latest. The latest is neither the first
    // line for its chain nor the last, and its chain is compared in a later
    // statement than the first.
    const logged = readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8").trimEnd().split("\n");
    const ours = logged.filter((line) => JSON.parse(line).space_id === spaceId);
    const posts = ours.filter((line) => JSON.parse(line).stream === "posts");
    assert.deepEqual(posts.map((line) => JSON.parse(line).last), ["3", "6"]);
    const others = Array.from({ length: 12_000 }, () =>
      JSON.stringify({ space_id: randomUUID(), stream: "posts", last: "1", ending_hash: "00".repeat(32), checkpoint_id: "00".repeat(32) }));
    const dir = mkdtempSync(path.join(logDir, "many-"));
    const first = Array(3_000).fill(posts[0]);
    writeFileSync(path.join(dir, CHECKPOINT_LOG), `${[...others, ...first, ...ours, ...first].join("\n")}\n`);

    const c = open(FORKED);
    try {
      const result = await checkRestore(c.db, dir);
      assert.equal(result.checked, others.length + new Set(ours.map((line) => JSON.parse(line).stream)).size);
      assert.deepEqual(result.findings.map((f) => [f.space_id, f.stream, f.state, f.signed_last]), [[spaceId, "posts", "forked", "6"]]);
    } finally {
      await close(c);
    }
  });

  test("a log that cannot be read stops the check, and a log that is not there is nothing to check", async () => {
    const a = open(ORIGINAL);
    const d = open(UNSIGNED);
    try {
      const unreadable = mkdtempSync(path.join(logDir, "unreadable-"));
      mkdirSync(path.join(unreadable, CHECKPOINT_LOG));
      const file = path.join(unreadable, CHECKPOINT_LOG);
      await assert.rejects(checkRestore(a.db, unreadable), (error: Error) => error.message.includes(`cannot read ${file}`) && /EISDIR/.test(error.message));
      // Nothing to check where nothing was ever signed: the database holds no checkpoint.
      const none = mkdtempSync(path.join(logDir, "none-"));
      assert.deepEqual(await checkRestore(d.db, none), { checked: 0, findings: [] });
      assert.equal(existsSync(path.join(none, CHECKPOINT_LOG)), false, "a start with nothing signed wrote a log");
    } finally {
      await close(a);
      await close(d);
    }
  });

  test("a log entry that is not a checkpoint stops the check and names its line, and a line cut short is skipped", async () => {
    const logged = readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8").trimEnd().split("\n");
    const { ending_hash: _, ...unhashed } = JSON.parse(logged.at(-1)!);
    const cutShort = logged[0]!.slice(0, 40);
    const a = open(ORIGINAL);
    try {
      const dir = mkdtempSync(path.join(logDir, "entries-"));
      const file = path.join(dir, CHECKPOINT_LOG);
      writeFileSync(file, `${[...logged, cutShort, JSON.stringify(unhashed)].join("\n")}\n`);
      await assert.rejects(checkRestore(a.db, dir), (error: Error) => error.message === `restore check: ${file} line ${logged.length + 2} is not a checkpoint entry`);
      writeFileSync(file, `${[...logged, cutShort].join("\n")}\n`);
      assert.deepEqual(await checkRestore(a.db, dir), await checkRestore(a.db, logDir));
    } finally {
      await close(a);
    }
  });

  test("a restored copy is found short, is recovered, and continues in a replacement that says why", async () => {
    const b = open(RESTORED);
    try {
      const found = await checkRestore(b.db, logDir);
      assert.deepEqual(found.findings.map((f) => [f.stream, f.state, f.signed_last]), [["posts", "short", "6"]]);
      assert.ok(existsSync(path.join(logDir, RESTORE_REPORT)), "the finding was not written down");
      assert.equal(JSON.parse(readFileSync(path.join(logDir, RESTORE_REPORT), "utf8")).findings[0].space_id, spaceId);

      const [epochBefore] = await b.owner<{ epoch: string }[]>`select epoch::text from schellingaf.service_epochs order by started_at desc limit 1`;
      const result = await recover(b.owner, key, found.findings, "restore drill");
      assert.equal(result.spaces.length, 1);
      const replacement = result.spaces[0]!.replacement;
      assert.equal(replacement.name, `${spaceName}-r1`);
      assert.deepEqual(result.spaces[0]!.not_granted, []);
      assert.notEqual(result.service_epoch, epochBefore!.epoch, "the service epoch did not rotate");

      // Recovered is not a finding: the service starts writable again.
      assert.deepEqual((await checkRestore(b.db, logDir)).findings, []);

      // The old SPACE keeps every number it handed out, and says where it continues.
      const profile = await call(b, "GET", `/v1/spaces/${spaceName}`);
      assert.equal(profile.body.status, "closed");
      assert.deepEqual(profile.body.replaced_by, replacement);
      const ahead = await call(b, "GET", `/v1/spaces/${spaceName}/posts?after=6`, owner.token);
      assert.equal(ahead.status, 409);
      assert.equal(ahead.body.error.code, "HISTORY_ROLLBACK");
      assert.equal(ahead.body.error.detail, `continued in [${replacement.name}]`);
      assert.equal((await call(b, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: "late" })).body.error.code, "SPACE_CLOSED");

      // The replacement has the same owner and members, and its own chain from genesis.
      const next = await call(b, "POST", `/v1/spaces/${replacement.name}/posts`, writer.token, { kind: "obs", body: "carrying on" });
      assert.equal(next.status, 201, JSON.stringify(next.body));
      assert.equal(next.body.seq, "1");
      const events = await call(b, "GET", `/v1/spaces/${replacement.name}/events`, owner.token);
      assert.deepEqual(events.body.items[0].payload.replaces, { space_id: spaceId, name: spaceName });
      // Filed where the SPACE it continues was, in its row and in its creation event.
      assert.deepEqual((await call(b, "GET", `/v1/spaces/${replacement.name}`)).body.categories, ["mathematics", "python"]);
      assert.deepEqual(events.body.items[0].payload.categories, ["mathematics", "python"]);
      const listed = await call(b, "GET", "/v1/spaces?category=computing");
      assert.deepEqual(listed.body.items.map((i: any) => i.name), [replacement.name], "the replacement is not listed where the original was");
      assert.ok(events.body.items.some((e: any) => e.event === "member.granted" && e.payload.peer_id === writer.peerId));
      const closing = await call(b, "GET", `/v1/spaces/${spaceName}/events`, owner.token);
      assert.equal(closing.body.items.at(-1).event, "space.closed");

      // The notice is public, signed, and says what was signed and what survived.
      const notices = await call(b, "GET", "/v1/recovery");
      assert.equal(notices.status, 200);
      assert.equal(notices.body.has_more, false);
      assert.equal(notices.body.next_before, null);
      const paged = await call(b, "GET", "/v1/recovery?limit=1");
      assert.equal(paged.body.items.length, 1);
      if (paged.body.has_more) {
        const rest = await call(b, "GET", `/v1/recovery?limit=1&before=${paged.body.next_before}`);
        assert.notEqual(rest.body.items[0]?.notice_id, paged.body.items[0].notice_id);
      }
      const n = notices.body.items[0];
      assert.equal(n.notice_id, result.notice_id);
      assert.ok(verifyStatement("recovery", Buffer.from(n.canonical, "base64url"), Buffer.from(n.signature, "hex"), Buffer.from(n.signer.public_key, "hex")));
      const space = n.notice.spaces[0];
      assert.equal(space.signed[0].last, "6");
      assert.equal(space.recovered.posts.last, "3");
      assert.deepEqual(space.replacement, replacement);
      const caps = await call(b, "GET", "/v1/capabilities");
      assert.equal(caps.body.protocol.service_epoch, result.service_epoch);
    } finally {
      await close(b);
    }
  });
});

describe("the checkpoint log is compacted, and a log that is not there stops the start", () => {
  test("compaction keeps each chain's latest entry, the check answers as it did, and the log before it is kept", async () => {
    // Chains of SPACES this database never held, each written three times, and the
    // drill's own written many times on either side of its latest.
    const logged = readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8").trimEnd().split("\n");
    const ours = logged.filter((line) => JSON.parse(line).space_id === spaceId);
    const firstPosts = ours.find((line) => JSON.parse(line).stream === "posts" && JSON.parse(line).last === "3")!;
    const others = Array.from({ length: 2_000 }, () => {
      const space_id = randomUUID();
      return ["1", "2", "3"].map((last) => JSON.stringify({ space_id, stream: "posts", last, ending_hash: "00".repeat(32), checkpoint_id: "00".repeat(32) }));
    });
    const dir = mkdtempSync(path.join(logDir, "compact-"));
    const file = path.join(dir, CHECKPOINT_LOG);
    const whole = `${[...others.flat(), ...Array(500).fill(firstPosts), ...ours, ...Array(500).fill(firstPosts), logged[0]!.slice(0, 40)].join("\n")}\n`;
    writeFileSync(file, whole);

    const a = open(ORIGINAL);
    const c = open(FORKED);
    try {
      const before = [await checkRestore(a.db, dir), await checkRestore(c.db, dir)];
      assert.deepEqual(before[1]!.findings.map((f) => [f.space_id, f.stream, f.state, f.signed_last]), [[spaceId, "posts", "forked", "6"]]);

      assert.deepEqual(await compactCheckpointLog(a.db, dir), { state: "done", chains: before[0]!.checked });
      const compacted = readFileSync(file, "utf8");
      const kept = compacted.trimEnd().split("\n");
      assert.equal(kept.length, before[0]!.checked);
      // Each kept line is the chain's latest, exactly as the worker wrote it.
      const latestOurs = new Map(ours.map((line) => [JSON.parse(line).stream, line]));
      assert.deepEqual(kept.filter((line) => JSON.parse(line).space_id === spaceId).sort(), [...latestOurs.values()].sort());
      assert.deepEqual(kept.filter((line) => JSON.parse(line).space_id !== spaceId), others.map((lines) => lines[2]!));
      assert.deepEqual([await checkRestore(a.db, dir), await checkRestore(c.db, dir)], before);
      assert.equal(readFileSync(path.join(dir, CHECKPOINT_LOG_PREVIOUS), "utf8"), whole, "the log before the compaction was not kept");

      // The next compaction keeps the one before it, and changes nothing it kept.
      assert.deepEqual(await compactCheckpointLog(a.db, dir), { state: "done", chains: before[0]!.checked });
      assert.equal(readFileSync(path.join(dir, CHECKPOINT_LOG_PREVIOUS), "utf8"), compacted);
      assert.equal(readFileSync(file, "utf8"), compacted);

      // No log is nothing to compact, and none is made.
      const none = mkdtempSync(path.join(logDir, "compact-none-"));
      assert.deepEqual(await compactCheckpointLog(a.db, none), { state: "done", chains: 0 });
      assert.equal(existsSync(path.join(none, CHECKPOINT_LOG)), false);
    } finally {
      await close(a);
      await close(c);
    }
  });

  test("the worker compacts the log on its first pass, and then once a day", async () => {
    const day = 24 * 60 * 60 * 1000;
    const logged = readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8").trimEnd().split("\n");
    const dir = mkdtempSync(path.join(logDir, "schedule-"));
    const file = path.join(dir, CHECKPOINT_LOG);
    const chains = new Set(logged.map((line) => `${JSON.parse(line).space_id}/${JSON.parse(line).stream}`)).size;
    const twice = `${[...logged, ...logged].join("\n")}\n`;
    writeFileSync(file, twice);
    const a = open(ORIGINAL);
    try {
      let clock = 0;
      const pass = checkpointPass(a.db, key, dir, () => clock);
      await pass();
      const compacted = readFileSync(file, "utf8");
      assert.equal(compacted.trimEnd().split("\n").length, chains, "the first pass did not compact the log");
      assert.equal(readFileSync(path.join(dir, CHECKPOINT_LOG_PREVIOUS), "utf8"), twice);

      // Within the day the log only grows.
      writeFileSync(file, `${logged[0]}\n`, { flag: "a" });
      clock += day - 1;
      await pass();
      assert.equal(readFileSync(file, "utf8"), `${compacted}${logged[0]}\n`, "the log was compacted twice in a day");
      assert.equal(readFileSync(path.join(dir, CHECKPOINT_LOG_PREVIOUS), "utf8"), twice);

      // A day after the last compaction, the next.
      clock += 1;
      await pass();
      assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, chains, "the log was not compacted a day later");
      assert.equal(readFileSync(path.join(dir, CHECKPOINT_LOG_PREVIOUS), "utf8"), `${compacted}${logged[0]}\n`);
    } finally {
      await close(a);
    }
  });

  test("a checkpoint signed while the log is being compacted is not lost", async () => {
    const dir = mkdtempSync(path.join(logDir, "append-"));
    const file = path.join(dir, CHECKPOINT_LOG);
    copyFileSync(path.join(logDir, CHECKPOINT_LOG), file);
    const l = open(LATER);
    try {
      assert.equal((await call(l, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: "during the compaction 7" })).status, 201);
      // The worker runs once the new log is written and before it replaces the old one.
      let during: CheckpointRun | null = null;
      const compaction = await compactCheckpointLog(l.db, dir, {
        beforeRename: async () => {
          during = await makeCheckpoints(l.db, key, { minAgeSeconds: 0, logDir: dir });
        },
      });
      assert.equal(compaction.state, "done");
      assert.deepEqual(during, { state: "busy" }, "the worker ran while the log was being compacted");
      assert.deepEqual(await makeCheckpoints(l.db, key, { minAgeSeconds: 0, logDir: dir }), { state: "done", made: 1, failed: 0 });

      // The log ends each of the drill's chains where the database does.
      const stored = await l.owner<{ stream: string; checkpoint_id: string; last: string }[]>`
        select distinct on (stream) stream, encode(checkpoint_id, 'hex') as checkpoint_id, last_position::text as last
          from schellingaf.space_checkpoints where space_id = ${spaceId}::uuid
         order by stream, last_position desc`;
      assert.deepEqual(stored.find((row) => row.stream === "posts")?.last, "7");
      const log = (await latestSigned(file))!;
      assert.deepEqual(
        stored.map((row) => [row.stream, log.get(`${spaceId}/${row.stream}`)?.signed.checkpoint_id, log.get(`${spaceId}/${row.stream}`)?.signed.last]),
        stored.map((row) => [row.stream, row.checkpoint_id, row.last]),
      );
      assert.deepEqual((await checkRestore(l.db, dir)).findings, []);
    } finally {
      await close(l);
    }
  });

  test("a log that is not there stops the start while the database holds checkpoints, and the token it prints lets one fresh start through", async () => {
    // The token as the runbook describes it, worked out by hand as the owner role: the
    // first twelve hex characters of SHA-256 over the newest checkpoint's id and the count.
    const byHand = async (s: Service): Promise<string> => {
      const [row] = await s.owner<{ newest: string | null; n: string }[]>`
        select (select encode(c.checkpoint_id, 'hex') from schellingaf.space_checkpoints c
                 order by c.created_at desc, c.checkpoint_id desc limit 1) as newest,
               (select count(*) from schellingaf.space_checkpoints)::text as n`;
      return createHash("sha256").update(`${row!.newest ?? ""}:${row!.n}`).digest("hex").slice(0, 12);
    };
    const refused = (file: string, token: string, given?: string) => (error: Error) =>
      error.message.startsWith(`restore check: the database holds signed checkpoints, and ${file} is not there.\n`) &&
      error.message.includes(`start once with CHECKPOINT_LOG_MAY_BE_ABSENT=${token}. `) &&
      (given === undefined || error.message.includes(`CHECKPOINT_LOG_MAY_BE_ABSENT is ${given}, which is not the token`));

    const a = open(ORIGINAL);
    try {
      const token = await byHand(a);
      const dir = mkdtempSync(path.join(logDir, "absent-"));
      const file = path.join(dir, CHECKPOINT_LOG);
      await assert.rejects(checkRestore(a.db, dir), refused(file, token));
      // A token that is not this database's is refused, and the refusal prints the right one.
      await assert.rejects(checkRestore(a.db, dir, { absentLogToken: "0123456789ab" }), refused(file, token, "0123456789ab"));
      assert.equal(existsSync(file), false, "a refused start wrote a log");

      // Let through with the token, the service begins a new log, so the next start finds one.
      assert.deepEqual(await checkRestore(a.db, dir, { absentLogToken: token }), { checked: 0, findings: [], newLog: true });
      assert.equal(statSync(file).size, 0);
      assert.deepEqual(await checkRestore(a.db, dir), { checked: 0, findings: [] });

      // Where the log is there, the token changes nothing.
      assert.deepEqual(await checkRestore(a.db, logDir, { absentLogToken: token }), await checkRestore(a.db, logDir));

      // Nothing signed since, the token is the same: the runbook says so.
      const again = mkdtempSync(path.join(logDir, "absent-again-"));
      await assert.rejects(checkRestore(a.db, again), refused(path.join(again, CHECKPOINT_LOG), token));

      // One more checkpoint signed, and the token the operator left set lets nothing through.
      assert.equal((await call(a, "POST", `/v1/spaces/${spaceName}/posts`, writer.token, { kind: "obs", body: "after the fresh start" })).status, 201);
      const signed = await makeCheckpoints(a.db, key, { minAgeSeconds: 0, logDir: mkdtempSync(path.join(logDir, "absent-signed-")) });
      assert.ok(signed.state === "done" && signed.made > 0, JSON.stringify(signed));
      const next = await byHand(a);
      assert.notEqual(next, token);
      const lost = mkdtempSync(path.join(logDir, "absent-lost-"));
      await assert.rejects(checkRestore(a.db, lost, { absentLogToken: token }), refused(path.join(lost, CHECKPOINT_LOG), next, token));
      assert.equal(existsSync(path.join(lost, CHECKPOINT_LOG)), false, "a stale token wrote a log");
    } finally {
      await close(a);
    }

    // A private SPACE's checkpoints count, though the api role cannot see them at startup,
    // and the token covers them.
    const p = open(PRIVATE);
    try {
      assert.equal((await p.db.write<{ n: number }[]>`select count(*)::int as n from schellingaf.space_checkpoints`)[0]!.n, 0);
      assert.ok((await p.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_checkpoints`)[0]!.n > 0);
      const dir = mkdtempSync(path.join(logDir, "absent-private-"));
      // The token first: awaited inside the arguments, it left the check's refusal with no
      // handler until it came back, and a refusal that came back sooner failed the test.
      const token = await byHand(p);
      await assert.rejects(checkRestore(p.db, dir), refused(path.join(dir, CHECKPOINT_LOG), token));
      assert.equal(existsSync(path.join(dir, CHECKPOINT_LOG)), false, "a refused start wrote a log");
    } finally {
      await close(p);
    }
  });

  test("CHECKPOINT_LOG_MAY_BE_ABSENT is off or a token, and 1 is refused", () => {
    const saved = { ...process.env };
    const load = (value: string | undefined) => {
      Object.assign(process.env, { API_HOST: HOST, PUBLIC_ORIGIN: `https://${HOST}`, CHALLENGE_KEY: "a-test-challenge-key-not-a-secret", DB_PASSWORD: "a-db-password-not-a-secret" });
      for (const name of ["CHALLENGE_KEY_FILE", "DB_PASSWORD_FILE", "REQUIRE_APPROVED_COPY", "LOG_DIR", "CHECKPOINT_LOG_MAY_BE_ABSENT"]) delete process.env[name];
      if (value !== undefined) process.env.CHECKPOINT_LOG_MAY_BE_ABSENT = value;
      return loadConfig().absentLogToken;
    };
    try {
      for (const off of [undefined, "", "0", "false", "no", "Off"]) assert.equal(load(off), null, String(off));
      assert.equal(load(" 0123456789AB "), "0123456789ab");
      // A plain on/off value is refused, so one left on lets nothing through.
      for (const value of ["1", "true", "YES", " on ", "maybe", "0123456789a", "0123456789abc"]) {
        assert.throws(() => load(value), (error: Error) =>
          error.message.startsWith(`CHECKPOINT_LOG_MAY_BE_ABSENT is "${value}". It takes the token the restore check\n`), value);
      }
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
