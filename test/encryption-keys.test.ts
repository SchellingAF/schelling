// A KEY's encryption key: published once, for life, in a statement the KEY signs
// itself, checked by the service before it is kept and served so that every reader
// can check it again (content/sealed.md section 1).
//
// The test that matters most is the profile's: what GET /v1/peers/:peer serves
// passes content/sealed.mjs's own check, which is what the bridge and the website
// run before they seal anything to a KEY.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { useService, app, call, agent as registered, passkey, passkeyAssertion as assertion, type Passkey } from "./lib/service.ts";
import { LABEL_ENCRYPTION_KEY, LABEL_PASSKEY_PEER_ID } from "../src/domain/protocol.ts";
import * as sealed from "../content/sealed.mjs";

const HOST = "api.encryption.test";
const RP_ID = "encryption.test";
const ORIGIN = "https://encryption.test";

useService("encryption_keys", { apiHost: HOST, passkeys: { rpId: RP_ID, origins: [ORIGIN] } });

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const label = (full: string) => Buffer.concat([Buffer.from(full, "utf8"), Buffer.from([0])]);

type Agent = { token: string; peerId: string; key: KeyObject; seed: Buffer };

async function agent(): Promise<Agent> {
  const { token, peerId, privateKey } = await registered();
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  return { token, peerId, key: privateKey, seed };
}

/** What the bridge does: derive the encryption key from the KEY's own seed, and sign the statement. */
async function statementOf(a: Agent, secret = a.seed) {
  const pair = await sealed.encryptionKey(new Uint8Array(secret), new Uint8Array(Buffer.from(a.peerId, "hex")));
  const statement = Buffer.from(sealed.statementBytes(new Uint8Array(Buffer.from(a.peerId, "hex")), pair.pk));
  const signature = sign(null, Buffer.concat([label(LABEL_ENCRYPTION_KEY), statement]), a.key).toString("hex");
  return { pk: Buffer.from(pair.pk), statement, body: { statement: statement.toString("base64url"), alg: "ed25519", signature } };
}

// ── a passkey, from the shared software authenticator ────────────────────────

const passkeyAssertion = (pk: Passkey, challenge: Buffer, origin = ORIGIN) => assertion(pk, challenge, { rpId: RP_ID, origin });

async function person(): Promise<{ token: string; peerId: string; pk: Passkey }> {
  const pk = passkey();
  const ch = (await call("POST", "/v1/passkeys/challenge", undefined, {})).body.challenge;
  const out = await call("POST", "/v1/passkeys/verify", undefined, {
    challenge: ch, ...passkeyAssertion(pk, Buffer.from(ch, "hex")), public_key: pk.spki.toString("base64url"), algorithm: -7,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { token: out.body.token, peerId: out.body.peer_id, pk };
}

// ── the tests ─────────────────────────────────────────────────────────────────

describe("an Ed25519 KEY publishes its encryption key", () => {
  test("once, for life: the same statement again changes nothing, and another is refused", async () => {
    const a = await agent();
    const s = await statementOf(a);
    const first = await call("PUT", "/v1/me/encryption-key", a.token, s.body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.registered, true);
    assert.equal(first.body.public_key, s.pk.toString("hex"));
    assert.equal(first.body.fingerprint, await sealed.fingerprint(new Uint8Array(s.pk)));

    const again = await call("PUT", "/v1/me/encryption-key", a.token, s.body);
    assert.equal(again.status, 200);
    assert.equal(again.body.registered, false);

    const other = await statementOf(a, randomBytes(32));
    const refused = await call("PUT", "/v1/me/encryption-key", a.token, other.body);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "ENCRYPTION_KEY_EXISTS");

    const me = await call("GET", "/v1/me", a.token);
    assert.equal(me.body.encryption_key.public_key, s.pk.toString("hex"));
    assert.equal(me.body.encryption_key.statement, s.body.statement);
    assert.deepEqual(me.body.encryption_key.signature, { alg: "ed25519", signature: s.body.signature });
  });

  test("refuses a statement that names another KEY, is not canonical, or has another shape", async () => {
    const a = await agent();
    const b = await agent();
    const s = await statementOf(a);
    const cases: Array<[string, Record<string, unknown>]> = [];
    const naming = Buffer.from(sealed.statementBytes(new Uint8Array(Buffer.from(b.peerId, "hex")), new Uint8Array(s.pk)));
    cases.push(["another KEY's peer id", { ...s.body, statement: naming.toString("base64url") }]);
    const spaced = Buffer.from(JSON.stringify(JSON.parse(s.statement.toString()), null, 1));
    cases.push(["whitespace", { ...s.body, statement: spaced.toString("base64url") }]);
    const extra = Buffer.from(sealed.canonical({ ...JSON.parse(s.statement.toString()), extra: 1 }));
    cases.push(["an extra field", { ...s.body, statement: extra.toString("base64url") }]);
    const kem = Buffer.from(sealed.canonical({ ...JSON.parse(s.statement.toString()), kem: 16 }));
    cases.push(["another KEM", { ...s.body, statement: kem.toString("base64url") }]);
    cases.push(["an unknown request field", { ...s.body, note: "hello" }]);
    cases.push(["no statement", { alg: "ed25519", signature: s.body.signature }]);
    for (const [what, body] of cases) {
      const out = await call("PUT", "/v1/me/encryption-key", a.token, body);
      assert.equal(out.status, 400, `${what}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error.code, "INVALID_REQUEST", what);
    }
    assert.equal((await call("GET", "/v1/me", a.token)).body.encryption_key, null, "nothing was kept");
  });

  test("refuses a signature from another KEY, or over the statement without its label", async () => {
    const a = await agent();
    const b = await agent();
    const s = await statementOf(a);
    const byB = sign(null, Buffer.concat([label(LABEL_ENCRYPTION_KEY), s.statement]), b.key).toString("hex");
    const unlabelled = sign(null, s.statement, a.key).toString("hex");
    for (const [what, signature] of [["another KEY", byB], ["no label", unlabelled]] as const) {
      const out = await call("PUT", "/v1/me/encryption-key", a.token, { ...s.body, signature });
      assert.equal(out.status, 400, what);
      assert.equal(out.body.error.code, "ENCRYPTION_KEY_INVALID", what);
    }
    const passkeyShaped = await call("PUT", "/v1/me/encryption-key", a.token, {
      statement: s.body.statement, alg: "webauthn", signature: "AAAAAAAAAAA", credential_id: randomBytes(16).toString("base64url"),
      client_data_json: "e30", authenticator_data: randomBytes(37).toString("base64url"),
    });
    assert.equal(passkeyShaped.body.error.code, "ENCRYPTION_KEY_INVALID");
  });

  test("refuses the same encryption key under a second KEY", async () => {
    const a = await agent();
    const b = await agent();
    const s = await statementOf(a);
    assert.equal((await call("PUT", "/v1/me/encryption-key", a.token, s.body)).status, 200);
    const copy = Buffer.from(sealed.statementBytes(new Uint8Array(Buffer.from(b.peerId, "hex")), new Uint8Array(s.pk)));
    const signature = sign(null, Buffer.concat([label(LABEL_ENCRYPTION_KEY), copy]), b.key).toString("hex");
    const out = await call("PUT", "/v1/me/encryption-key", b.token, { statement: copy.toString("base64url"), alg: "ed25519", signature });
    assert.equal(out.status, 409);
    assert.equal(out.body.error.code, "ENCRYPTION_KEY_TAKEN");
  });
});

describe("what the service serves is what every reader checks", () => {
  test("a KEY's profile carries a statement and signature content/sealed.mjs accepts, for an agent and a person", async () => {
    const reader = await agent();
    const a = await agent();
    const s = await statementOf(a);
    assert.equal((await call("PUT", "/v1/me/encryption-key", a.token, s.body)).status, 200);
    const p = await person();
    const pair = await sealed.encryptionKey(new Uint8Array(randomBytes(32)), new Uint8Array(Buffer.from(p.peerId, "hex")));
    const statement = Buffer.from(sealed.statementBytes(new Uint8Array(Buffer.from(p.peerId, "hex")), pair.pk));
    const challenge = sha256(Buffer.concat([label(LABEL_ENCRYPTION_KEY), statement]));

    // A passkey KEY publishes with the passkey signing the statement's hash, on a page
    // the service names: not from another page, and not as an Ed25519 KEY would.
    const elsewhere = await call("PUT", "/v1/me/encryption-key", p.token, {
      statement: statement.toString("base64url"), alg: "webauthn", ...passkeyAssertion(p.pk, challenge, "https://elsewhere.test"),
    });
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.error.code, "ENCRYPTION_KEY_INVALID");
    const asEd25519 = await call("PUT", "/v1/me/encryption-key", p.token, {
      statement: statement.toString("base64url"), alg: "ed25519", signature: "0".repeat(128),
    });
    assert.equal(asEd25519.body.error.code, "ENCRYPTION_KEY_INVALID");
    const published = await call("PUT", "/v1/me/encryption-key", p.token, {
      statement: statement.toString("base64url"), alg: "webauthn", ...passkeyAssertion(p.pk, challenge),
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.public_key, Buffer.from(pair.pk).toString("hex"));
    const peerId = sha256(Buffer.concat([label(LABEL_PASSKEY_PEER_ID), p.pk.spki])).toString("hex");
    assert.equal(published.body.peer_id, peerId);

    const passkeys = (await call("GET", "/v1/capabilities")).body.protocol.passkeys;
    for (const who of [a.peerId, p.peerId]) {
      const profile = (await call("GET", `/v1/peers/${who}`, reader.token)).body;
      const key = await sealed.checkedEncryptionKey({
        statement: profile.encryption_key.statement,
        envelope: profile.encryption_key.signature,
        signer: profile,
        passkeys,
      });
      assert.equal(Buffer.from(key).toString("hex"), profile.encryption_key.public_key, who);
      assert.equal(await sealed.fingerprint(key), profile.encryption_key.fingerprint);
    }
  });

  test("the module and the spec are served as the files they are", async () => {
    for (const [path, type, file] of [["/sealed.mjs", "text/javascript", "sealed.mjs"], ["/sealed.md", "text/markdown", "sealed.md"]] as const) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", new RegExp(type));
      const { readFileSync } = await import("node:fs");
      assert.equal(await res.text(), readFileSync(new URL(`../content/${file}`, import.meta.url), "utf8"), path);
    }
  });
});
