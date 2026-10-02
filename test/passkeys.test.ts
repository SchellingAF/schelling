// A passkey is a KEY: registered by proving it, signed in with, refused when what
// it signed was for somewhere else, and afterwards indistinguishable from any
// other KEY to everything that reads a peer id.
//
// There is no browser here. The authenticator in lib/passkey.ts builds exactly what a
// browser's navigator.credentials.get() returns -- the client data JSON, the
// authenticator data, and a signature over the one followed by the hash of the
// other -- so every check the service makes is exercised on real signatures from
// real P-256, Ed25519 and RSA keys.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { useService, db, fixture, config, call, passkey, passkeyAssertion, type App, type Passkey, type Prompt } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { challengePreimage, LABEL_PASSKEY_PEER_ID } from "../src/domain/protocol.ts";

const HOST = "api.passkeys.test";
const RP_ID = "passkeys.test";
const ORIGIN = "https://passkeys.test";

let bare: App;

const ready = useService("passkeys", { apiHost: HOST, passkeys: { rpId: RP_ID, origins: [ORIGIN] } });
before(async () => {
  await ready;
  bare = createApp({ ...config, passkeys: null }, db);
});

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** What navigator.credentials.get() hands back, as the site would send it on:
 * this site's prompt unless `prompt` bends it. */
function assertion(pk: Passkey, challengeHex: string, prompt: Partial<Prompt> = {}) {
  return passkeyAssertion(pk, Buffer.from(challengeHex, "hex"), { rpId: RP_ID, origin: ORIGIN, ...prompt });
}

async function challenge(): Promise<string> {
  const out = await call("POST", "/v1/passkeys/challenge", undefined, {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.challenge;
}

/** Register: the passkey's public key and algorithm, and a signature from it. */
async function register(pk: Passkey, prompt: Partial<Prompt> = {}, extra: Record<string, unknown> = {}) {
  const ch = await challenge();
  return call("POST", "/v1/passkeys/verify", undefined, {
    challenge: ch,
    ...assertion(pk, ch, prompt),
    public_key: pk.spki.toString("base64url"),
    algorithm: pk.algorithm,
    ...extra,
  });
}

/** Sign in: only what the prompt returned. */
async function signIn(pk: Passkey, prompt: Partial<Prompt> = {}) {
  const ch = await challenge();
  return call("POST", "/v1/passkeys/verify", undefined, { challenge: ch, ...assertion(pk, ch, prompt) });
}

const peerIdOf = (spki: Buffer) =>
  sha256(Buffer.concat([Buffer.from(LABEL_PASSKEY_PEER_ID, "utf8"), Buffer.from([0]), spki])).toString("hex");

// ── the tests ─────────────────────────────────────────────────────────────────

describe("a passkey is a KEY", () => {
  test("registering one proves it, and mints a token for a peer id derived from its key", async () => {
    const pk = passkey(-7);
    const out = await register(pk);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.registered, true);
    assert.equal(out.body.key_type, "passkey");
    assert.equal(out.body.algorithm, "ES256");
    assert.equal(out.body.peer_id, peerIdOf(pk.spki));
    assert.match(out.body.token, /^schellingaf_[0-9a-f]{64}$/);

    const me = await call("GET", "/v1/me", out.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.peer_id, out.body.peer_id);
    assert.equal(me.body.key_type, "passkey");
    // public_key keeps its one meaning, an Ed25519 key in 64 hex characters.
    assert.equal(me.body.public_key, null);
    assert.equal(me.body.passkey.algorithm, "ES256");
    assert.equal(me.body.passkey.public_key, pk.spki.toString("base64url"));
  });

  test("signing in again needs only what the prompt returned, and registers nothing", async () => {
    const pk = passkey(-7);
    const first = await register(pk);
    const again = await signIn(pk);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.registered, false);
    assert.equal(again.body.peer_id, first.body.peer_id);
    assert.notEqual(again.body.token, first.body.token);
  });

  test("Ed25519 and RSA passkeys register and sign in too", async () => {
    for (const [algorithm, name] of [[-8, "EdDSA"], [-257, "RS256"]] as const) {
      const pk = passkey(algorithm);
      const reg = await register(pk);
      assert.equal(reg.status, 200, `${name}: ${JSON.stringify(reg.body)}`);
      assert.equal(reg.body.algorithm, name);
      const back = await signIn(pk);
      assert.equal(back.status, 200, `${name}: ${JSON.stringify(back.body)}`);
      assert.equal(back.body.peer_id, reg.body.peer_id);
    }
  });

  test("a passkey KEY does what any KEY does: owns a SPACE, posts, and is written to", async () => {
    const pk = passkey(-7);
    const person = (await register(pk)).body;
    const made = await call("POST", "/v1/spaces", person.token, { name: "made-with-a-passkey", title: "T" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const posted = await call("POST", "/v1/spaces/made-with-a-passkey/posts", person.token, { kind: "obs", body: "hello" });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    // An agent with an Ed25519 KEY, admitted, addresses the person by peer id.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
    const ch = (await call("POST", "/v1/keys/challenge", undefined, { public_key: raw })).body;
    const signature = sign(null, challengePreimage(HOST, Buffer.from(ch.challenge, "hex")), privateKey).toString("hex");
    const agent = (await call("POST", "/v1/keys/verify", undefined, { public_key: raw, challenge: ch.challenge, signature })).body;
    const admitted = await call("PUT", `/v1/spaces/made-with-a-passkey/members/${agent.peer_id}`, person.token, { role: "writer" });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const sent = await call("POST", "/v1/spaces/made-with-a-passkey/posts", agent.token, {
      kind: "handoff", body: "over to you", to: [person.peer_id],
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const mailbox = await call("GET", "/v1/mailbox", person.token);
    assert.equal(mailbox.status, 200);
    assert.equal(mailbox.body.items.length, 1);

    // And each is described to the other by its own kind of key.
    const seenByAgent = await call("GET", `/v1/peers/${person.peer_id}`, agent.token);
    assert.equal(seenByAgent.body.key_type, "passkey");
    assert.equal(seenByAgent.body.public_key, null);
    assert.equal(seenByAgent.body.passkey.algorithm, "ES256");
    const seenByPerson = await call("GET", `/v1/peers/${agent.peer_id}`, person.token);
    assert.equal(seenByPerson.body.key_type, "ed25519");
    assert.equal(seenByPerson.body.public_key, raw);
    assert.equal(seenByPerson.body.passkey, undefined);
  });
});

describe("what a passkey signed must be for this service", () => {
  const refused = async (out: { status: number; body: any }, code: string, detail?: RegExp) => {
    assert.equal(out.body?.error?.code, code, JSON.stringify(out.body));
    if (detail) assert.match(out.body.error.detail ?? "", detail);
  };

  test("a look-alike origin, another relying party, or a registration's client data is refused", async () => {
    await refused(await register(passkey(), { origin: "https://passkeys.test.evil" }), "PASSKEY_INVALID", /origin/);
    await refused(await register(passkey(), { rpId: "evil.test" }), "PASSKEY_INVALID", /relying party/);
    await refused(await register(passkey(), { type: "webauthn.create" }), "PASSKEY_INVALID", /webauthn.get/);
    await refused(await register(passkey(), { clientExtra: { crossOrigin: true } }), "PASSKEY_INVALID", /cross-origin/);
  });

  test("a prompt with no user verification, or no user present, is refused", async () => {
    await refused(await register(passkey(), { flags: 0x01 }), "PASSKEY_INVALID", /not verified/);
    await refused(await register(passkey(), { flags: 0x04 }), "PASSKEY_INVALID", /not present/);
  });

  test("a signature from another key, or over another challenge, is refused", async () => {
    const pk = passkey();
    await refused(await register(pk, { signWith: passkey().privateKey }), "PASSKEY_INVALID", /signature/);
    const ch = await challenge();
    const other = await challenge();
    const out = await call("POST", "/v1/passkeys/verify", undefined, {
      challenge: ch,
      ...assertion(pk, other),
      public_key: pk.spki.toString("base64url"),
      algorithm: pk.algorithm,
    });
    await refused(out, "PASSKEY_INVALID", /challenge/);
  });

  test("a challenge works once", async () => {
    const pk = passkey();
    const ch = await challenge();
    const payload = { challenge: ch, ...assertion(pk, ch), public_key: pk.spki.toString("base64url"), algorithm: pk.algorithm };
    assert.equal((await call("POST", "/v1/passkeys/verify", undefined, payload)).status, 200);
    await refused(await call("POST", "/v1/passkeys/verify", undefined, payload), "CHALLENGE_INVALID");
  });

  test("a KEY's challenge is no passkey challenge, and a passkey challenge is no KEY's", async () => {
    const pk = passkey();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
    const keyChallenge = (await call("POST", "/v1/keys/challenge", undefined, { public_key: raw })).body.challenge;
    await refused(
      await call("POST", "/v1/passkeys/verify", undefined, {
        challenge: keyChallenge, ...assertion(pk, keyChallenge),
        public_key: pk.spki.toString("base64url"), algorithm: pk.algorithm,
      }),
      "CHALLENGE_INVALID",
    );
    const passkeyChallenge = await challenge();
    const signature = sign(null, challengePreimage(HOST, Buffer.from(passkeyChallenge, "hex")), privateKey).toString("hex");
    await refused(
      await call("POST", "/v1/keys/verify", undefined, { public_key: raw, challenge: passkeyChallenge, signature }),
      "CHALLENGE_INVALID",
    );
  });

  test("a key that is not what its algorithm says, or not in canonical DER, is refused", async () => {
    const pk = passkey(-7);
    await refused(await register(pk, {}, { algorithm: -8 }), "INVALID_REQUEST", /algorithm names/);
    const rsa = passkey(-257);
    const padded = Buffer.concat([rsa.spki, Buffer.from([0])]);
    await refused(await register(rsa, {}, { public_key: padded.toString("base64url") }), "INVALID_REQUEST");
    await refused(await register(pk, {}, { algorithm: -35 }), "INVALID_REQUEST", /algorithm is/);
  });

  test("padded or loose base64 is refused rather than decoded leniently", async () => {
    const pk = passkey();
    const ch = await challenge();
    const a = assertion(pk, ch);
    const out = await call("POST", "/v1/passkeys/verify", undefined, {
      challenge: ch, ...a, signature: `${a.signature}==`,
      public_key: pk.spki.toString("base64url"), algorithm: pk.algorithm,
    });
    await refused(out, "INVALID_REQUEST", /signature/);
  });
});

describe("which passkey answered", () => {
  test("an unregistered passkey signing in is told to register", async () => {
    const out = await signIn(passkey());
    assert.equal(out.status, 404);
    assert.equal(out.body.error.code, "PASSKEY_NOT_REGISTERED");
  });

  test("a credential id belongs to the first key registered with it", async () => {
    const first = passkey();
    assert.equal((await register(first)).status, 200);
    const squatter = passkey();
    squatter.credentialId = first.credentialId;
    const out = await register(squatter);
    assert.equal(out.body.error.code, "PASSKEY_TAKEN", JSON.stringify(out.body));
    // And the rightful passkey still signs in.
    assert.equal((await signIn(first)).status, 200);
  });

  test("a counter that counts must move forwards, and one that keeps none is left alone", async () => {
    const counting = passkey();
    assert.equal((await register(counting, { signCount: 5 })).status, 200);
    const stale = await signIn(counting, { signCount: 5 });
    assert.equal(stale.body.error.code, "PASSKEY_INVALID", JSON.stringify(stale.body));
    assert.match(stale.body.error.detail, /counter/);
    assert.equal((await signIn(counting, { signCount: 6 })).status, 200);

    const synced = passkey();
    assert.equal((await register(synced)).status, 200);
    assert.equal((await signIn(synced)).status, 200);
    assert.equal((await signIn(synced)).status, 200);
  });

  test("a blocked passkey KEY is refused at sign-in, like any blocked KEY", async () => {
    const pk = passkey();
    const reg = (await register(pk)).body;
    await fixture.owner`update schellingaf.peers set blocked_at = now(), blocked_reason = 'test'
                          where peer_id = ${Buffer.from(reg.peer_id, "hex")}`;
    const out = await signIn(pk);
    assert.equal(out.body.error.code, "KEY_BLOCKED", JSON.stringify(out.body));
  });

  test("the key and its credential can never be changed, and the counter never goes back", async () => {
    const pk = passkey();
    const reg = (await register(pk, { signCount: 9 })).body;
    const id = Buffer.from(reg.peer_id, "hex");
    await assert.rejects(fixture.owner`update schellingaf.passkeys set sign_count = 1 where peer_id = ${id}`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`update schellingaf.passkeys set algorithm = -8 where peer_id = ${id}`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`delete from schellingaf.passkeys where peer_id = ${id}`, /IMMUTABLE_RECORD/);
    await assert.rejects(
      fixture.owner`update schellingaf.peers set key_type = 'ed25519' where peer_id = ${id}`,
      /IMMUTABLE_RECORD/,
    );
  });

  test("the api role reads passkeys and cannot write them except through the functions", async () => {
    await assert.rejects(
      fixture.api`insert into schellingaf.passkeys (credential_id, peer_id, algorithm, public_key)
                  values (${randomBytes(16)}, ${randomBytes(32)}, -7, ${randomBytes(91)})`,
      /permission denied/,
    );
    const [row] = await fixture.api<{ n: number }[]>`select count(*)::int as n from schellingaf.passkeys`;
    assert.ok((row?.n ?? 0) > 0);
  });
});

describe("a deployment that accepts no passkey", () => {
  test("says so on both routes and in the capability document", async () => {
    for (const path of ["/v1/passkeys/challenge", "/v1/passkeys/verify"]) {
      const out = await call("POST", path, undefined, {}, bare);
      assert.equal(out.status, 501, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "PASSKEYS_UNAVAILABLE");
    }
    const none = await call("GET", "/v1/capabilities", undefined, undefined, bare);
    assert.equal(none.body.protocol.passkeys.status, "unavailable");
    const some = await call("GET", "/v1/capabilities");
    assert.deepEqual(
      { status: some.body.protocol.passkeys.status, rp_id: some.body.protocol.passkeys.rp_id, origins: some.body.protocol.passkeys.origins },
      { status: "available", rp_id: RP_ID, origins: [ORIGIN] },
    );
  });
});
