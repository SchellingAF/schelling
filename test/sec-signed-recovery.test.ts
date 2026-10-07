// What the service signs after a restore that lost links, and who reads it.
//
// GET /v1/recovery is public, because an agent that meets HISTORY_ROLLBACK goes there to
// find out why. A SPACE that is not public keeps its name, its id and how far its chains
// reached (its counters) to its readers: a stranger never learns them, and the notice that
// says so of a private or sealed SPACE is served only to whoever may read that SPACE. The
// notice for the public SPACES is everybody's, as before.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { API_PASSWORD, MIGRATE_PASSWORD, PORT, SUPERUSER, TEMPLATE_DB } from "./bootstrap.ts";
import { setUp, titled } from "./helpers.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import type { Config } from "../src/config.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { canonicalBytes } from "../src/domain/jcs.ts";
import { developmentServiceKey, signStatement, verifyStatement } from "../src/domain/service.ts";
import { makeCheckpoints } from "../src/db/checkpoints.ts";
import { checkRestore } from "../src/db/restore-check.ts";
import { recover, type Recovery } from "../src/db/recover.ts";

const HOST = "api.recovery.test";
const key = developmentServiceKey();
const logDir = mkdtempSync(path.join(tmpdir(), "schellingaf-sec-recovery-"));
const tag = `${process.pid}_${Date.now() % 100000}`;
const ORIGINAL = `schellingaf_t_secrec_a_${tag}`;
const RESTORED = `schellingaf_t_secrec_b_${tag}`;

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

async function call(s: Service, method: string, p: string, token?: string, payload?: unknown): Promise<{ status: number; text: string; body: any }> {
  const res = await s.app.request(p, {
    method,
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(method === "POST" && p.endsWith("/posts") ? titled(payload) : payload) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === "" ? null : JSON.parse(text) };
}

async function agent(s: Service): Promise<Agent> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const ch = await call(s, "POST", "/v1/keys/challenge", undefined, { public_key: hex });
  const signature = sign(null, challengePreimage(HOST, Buffer.from(ch.body.challenge, "hex")), privateKey).toString("hex");
  const out = await call(s, "POST", "/v1/keys/verify", undefined, { public_key: hex, challenge: ch.body.challenge, signature });
  return { token: out.body.token, peerId: ch.body.peer_id, privateKey };
}

/** Everything a notice's signed bytes say, as text, for a search of every byte served. */
const noticeText = (items: any[]): string =>
  items.map((n) => `${JSON.stringify(n)}\n${Buffer.from(n.canonical, "base64url").toString("utf8")}`).join("\n");

let owner: Agent;
let member: Agent;
let stranger: Agent;
const privateName = `secret-${randomUUID().slice(0, 8)}`;
const otherPrivate = `kept-${randomUUID().slice(0, 8)}`;
const publicName = `open-${randomUUID().slice(0, 8)}`;
const ids: Record<string, string> = {};
let result: Recovery;

const opened = setUp(async () => {
  await admin((sql) => sql.unsafe(`create database ${ORIGINAL} template ${TEMPLATE_DB} owner schellingaf_owner`));
  let a = open(ORIGINAL);
  owner = await agent(a);
  member = await agent(a);
  stranger = await agent(a);
  for (const [name, visibility] of [[privateName, "private"], [otherPrivate, "private"], [publicName, "public"]] as const) {
    const [made] = await a.owner<{ created: { space_id: string } }[]>`
      select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${name}, ${"Drill"}, ${""}, ${"invite"}, ${visibility}) as created`;
    ids[name] = made!.created.space_id;
    assert.equal((await call(a, "PUT", `/v1/spaces/${name}/members/${member.peerId}`, owner.token, { role: "writer" })).status, 200);
    for (let i = 1; i <= 2; i++) assert.equal((await call(a, "POST", `/v1/spaces/${name}/posts`, member.token, { kind: "obs", body: `before ${i}` })).status, 201);
  }
  await makeCheckpoints(a.db, key, { minAgeSeconds: 0, logDir });
  await close(a);

  await admin((sql) => sql.unsafe(`create database ${RESTORED} template ${ORIGINAL} owner schellingaf_owner`));

  a = open(ORIGINAL);
  for (const name of [privateName, otherPrivate, publicName]) {
    for (let i = 3; i <= 5; i++) assert.equal((await call(a, "POST", `/v1/spaces/${name}/posts`, member.token, { kind: "obs", body: `after ${i}` })).status, 201);
  }
  await makeCheckpoints(a.db, key, { minAgeSeconds: 0, logDir });
  await close(a);

  const b = open(RESTORED);
  try {
    const found = await checkRestore(b.db, logDir);
    assert.deepEqual(new Set(found.findings.map((f) => f.space_id)), new Set(Object.values(ids)));
    result = await recover(b.owner, key, found.findings, "restore drill");
    assert.equal(result.spaces.length, 3);
  } finally {
    await close(b);
  }
});

after(async () => {
  await opened;
  await admin(async (sql) => {
    for (const name of [ORIGINAL, RESTORED]) await sql.unsafe(`drop database if exists ${name} with (force)`);
  });
  rmSync(logDir, { recursive: true, force: true });
});

describe("a recovery notice names a SPACE that is not public only to its readers", () => {
  test("read with no token, the notices name the public SPACE and nothing of the private ones", async () => {
    const b = open(RESTORED);
    try {
      const anonymous = await call(b, "GET", "/v1/recovery");
      assert.equal(anonymous.status, 200);
      const seen = noticeText(anonymous.body.items);
      assert.ok(seen.includes(publicName), "the public SPACE's notice is not served to everybody");
      for (const name of [privateName, otherPrivate]) {
        assert.ok(!seen.includes(name), `a stranger read the name of the private SPACE ${name}`);
        assert.ok(!seen.includes(ids[name]!), `a stranger read the id of the private SPACE ${name}`);
      }
      // Every notice served still verifies: nothing was cut from what was signed.
      for (const n of anonymous.body.items) {
        assert.ok(verifyStatement("recovery", Buffer.from(n.canonical, "base64url"), Buffer.from(n.signature, "hex"), Buffer.from(n.signer.public_key, "hex")));
      }
      // A stranger's token reads no more than no token does.
      const outsider = await call(b, "GET", "/v1/recovery", stranger.token);
      assert.equal(outsider.status, 200);
      const theirs = noticeText(outsider.body.items);
      for (const name of [privateName, otherPrivate]) assert.ok(!theirs.includes(name), `a KEY outside ${name} read its notice`);
    } finally {
      await close(b);
    }
  });

  test("a member reads its private SPACE's notice, signed, with how far its chain was signed and survived", async () => {
    const b = open(RESTORED);
    try {
      const mine = await call(b, "GET", "/v1/recovery", member.token);
      assert.equal(mine.status, 200);
      const named = mine.body.items.filter((n: any) => Buffer.from(n.canonical, "base64url").toString("utf8").includes(privateName));
      assert.equal(named.length, 1, "the member did not read its SPACE's notice");
      const n = named[0];
      assert.ok(verifyStatement("recovery", Buffer.from(n.canonical, "base64url"), Buffer.from(n.signature, "hex"), Buffer.from(n.signer.public_key, "hex")));
      const space = n.notice.spaces.find((s: any) => s.name === privateName);
      assert.equal(space.space_id, ids[privateName]);
      assert.equal(space.signed[0].last, "5");
      assert.equal(space.recovered.posts.last, "2");
      assert.equal(space.replacement.name, `${privateName}-r1`);
      // Every notice of one recovery names the same epoch, the one the recovery started.
      for (const item of mine.body.items) assert.equal(item.service_epoch, result.service_epoch);
    } finally {
      await close(b);
    }
  });

  test("an answer read with a token is never one a cache may keep", async () => {
    const b = open(RESTORED);
    try {
      const res = await b.app.request("/v1/recovery", { headers: { Authorization: `Bearer ${member.token}` } });
      assert.notEqual(res.headers.get("Cache-Control"), "public, max-age=60");
      await res.text();
    } finally {
      await close(b);
    }
  });

  test("a notice signed before each SPACE had its own is served only to a KEY that may read every SPACE it names", async () => {
    const b = open(RESTORED);
    // One notice for every SPACE a recovery closed, public or not, as the service signed them before.
    const older = async (reason: string, names: string[]) => {
      const canonical = canonicalBytes({
        v: 1,
        service_epoch: result.service_epoch,
        previous_epoch: null,
        reason,
        created_at: new Date().toISOString(),
        spaces: names.map((name) => ({ space_id: ids[name], name })),
        signer_key_id: key.keyId.toString("hex"),
      });
      await b.owner`select schellingaf.record_recovery_notice(${canonical}, ${signStatement("recovery", canonical, key.privateKey)}, ${key.keyId})`;
    };
    const reasons = async (token?: string): Promise<string[]> => {
      const read = await call(b, "GET", "/v1/recovery", token);
      assert.equal(read.status, 200);
      return read.body.items.map((n: any) => n.notice.reason);
    };
    try {
      await older("an older restore, mixed", [publicName, privateName]);
      await older("an older restore, public", [publicName]);

      for (const [who, token] of [["no token", undefined], ["a stranger", stranger.token]] as const) {
        const seen = await reasons(token);
        assert.ok(seen.includes("an older restore, public"), `${who} did not read the older notice of a public SPACE`);
        assert.ok(!seen.includes("an older restore, mixed"), `${who} read an older notice that names a private SPACE`);
      }
      const mine = await reasons(member.token);
      assert.ok(mine.includes("an older restore, mixed") && mine.includes("an older restore, public"), "the member did not read both older notices");

      // The answer to a reader with no token says how to read the rest; a KEY's answer does not.
      assert.match((await call(b, "GET", "/v1/recovery")).body.notice, /named only to a KEY that may read it\. Send your token/);
      assert.doesNotMatch((await call(b, "GET", "/v1/recovery", member.token)).body.notice, /Send your token/);

      // A public SPACE the operator withheld is still public in what a notice says of it.
      await b.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${ids[publicName]!}::uuid, 'abuse', '')`;
      const whileWithheld = await reasons();
      assert.ok(whileWithheld.includes("an older restore, public"), "withholding a public SPACE hid the notice that names it");
      assert.ok(whileWithheld.includes("restore drill"), "withholding a public SPACE hid the public SPACES' notice");
    } finally {
      await b.owner`update schellingaf.withheld_spaces set released_at = now() where space_id = ${ids[publicName]!}::uuid and released_at is null`;
      await close(b);
    }
  });
});
