// A sealed SPACE's key handed to a hundred thousand members, and then changed, measured.
//
//   npm run db:up && node test/bootstrap.ts
//   node scripts/sealed-change.ts                      # 100,000 members
//   node scripts/sealed-change.ts --members 10000
//   node scripts/sealed-change.ts --stamped            # each vouched for by the owner's stamp
//
// content/sealed.md, section 7, records this number: what a keeper's
// software spends, and what the database writes, when it hands a SPACE's key to every
// member, and when it changes the key.
//
// Local only. It clones the TEST template into a database of its own,
// `schellingaf_bench_sealed`, and connects to nothing else.
//
// It does what the bridge's keeper does, with the same module and the same routes, in
// process: it reads the members waiting a thousand at a time, checks each one's
// encryption key's statement, seals a lock for each, hands them on a thousand at a
// time and activates, waiting out the service's Retry-After as the bridge does. The
// members themselves are made straight in the database, each with a real KEY and a real
// signed statement: a hundred thousand registrations through the API would measure
// registration.

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import postgres from "postgres";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import * as sealed from "../content/sealed.mjs";
import { arg, cloneTemplate, superuser } from "./lib/scratch.ts";

const PORT = Number(process.env.TEST_DB_PORT ?? 5439);
const DATABASE = "schellingaf_bench_sealed";
const HOST = "api.sealed-change.bench";

const MEMBERS = Number(arg("members") ?? 100_000);
/** A list that admits by stamp alone, every member stamped by the owner, every stamp checked. */
const STAMPED = process.argv.includes("--stamped");

const say = (m: string) => process.stdout.write(`${m}\n`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a scratch database ───────────────────────────────────────────────────────────

await cloneTemplate(PORT, DATABASE);
const scratch = postgres({ ...superuser(PORT), database: DATABASE });
const walNow = async () => (await scratch<{ lsn: string }[]>`select pg_current_wal_lsn()::text as lsn`)[0]!.lsn;
const walSince = async (from: string) =>
  Number((await scratch<{ n: string }[]>`select pg_wal_lsn_diff(pg_current_wal_lsn(), ${from}::pg_lsn)::bigint::text as n`)[0]!.n);

const config: Config = {
  apiHost: HOST,
  publicOrigin: `https://${HOST}`,
  challengeKey: Buffer.from("a-test-challenge-key-not-a-secret", "utf8"),
  readOnly: false,
  logDir: null,
  welcomeSpace: null,
  db: { host: "127.0.0.1", port: PORT, database: DATABASE, username: "schellingaf_api", password: "test_api_password_not_a_secret" },
};
const db = openDb(config);
const app = createApp(config, db);

/** One call, as the bridge makes it, waiting out a Retry-After as the bridge does. */
let waited = 0;
async function call(method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  for (;;) {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text === "" ? null : JSON.parse(text);
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") ?? "1") * 1000;
      waited += wait;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return json;
  }
}

// ── the owner, its sealed SPACE, and a list that lets in any KEY that asks ──────────

const ownerKey = generateKeyPairSync("ed25519");
const ownerPub = Buffer.from(ownerKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
const challenge = await call("POST", "/v1/keys/challenge", null, { public_key: ownerPub });
const verified = await call("POST", "/v1/keys/verify", null, {
  public_key: ownerPub, challenge: challenge.challenge,
  signature: sign(null, challengePreimage(HOST, Buffer.from(challenge.challenge, "hex")), ownerKey.privateKey).toString("hex"),
});
const owner = { token: verified.token as string, peerId: verified.peer_id as string };
const ownerSeed = new Uint8Array(Buffer.from(ownerKey.privateKey.export({ format: "jwk" }).d!, "base64url"));
const ownerEnc = await sealed.encryptionKey(ownerSeed, bytes(owner.peerId));
const signedBy = (key: typeof ownerKey.privateKey, labelName: string, what: Uint8Array) =>
  sign(null, Buffer.from(sealed.signedBytes(labelName, what)), key).toString("hex");
const ownerStatement = sealed.statementBytes(bytes(owner.peerId), ownerEnc.pk);
await call("PUT", "/v1/me/encryption-key", owner.token, {
  statement: sealed.toB64u(ownerStatement), alg: "ed25519", signature: signedBy(ownerKey.privateKey, sealed.LABELS.encryptionKey, ownerStatement),
});

const name = `bench-sealed-${process.pid}`;
const spaceId = randomUUID();
const container = sealed.spaceContainer(spaceId);
const g1 = await sealed.newGeneration(container, 1);
const ownLock = await sealed.sealLock({
  container, g: 1, recipient: bytes(owner.peerId), sender: bytes(owner.peerId),
  commitment: g1.commitment, secret: g1.secret, pkR: ownerEnc.pk, skS: ownerEnc.sk,
});
await call("POST", "/v1/spaces", owner.token, {
  name, title: "A hundred thousand, sealed", visibility: "sealed", categories: ["general"],
  sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(ownLock) },
});
const list = sealed.keeperListBytes({ spaceId, revision: 1, keepers: [], admission: STAMPED ? "stamped" : "open", stampers: [], changeEvery: 3600 });
await call("PUT", `/v1/spaces/${name}/sealed/keepers`, owner.token, {
  list: sealed.toB64u(list), alg: "ed25519", signature: signedBy(ownerKey.privateKey, sealed.LABELS.keepers, list),
});

// ── a hundred thousand members, each a real KEY with a real signed statement ─────────

let t = Date.now();
const owned = postgres({ ...superuser(PORT), database: DATABASE, username: "schellingaf_migrate", password: "test_migrate_password_not_a_secret" });
await owned`set role schellingaf_owner`;
const [space] = await owned<{ revision: string }[]>`select revision::text from schellingaf.spaces where name = ${name}`;
const BATCH = 5000;
for (let from = 0; from < MEMBERS; from += BATCH) {
  const peers: { peer_id: Buffer; public_key: Buffer }[] = [];
  const keys: { peer_id: Buffer; kem: number; public_key: Buffer; statement: Buffer; signature: unknown }[] = [];
  const stamps: { space_id: string; peer_id: Buffer; stamp: Buffer; signature: unknown; issuer: Buffer }[] = [];
  for (let i = from; i < Math.min(MEMBERS, from + BATCH); i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const peerId = await sealed.sha256(sealed.label(sealed.LABELS.agent), pub);
    const seed = new Uint8Array(Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url"));
    const enc = await sealed.encryptionKey(seed, peerId);
    const statement = sealed.statementBytes(peerId, enc.pk);
    peers.push({ peer_id: Buffer.from(peerId), public_key: Buffer.from(pub) });
    if (STAMPED) {
      const stamp = sealed.stampBytes({ issuer: owner.peerId, peerId: hex(peerId) });
      stamps.push({
        space_id: spaceId, peer_id: Buffer.from(peerId), stamp: Buffer.from(stamp), issuer: Buffer.from(owner.peerId, "hex"),
        signature: { alg: "ed25519", signature: signedBy(ownerKey.privateKey, sealed.LABELS.stamp, stamp) },
      });
    }
    keys.push({
      peer_id: Buffer.from(peerId), kem: 32, public_key: Buffer.from(enc.pk), statement: Buffer.from(statement),
      signature: { alg: "ed25519", signature: signedBy(privateKey, sealed.LABELS.encryptionKey, statement) },
    });
  }
  await owned.begin(async (sql) => {
    await sql`insert into schellingaf.peers ${sql(peers, "peer_id", "public_key")}`;
    await sql`insert into schellingaf.encryption_keys ${sql(keys.map((k) => ({ ...k, signature: sql.json(k.signature as never) })), "peer_id", "kem", "public_key", "statement", "signature")}`;
    await sql`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select ${spaceId}::uuid, p, 'reader', 'grant', decode(${owner.peerId}, 'hex'), ${space!.revision}::bigint
        from unnest(${sql.array(peers.map((p) => p.peer_id))}::bytea[]) p`;
    if (stamps.length) {
      await sql`insert into schellingaf.sealed_stamps ${sql(stamps.map((x) => ({ ...x, signature: sql.json(x.signature as never) })), "space_id", "peer_id", "stamp", "signature", "issuer")}`;
    }
  });
  process.stdout.write(`\r  made ${Math.min(MEMBERS, from + BATCH).toLocaleString("en-US")} members`);
}
process.stdout.write("\n");
say(`${MEMBERS.toLocaleString("en-US")} members made in ${seconds(Date.now() - t)} (not part of what is measured)`);
await owned.end({ timeout: 5 });

// ── what a keeper does, timed ──────────────────────────────────────────────────────

type Phase = { checked: number; sealing: number; handing: number; waiting: number; locks: number; calls: number };

const ownerProfile = STAMPED ? await call("GET", `/v1/peers/${owner.peerId}`, owner.token) : null;

/** Every member still waiting for generation g, checked, locked and handed on. */
async function handAll(g: number, secret: Uint8Array, commitment: Uint8Array): Promise<Phase> {
  const p: Phase = { checked: 0, sealing: 0, handing: 0, waiting: 0, locks: 0, calls: 0 };
  for (;;) {
    const page = await call("GET", `/v1/spaces/${name}/sealed/unlocked?generation=${g}&limit=1000`, owner.token);
    if (page.items.length === 0) return p;
    let at = Date.now();
    const recipients: { peer: Uint8Array; pk: Uint8Array }[] = [];
    for (const m of page.items) {
      if (!m.vouched) throw new Error(`${m.peer_id} is not vouched for`);
      // What the bridge's keeper checks of a stamp: that it names the member, comes from a
      // KEY the list trusts, and carries that KEY's signature. The issuer's key is read once.
      if (STAMPED && m.peer_id !== owner.peerId) {
        const stampBytes = sealed.fromB64u(m.stamp.stamp)!;
        const read = sealed.readStamp(stampBytes);
        if (read.peer_id !== m.peer_id || read.issuer !== owner.peerId) throw new Error(`${m.peer_id}'s stamp does not hold`);
        await sealed.verifySigned({ labelName: sealed.LABELS.stamp, bytes: stampBytes, envelope: m.stamp.signature, signer: ownerProfile, passkeys: undefined });
      }
      const pk = m.peer_id === owner.peerId
        ? ownerEnc.pk
        : await sealed.checkedEncryptionKey({ statement: m.encryption_key.statement, envelope: m.encryption_key.signature, signer: m, passkeys: undefined });
      recipients.push({ peer: bytes(m.peer_id), pk });
    }
    p.checked += Date.now() - at;
    at = Date.now();
    const locks = await sealed.sealLocks({ container, g, sender: bytes(owner.peerId), commitment, secret, skS: ownerEnc.sk, recipients });
    p.sealing += Date.now() - at;
    const before = waited;
    at = Date.now();
    const out = await call("POST", `/v1/spaces/${name}/sealed/locks`, owner.token, {
      generation: String(g), commitment: hex(commitment), locks: Object.fromEntries(recipients.map((r, i) => [hex(r.peer), hex(locks[i]!)])),
    });
    p.waiting += waited - before;
    p.handing += Date.now() - at - (waited - before);
    p.locks += out.added;
    p.calls += 1;
  }
}

const report = (what: string, p: Phase, wal: number, total: number) => {
  say(`\n${what}`);
  say(`  locks handed:        ${p.locks.toLocaleString("en-US")}, in ${p.calls} calls of at most 1,000`);
  say(`  checking keys${STAMPED ? " and stamps" : ""}: ${seconds(p.checked)}`);
  say(`  sealing locks:       ${seconds(p.sealing)}`);
  say(`  handing them on:     ${seconds(p.handing)} at the service`);
  say(`  waiting its limits:  ${seconds(p.waiting)}`);
  say(`  in all:              ${seconds(total)}`);
  say(`  change log written:  ${mb(wal)}`);
};

// Generation 1 to everybody: what admitting them all would cost, lock by lock.
waited = 0;
let wal = await walNow();
t = Date.now();
const first = await handAll(1, g1.secret, g1.commitment);
report(`Handing generation 1 to ${MEMBERS.toLocaleString("en-US")} members${STAMPED ? ", each stamp checked" : ""}`, first, await walSince(wal), Date.now() - t);

// A change of key: stage, lock for everybody, activate, and the old locks pruned.
waited = 0;
wal = await walNow();
t = Date.now();
const g2 = await sealed.newGeneration(container, 2, g1.secret);
await call("POST", `/v1/spaces/${name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!) });
const second = await handAll(2, g2.secret, g2.commitment);
let at = Date.now();
const activated = await call("POST", `/v1/spaces/${name}/sealed/generations/2/activate`, owner.token);
const activating = Date.now() - at;
report(`Changing the key of a SPACE of ${MEMBERS.toLocaleString("en-US")} members${STAMPED ? ", each stamp checked" : ""}`, second, await walSince(wal), Date.now() - t);
say(`  activating:          ${seconds(activating)}, ${Number(activated.locks_pruned).toLocaleString("en-US")} old locks pruned`);

const [size] = await scratch<{ locks: string; rows: string }[]>`
  select pg_total_relation_size('schellingaf.sealed_locks')::text as locks,
         (select count(*) from schellingaf.sealed_locks)::text as rows`;
say(`\nsealed_locks now: ${Number(size!.rows).toLocaleString("en-US")} rows, ${mb(Number(size!.locks))} with its indexes`);

await db.end();
await scratch.end({ timeout: 5 });
const admin = postgres(superuser(PORT));
await admin.unsafe(`drop database if exists ${DATABASE} with (force)`);
await admin.end({ timeout: 5 });
