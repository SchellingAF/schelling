// A post can be signed by its author's KEY, every post sits in its SPACE's chain,
// and a SPACE can refuse any post that is not signed.
//
// Every signature here is real: Ed25519 keys made in this process, and passkeys
// from the software authenticator in test/lib/passkey.ts, which builds exactly
// what a browser's prompt returns. Every chain link is recomputed here
// with src/domain/objects.ts from what the service returns, which is how a mirror
// or the website checks one, so a link the database got wrong fails here even if
// the database agrees with itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { useService, fixture, call, agent, passkey, passkeyAssertion, type Agent, type Passkey } from "./lib/service.ts";
import {
  admissionOf,
  buildPostObject,
  commandIdOf,
  controlChainOf,
  controlGenesisOf,
  objectChainOf,
  objectGenesisOf,
  objectIdOf,
  passkeyChallengeOf,
  privateDigestOf,
  signaturePreimageOf,
  type PostFields,
} from "../src/domain/objects.ts";

const HOST = "api.signatures.test";
const RP_ID = "signatures.test";
const ORIGIN = "https://signatures.test";

useService("signatures", { apiHost: HOST, passkeys: { rpId: RP_ID, origins: [ORIGIN] } });

// ── the callers ──────────────────────────────────────────────────────────────

/** A passkey KEY, registered, with a token. */
async function passkeyAgent(): Promise<Passkey & { token: string; peerId: string }> {
  const pk = passkey();
  const ch = await call("POST", "/v1/passkeys/challenge", undefined, {});
  const out = await call("POST", "/v1/passkeys/verify", undefined, {
    challenge: ch.body.challenge,
    ...assertion(pk, Buffer.from(ch.body.challenge, "hex")),
    public_key: pk.spki.toString("base64url"),
    algorithm: -7,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { ...pk, token: out.body.token, peerId: out.body.peer_id };
}

/** The passkey's answer to a prompt on this file's site, or on another origin. */
function assertion(pk: Passkey, challenge: Buffer, prompt: { signCount?: number; origin?: string } = {}) {
  return passkeyAssertion(pk, challenge, { rpId: RP_ID, origin: prompt.origin ?? ORIGIN, signCount: prompt.signCount });
}

async function makeSpace(owner: { token: string }, options: Record<string, unknown> = {}) {
  const name = `sig-${randomUUID().slice(0, 8)}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Signed", ...options });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const profile = await call("GET", `/v1/spaces/${name}`, owner.token);
  return { name, id: profile.body.space_id as string };
}

function fields(author: string, spaceId: string, extra: Partial<PostFields> = {}): PostFields {
  return {
    spaceId,
    author,
    idempotencyKey: `k-${randomUUID()}`,
    kind: "result",
    title: "Build passes",
    body: "Reproduced on linux, twice.",
    to: [],
    replyTo: null,
    supersedes: null,
    retracts: null,
    fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }],
    data: null,
    budget: null,
    runId: null,
    ...extra,
  };
}

/** What an agent sends for a post it signs with its Ed25519 KEY. */
function signedBody(who: Agent, built: ReturnType<typeof buildPostObject>) {
  return {
    alg: "ed25519",
    canonical: built.canonical.toString("base64url"),
    ...(built.private ? { private: built.private.toString("base64url") } : {}),
    signature: sign(null, signaturePreimageOf(built.objectId), who.privateKey).toString("hex"),
  };
}

async function postCount(spaceName: string): Promise<number> {
  const [row] = await fixture.owner<{ n: number }[]>`
    select count(*)::int as n from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where s.name = ${spaceName}`;
  return row!.n;
}

/** Check one post's link as a mirror would, from what the service returned to a member. */
async function checkLink(spaceId: string, post: any) {
  const chain = post.proof.chain;
  const objectId = Buffer.from(post.proof.object_id, "hex");
  if (post.proof.canonical !== null) {
    assert.deepEqual(objectIdOf(Buffer.from(post.proof.canonical, "base64url")), objectId, "object_id is not the hash of canonical");
  }
  const [event] = await fixture.owner<{ chain_hash: Buffer }[]>`
    select chain_hash from schellingaf.space_event_objects
     where space_id = ${spaceId}::uuid and revision = ${chain.admitted_revision}::bigint`;
  assert.equal(chain.admitted_control_hash, event!.chain_hash.toString("hex"), "the admission names another control link");
  const admission = admissionOf(BigInt(chain.admitted_revision), Buffer.from(chain.admitted_control_hash, "hex"));
  assert.equal(chain.admission, admission.toString("hex"));
  if (chain.seq === "1") assert.equal(chain.previous_hash, objectGenesisOf(spaceId).toString("hex"));
  const link = objectChainOf(spaceId, BigInt(chain.seq), admission, Buffer.from(chain.previous_hash, "hex"), objectId);
  assert.equal(chain.chain_hash, link.toString("hex"), "the chain hash is not its formula");
}

// ── signed with an Ed25519 KEY ───────────────────────────────────────────────

describe("a post signed with an Ed25519 KEY", () => {
  test("is accepted, stores the author's exact bytes, and verifies from what a reader is given", async () => {
    const owner = await agent();
    const s = await makeSpace(owner);
    const built = buildPostObject(fields(owner.peerId, s.id, {
      body: "Line one\nline \"two\" with a backslash \\ and café",
      fingerprints: [
        { scheme: "task.reference", value: "zeta" },
        { scheme: "git.commit", value: "b75e527" },
        { scheme: "task.reference", value: "alpha" },
      ],
    }));
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, built));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);
    assert.equal(out.body.object_id, built.objectId.toString("hex"));

    const one = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
    assert.equal(one.status, 200);
    assert.equal(one.body.signed, true);
    assert.equal(one.body.proof.canonical, built.canonical.toString("base64url"), "the stored bytes are not the author's");
    assert.equal(one.body.proof.signature.alg, "ed25519");
    assert.equal(one.body.proof.signature.public_key, owner.publicKey);
    // The signature verifies against the key it names, for the bytes it came with.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(owner.publicKey, "hex")]), format: "der", type: "spki" });
    assert.ok(verify(null, signaturePreimageOf(objectIdOf(Buffer.from(one.body.proof.canonical, "base64url"))), key, Buffer.from(one.body.proof.signature.value, "hex")));
    // And the rendered fields are what the signed bytes say.
    const signed = JSON.parse(Buffer.from(one.body.proof.canonical, "base64url").toString("utf8"));
    assert.equal(signed.body, one.body.body);
    assert.deepEqual(signed.fingerprints, one.body.fingerprints, "fingerprints render in the order the object sorts them");
    await checkLink(s.id, one.body);
  });

  test("keeps budget, data and run_id in a private part that only members are shown", async () => {
    const owner = await agent();
    const [created] = await fixture.owner<{ created: { space_id: string } }[]>`
      select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${"sig-public-private"}, ${"Public"}, ${""}, ${"invite"}, ${"public"}) as created`;
    const spaceId = created!.created.space_id;
    const built = buildPostObject(fields(owner.peerId, spaceId, {
      data: { x_note: "kept", ratio: 0.25, count: 3 },
      budget: { observed_at: "2026-09-15T10:00:00Z", output_tokens: { remaining: "4000", unit: "token", estimated: true } },
      runId: randomUUID(),
    }));
    const out = await call("POST", `/v1/spaces/sig-public-private/posts`, owner.token, signedBody(owner, built));
    assert.equal(out.status, 201, JSON.stringify(out.body));

    const member = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
    assert.equal(member.body.proof.private, built.private!.toString("base64url"));
    assert.deepEqual(member.body.data, { x_note: "kept", ratio: 0.25, count: 3 });

    const stranger = await call("GET", `/v1/posts/${out.body.post_id}`);
    assert.equal(stranger.status, 200);
    assert.equal("private" in stranger.body.proof, false, "the private part reached a reader outside the SPACE");
    assert.equal("data" in stranger.body, false);
    const object = JSON.parse(Buffer.from(stranger.body.proof.canonical, "base64url").toString("utf8"));
    assert.equal(object.private_digest, privateDigestOf(built.private!).toString("hex"), "the object commits to the private part");
    assert.equal("data" in object, false, "the signed object carries data in the clear");
  });

  test("is refused before anything is written when the bytes or the signature are wrong", async () => {
    const owner = await agent();
    const other = await agent();
    const s = await makeSpace(owner);
    const good = buildPostObject(fields(owner.peerId, s.id));
    const before = await postCount(s.name);

    // One letter of the body changed: still a valid, canonical object, and no
    // longer the bytes that were signed.
    const tampered = Buffer.from(good.canonical.toString("utf8").replace("twice", "twicf"), "utf8");
    assert.notDeepEqual(tampered, good.canonical);
    // One byte of the structure changed: not JSON at all.
    const broken = Buffer.from(good.canonical);
    broken[broken.length - 1] = 0x5d;
    const reject = async (payload: Record<string, unknown>, code: string, detail?: RegExp) => {
      const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, payload);
      assert.equal(out.body?.error?.code, code, `${JSON.stringify(payload).slice(0, 120)} -> ${JSON.stringify(out.body)}`);
      if (detail) assert.match(out.body.error.detail ?? "", detail);
    };
    const base = signedBody(owner, good);

    await reject({ ...base, signature: sign(null, signaturePreimageOf(good.objectId), other.privateKey).toString("hex") }, "POST_SIGNATURE_INVALID");
    await reject({ ...base, canonical: tampered.toString("base64url") }, "POST_SIGNATURE_INVALID", /does not verify/);
    await reject({ ...base, canonical: broken.toString("base64url") }, "INVALID_REQUEST", /not JSON/);
    await reject({ ...base, signature: sign(null, good.objectId, owner.privateKey).toString("hex") }, "POST_SIGNATURE_INVALID");
    await reject({ ...base, kind: "obs" }, "INVALID_REQUEST", /canonical only/);
    await reject({ ...base, alg: "rsa" }, "INVALID_REQUEST", /alg is ed25519 or webauthn/);

    const shaped = async (object: Record<string, unknown>, detail: RegExp) => {
      const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)))), "utf8");
      await reject({ alg: "ed25519", canonical: bytes.toString("base64url"), signature: sign(null, signaturePreimageOf(objectIdOf(bytes)), owner.privateKey).toString("hex") }, "INVALID_REQUEST", detail);
    };
    const object = JSON.parse(good.canonical.toString("utf8"));
    await shaped({ ...object, v: 2 }, /v is 1/);
    await shaped({ ...object, space_id: randomUUID() }, /space_id/);
    await shaped({ ...object, author_id: other.peerId }, /author_id/);
    await shaped({ ...object, extra: "field" }, /not a field/);
    await shaped({ ...object, title: null }, /omit a field/);
    await shaped({ ...object, body: "" }, /omitted when empty/);
    const { idempotency_key: _drop, ...noKey } = object;
    await shaped(noKey, /idempotency_key is required/);
    await shaped({ ...object, to: [other.peerId, owner.peerId].sort().reverse() }, /ascending/);
    await shaped({ ...object, fingerprints: [{ scheme: "task.reference", value: "b" }, { scheme: "git.commit", value: "a" }] }, /ascending/);
    await shaped({ ...object, private_digest: "ab".repeat(32) }, /not sent/);
    // Not canonical: the same object with a space after a comma.
    const spaced = Buffer.from(good.canonical.toString("utf8").replace(",", ", "), "utf8");
    await reject({ alg: "ed25519", canonical: spaced.toString("base64url"), signature: sign(null, signaturePreimageOf(objectIdOf(spaced)), owner.privateKey).toString("hex") }, "INVALID_REQUEST", /RFC 8785/);

    assert.equal(await postCount(s.name), before, "a refused signed post was written");
  });

  test("replays as the original post, and never signs or unsigns a post after the fact", async () => {
    const owner = await agent();
    const s = await makeSpace(owner);
    const f = fields(owner.peerId, s.id);
    const built = buildPostObject(f);
    const first = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, built));
    assert.equal(first.status, 201);
    const again = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, built));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.post_id, first.body.post_id);
    assert.equal(again.body.object_id, first.body.object_id);

    // The same key, the same content, posted unsigned: that is not this post.
    const unsigned = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
      kind: f.kind, title: f.title, body: f.body, fingerprints: f.fingerprints, idempotency_key: f.idempotencyKey,
    });
    assert.equal(unsigned.body.error?.code, "IDEMPOTENCY_CONFLICT", JSON.stringify(unsigned.body));

    // And a post made unsigned is never signed by a replay.
    const key = `k-${randomUUID()}`;
    const plain = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "plain", idempotency_key: key });
    assert.equal(plain.status, 201);
    const late = buildPostObject(fields(owner.peerId, s.id, { kind: "obs", title: "A POST in a test", body: "plain", fingerprints: [], idempotencyKey: key }));
    const signLater = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, late));
    assert.equal(signLater.body.error?.code, "IDEMPOTENCY_CONFLICT", JSON.stringify(signLater.body));
  });

  test("a passkey KEY cannot sign as ed25519, and an Ed25519 KEY's signature must be its own", async () => {
    const person = await passkeyAgent();
    const s = await makeSpace(person);
    const built = buildPostObject(fields(person.peerId, s.id));
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, {
      alg: "ed25519",
      canonical: built.canonical.toString("base64url"),
      signature: "00".repeat(64),
    });
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(out.body.error.detail, /passkey/);
  });
});

// ── signed with a passkey ─────────────────────────────────────────────────────

describe("a post signed with a passkey", () => {
  test("is accepted when the prompt's challenge is the hash of the object-signature preimage", async () => {
    const person = await passkeyAgent();
    const s = await makeSpace(person);
    const built = buildPostObject(fields(person.peerId, s.id, { title: "A signed POST in a test", fingerprints: [] }));
    const a = assertion(person, passkeyChallengeOf(built.objectId));
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, {
      alg: "webauthn", canonical: built.canonical.toString("base64url"), ...a,
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);

    const one = await call("GET", `/v1/posts/${out.body.post_id}`, person.token);
    const sig = one.body.proof.signature;
    assert.equal(sig.alg, "webauthn");
    assert.equal(sig.key_algorithm, "ES256");
    assert.equal(sig.public_key, person.spki.toString("base64url"));
    assert.equal(sig.client_data_json, a.client_data_json);
    const client = JSON.parse(Buffer.from(sig.client_data_json, "base64url").toString("utf8"));
    assert.equal(client.challenge, passkeyChallengeOf(objectIdOf(Buffer.from(one.body.proof.canonical, "base64url"))).toString("base64url"));
    await checkLink(s.id, one.body);
  });

  test("is refused for a sign-in challenge, another KEY's passkey, or a copied authenticator", async () => {
    const person = await passkeyAgent();
    const stranger = await passkeyAgent();
    const s = await makeSpace(person);
    const built = buildPostObject(fields(person.peerId, s.id));
    const body = (a: Record<string, string>) => ({ alg: "webauthn", canonical: built.canonical.toString("base64url"), ...a });

    // A real sign-in challenge from this service, signed by the right passkey.
    const ch = await call("POST", "/v1/passkeys/challenge", undefined, {});
    let out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, body(assertion(person, Buffer.from(ch.body.challenge, "hex"))));
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID", JSON.stringify(out.body));
    assert.match(out.body.error.detail, /challenge/);

    // The raw object_id as the challenge, rather than the hash of its preimage.
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, body(assertion(person, built.objectId)));
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");

    // Another KEY's passkey, over the right challenge.
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, body(assertion(stranger, passkeyChallengeOf(built.objectId))));
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(out.body.error.detail, /credential_id/);

    // The wrong origin.
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, body(assertion(person, passkeyChallengeOf(built.objectId), { origin: "https://elsewhere.test" })));
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");

    // A counting authenticator: 5, then 5 again for a different post, is a copy.
    const counted = buildPostObject(fields(person.peerId, s.id));
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, { alg: "webauthn", canonical: counted.canonical.toString("base64url"), ...assertion(person, passkeyChallengeOf(counted.objectId), { signCount: 5 }) });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const exact = { alg: "webauthn", canonical: counted.canonical.toString("base64url"), ...assertion(person, passkeyChallengeOf(counted.objectId), { signCount: 5 }) };
    const copied = buildPostObject(fields(person.peerId, s.id));
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, { alg: "webauthn", canonical: copied.canonical.toString("base64url"), ...assertion(person, passkeyChallengeOf(copied.objectId), { signCount: 5 }) });
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(out.body.error.detail, /counter/);
    // The very same request again is a retry of a post that succeeded, not a copy.
    // ECDSA signs randomly, so the bytes differ, and the authenticator data do not.
    out = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, exact);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.replayed, true);
  });
});

// ── a SPACE that accepts only signed posts ────────────────────────────────────

describe("a SPACE that accepts only signed posts", () => {
  test("refuses an unsigned post, takes a signed one, and records who changed the rule", async () => {
    const owner = await agent();
    const s = await makeSpace(owner, { signed_only: true });
    const profile = await call("GET", `/v1/spaces/${s.name}`);
    assert.equal(profile.body.signed_only, true);

    const unsigned = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "go", body: "deploy" });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.body.error.code, "SIGNATURE_REQUIRED");

    const signed = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, buildPostObject(fields(owner.peerId, s.id, { kind: "go", title: null, body: "deploy", fingerprints: [] }))));
    assert.equal(signed.status, 201, JSON.stringify(signed.body));

    const off = await call("PATCH", `/v1/spaces/${s.name}`, owner.token, { signed_only: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const later = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "unsigned again" });
    assert.equal(later.status, 201);

    const events = await call("GET", `/v1/spaces/${s.name}/events`, owner.token);
    assert.equal(events.body.items[0].payload.signed_only, true, "creation records the rule");
    assert.deepEqual(events.body.items.at(-1).payload, { signed_only: false }, "and the change is an event");

    const refused = await call("PATCH", `/v1/spaces/${s.name}`, owner.token, { signed_only: "yes" });
    assert.equal(refused.status, 400);
  });
});

// ── the chains ────────────────────────────────────────────────────────────────

describe("every post and every event sits in its SPACE's chain", () => {
  test("posts from concurrent writers, signed and not, link in order from genesis", async () => {
    const owner = await agent();
    const writers = [owner, await agent(), await agent()];
    const s = await makeSpace(owner);
    for (const w of writers.slice(1)) {
      const granted = await call("PUT", `/v1/spaces/${s.name}/members/${w.peerId}`, owner.token, { role: "writer" });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
    }
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const w = writers[i % writers.length]!;
        return i % 2 === 0
          ? call("POST", `/v1/spaces/${s.name}/posts`, w.token, { kind: "obs", body: `unsigned ${i}` })
          : call("POST", `/v1/spaces/${s.name}/posts`, w.token, signedBody(w, buildPostObject(fields(w.peerId, s.id, { body: `signed ${i}` }))));
      }),
    );
    const ids = await fixture.owner<{ post_id: string }[]>`
      select p.post_id::text from schellingaf.posts p where p.space_id = ${s.id}::uuid order by p.seq`;
    assert.equal(ids.length, 24);
    let previous = objectGenesisOf(s.id).toString("hex");
    for (const { post_id } of ids) {
      const one = await call("GET", `/v1/posts/${post_id}`, owner.token);
      assert.equal(one.body.proof.chain.previous_hash, previous, `post ${one.body.seq} does not follow the one before it`);
      await checkLink(s.id, one.body);
      previous = one.body.proof.chain.chain_hash;
    }
  });

  test("every governance event links from genesis, and a post commits to the event it was admitted under", async () => {
    const owner = await agent();
    const writer = await agent();
    const s = await makeSpace(owner);
    await call("PATCH", `/v1/spaces/${s.name}`, owner.token, { title: "Renamed" });
    await call("PUT", `/v1/spaces/${s.name}/members/${writer.peerId}`, owner.token, { role: "writer" });
    const posted = await call("POST", `/v1/spaces/${s.name}/posts`, writer.token, { kind: "obs", body: "after the grant" });
    assert.equal(posted.status, 201);

    const events = await fixture.owner<{ revision: string; canonical: Buffer; command_id: Buffer; previous_hash: Buffer; chain_hash: Buffer }[]>`
      select revision::text, canonical, command_id, previous_hash, chain_hash
        from schellingaf.space_event_objects where space_id = ${s.id}::uuid order by revision`;
    assert.equal(events.length, 3);
    let previous = controlGenesisOf(s.id);
    for (const e of events) {
      assert.deepEqual(e.previous_hash, previous);
      assert.deepEqual(commandIdOf(e.canonical), e.command_id);
      assert.deepEqual(controlChainOf(s.id, BigInt(e.revision), previous, e.command_id), e.chain_hash);
      previous = e.chain_hash;
    }
    const object = JSON.parse(events[2]!.canonical.toString("utf8"));
    assert.equal(object.event, "member.granted");
    assert.equal(object.revision, "3");

    const one = await call("GET", `/v1/posts/${posted.body.post_id}`, owner.token);
    assert.equal(one.body.proof.chain.admitted_revision, "3");
    assert.equal(one.body.proof.chain.admitted_control_hash, events[2]!.chain_hash.toString("hex"));
  });

  test("a withheld post keeps its object id and its link, and loses its bytes and signature", async () => {
    const owner = await agent();
    const s = await makeSpace(owner);
    const built = buildPostObject(fields(owner.peerId, s.id));
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, signedBody(owner, built));
    await fixture.owner`insert into schellingaf.withheld (post_id, space_id, reason) values (${out.body.post_id}::uuid, ${s.id}::uuid, 'malware')`;
    const one = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
    assert.equal(one.body.proof.object_id, built.objectId.toString("hex"));
    assert.equal(one.body.proof.canonical, null);
    assert.equal(one.body.proof.signature, null);
    assert.match(one.body.proof.chain.chain_hash, /^[0-9a-f]{64}$/);
  });

  test("a SPACE whose chain has a gap refuses the next post rather than linking across it", async () => {
    const owner = await agent();
    const s = await makeSpace(owner);
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      values (${s.id}::uuid, 1, 1, ${Buffer.from(owner.peerId, "hex")}, 'obs', 'no object', ${randomBytes(32)})`;
    await fixture.owner`update schellingaf.spaces set last_seq = 1 where space_id = ${s.id}::uuid`;
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "next" });
    assert.equal(out.status, 500);
    assert.equal(out.body.error.code, "CHAIN_BROKEN");
    const [linked] = await fixture.owner<{ n: number }[]>`select schellingaf.link_posts(${s.id}::uuid) as n`;
    assert.equal(linked!.n, 1, "the backfill links the post that had no object");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "next" })).status, 201);
  });
});

// ── two builders, one object ──────────────────────────────────────────────────

describe("the database and src/domain/objects.ts write the same object", () => {
  test("for a post with every field, unicode, escapes and numbers", async () => {
    const owner = await agent();
    const reader = await agent();
    const s = await makeSpace(owner);
    await call("PUT", `/v1/spaces/${s.name}/members/${reader.peerId}`, owner.token, { role: "writer" });
    const parent = await call("POST", `/v1/spaces/${s.name}/posts`, reader.token, { kind: "question", body: "why?" });
    const tab = String.fromCharCode(9);
    const bell = String.fromCharCode(7);
    const post = {
      kind: "result",
      title: `A title with "quotes" and ${tab}a tab`,
      body: `multi\nline ${bell} body   with é and 😀 and a backslash \\`,
      to: [reader.peerId],
      reply_to: parent.body.post_id,
      fingerprints: [
        { scheme: "task.reference", value: "été" },
        { scheme: "task.reference", value: "Zebra" },
        { scheme: "task.reference", value: "😀" },
        { scheme: "git.commit", value: "b75e527" },
      ],
      data: { x_int: 42, x_neg: -7, x_float: 0.5, x_big: 9007199254740991, x_nested: { b: [1, 2, { c: null }], a: true } },
      budget: { observed_at: "2026-09-15T10:00:00Z", compute: { remaining: null, unit: null, estimated: null } },
      run_id: randomUUID(),
    };
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, post);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [row] = await fixture.owner<{ canonical: Buffer; private: Buffer }[]>`
      select canonical, private from schellingaf.post_objects where post_id = ${out.body.post_id}::uuid`;
    const salt = Buffer.from(JSON.parse(row!.private.toString("utf8")).salt, "hex");
    const rebuilt = buildPostObject({
      spaceId: s.id,
      author: owner.peerId,
      idempotencyKey: null,
      kind: post.kind,
      title: post.title,
      body: post.body,
      to: post.to,
      replyTo: post.reply_to,
      supersedes: null,
      retracts: null,
      fingerprints: post.fingerprints,
      data: post.data,
      budget: post.budget as never,
      runId: post.run_id,
    }, salt);
    assert.equal(row!.private.toString("utf8"), rebuilt.private!.toString("utf8"), "the private parts differ");
    assert.equal(row!.canonical.toString("utf8"), rebuilt.canonical.toString("utf8"), "the objects differ");
    assert.equal("idempotency_key" in JSON.parse(row!.canonical.toString("utf8")), false);
  });

  test("and the database refuses to store a signed object its columns do not match", async () => {
    const owner = await agent();
    const s = await makeSpace(owner);
    const built = buildPostObject(fields(owner.peerId, s.id));
    await assert.rejects(
      fixture.owner`
        select schellingaf.append_post(${s.name}, ${Buffer.from(owner.peerId, "hex")}, 'result', 'Build passes',
          'a different body', null, null, '{}'::bytea[], null, null, null, null,
          ${fixture.owner.json([{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }] as never)},
          ${JSON.parse(built.canonical.toString("utf8")).idempotency_key}, 200,
          ${built.canonical}, null, 'ed25519', ${randomBytes(64)}, null)`,
      /OBJECT_MISMATCH/,
    );
  });
});
