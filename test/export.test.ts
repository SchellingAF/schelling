// A mirror can check a SPACE's whole record without trusting the service, and the
// two examples an agent copies sign and check a post.
//
// scripts/verify-export.ts runs here against the in-process service, over a SPACE
// holding every shape of post: unsigned, signed with an Ed25519 KEY and a private
// part, signed with a passkey, a reply, a correction and a withheld post, with its
// governance log and checkpoints over both. Then the answers are altered in transit
// the ways a dishonest server or a broken mirror would alter them, and every
// alteration must be named.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useService, app, db, fixture, send, read, agent, passkey, passkeyAssertion, type Agent } from "./lib/service.ts";
import { buildPostObject, passkeyChallengeOf, signaturePreimageOf } from "../src/domain/objects.ts";
import { developmentServiceKey } from "../src/domain/service.ts";
import { makeCheckpoints } from "../src/db/checkpoints.ts";
import { verifyExport, type Fetcher } from "../scripts/verify-export.ts";
import { verifyCheckpoint, verifyPost } from "../src/domain/verify.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "api.export.test";
const RP_ID = "export.test";
const ORIGIN = "https://export.test";
const key = developmentServiceKey();
const scratch = mkdtempSync(path.join(tmpdir(), "schellingaf-export-"));

const ready = useService("export", { apiHost: HOST, passkeys: { rpId: RP_ID, origins: [ORIGIN] }, serviceKey: key });

let owner: Agent;
let space: { name: string; id: string };

/** A request as this file sends it: no category added to anything it posts. */
async function call(method: string, p: string, token?: string, payload?: unknown) {
  return read(await send(app, method, p, token, payload));
}

before(async () => {
  await ready;
  owner = await agent();
  const name = `export-${randomUUID().slice(0, 8)}`;
  const [row] = await fixture.owner<{ created: { space_id: string } }[]>`
    select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${name}, ${"Exported"}, ${""}, ${"invite"}, ${"public"}) as created`;
  space = { name, id: row!.created.space_id };

  // A person with a passkey, made a writer.
  const pk = passkey();
  const assertion = (challenge: Buffer) => passkeyAssertion(pk, challenge, { rpId: RP_ID, origin: ORIGIN });
  const ch = await call("POST", "/v1/passkeys/challenge", undefined, {});
  const person = await call("POST", "/v1/passkeys/verify", undefined, {
    challenge: ch.body.challenge, ...assertion(Buffer.from(ch.body.challenge, "hex")), public_key: pk.spki.toString("base64url"), algorithm: -7,
  });
  await call("PUT", `/v1/spaces/${name}/members/${person.body.peer_id}`, owner.token, { role: "writer" });

  const first = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "question", body: "Does it build?", fingerprints: [{ scheme: "task.reference", value: "build" }] });
  const built = buildPostObject({
    spaceId: space.id, author: owner.peerId, idempotencyKey: "signed", kind: "result", title: "It builds", body: "Yes.",
    to: [person.body.peer_id], replyTo: first.body.post_id, supersedes: null, retracts: null, fingerprints: [],
    data: { x_flags: ["-O2"] }, budget: null, runId: randomUUID(),
  });
  const signed = await call("POST", `/v1/spaces/${name}/posts`, owner.token, {
    alg: "ed25519", canonical: built.canonical.toString("base64url"), private: built.private!.toString("base64url"),
    signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
  });
  assert.equal(signed.status, 201, JSON.stringify(signed.body));
  const byPasskey = buildPostObject({
    spaceId: space.id, author: person.body.peer_id, idempotencyKey: "pk", kind: "ack", title: null, body: "Seen.",
    to: [], replyTo: signed.body.post_id, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
  });
  const pkPost = await call("POST", `/v1/spaces/${name}/posts`, person.body.token, {
    alg: "webauthn", canonical: byPasskey.canonical.toString("base64url"), ...assertion(passkeyChallengeOf(byPasskey.objectId)),
  });
  assert.equal(pkPost.status, 201, JSON.stringify(pkPost.body));
  await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "result", body: "Yes, with -O1.", supersedes: signed.body.post_id });
  const leak = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "token: schellingaf_leaked" });
  await fixture.owner`insert into schellingaf.withheld (post_id, space_id, reason) values (${leak.body.post_id}::uuid, ${space.id}::uuid, 'credential_exposure')`;
  for (let i = 0; i < 4; i++) await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: `after ${i}` });
  await makeCheckpoints(db, key, { minAgeSeconds: 0 });
  await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "not yet checkpointed" });
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const direct: Fetcher = async (url, init) => {
  const res = await app.request(url.replace("http://service", ""), { headers: init?.headers ?? {} });
  return { status: res.status, text: () => res.text() };
};

/** A fetcher that alters one kind of answer on its way to the verifier. */
function altered(match: RegExp, change: (text: string) => string): Fetcher {
  return async (url, init) => {
    const res = await direct(url, init);
    const text = await res.text();
    return { status: res.status, text: async () => (match.test(url) ? change(text) : text) };
  };
}

const verify = (fetcher: Fetcher, extra: Partial<Parameters<typeof verifyExport>[0]> = {}) =>
  verifyExport({ fetch: fetcher, api: "http://service", space: space.name, token: owner.token, root: key.root.toString("hex"), ...extra });

describe("the reference mirror verifier", () => {
  test("finds a whole SPACE's record holds, every shape of post, the log and the checkpoints", async () => {
    const result = await verify(direct);
    assert.deepEqual(result.problems, []);
    assert.equal(result.posts, 10);
    assert.ok((result.events ?? 0) >= 2);
    assert.ok(result.checkpoints >= 2);
    // A SPACE filed under no category exports like any other.
    assert.deepEqual((await call("GET", `/v1/spaces/${space.name}`, owner.token)).body.categories, []);
  });

  test("names an altered body", async () => {
    const result = await verify(altered(/\/posts\?after=/, (t) => t.replace("Does it build?", "Does it fly?")));
    assert.ok(result.problems.some((p) => /body is not what the object says/.test(p)), result.problems.join("\n"));
    assert.ok(result.problems.some((p) => /do not hash to its trailer/.test(p)));
  });

  test("names a private part that is not JSON, and goes on to check the rest", async () => {
    const garbled = Buffer.from("not json", "utf8").toString("base64url");
    const result = await verify(altered(/\/posts\?after=/, (t) => t.replace(/"private":"[A-Za-z0-9_-]+"/, `"private":"${garbled}"`)));
    assert.ok(result.problems.some((p) => /the private part is not a JSON object/.test(p)), result.problems.join("\n"));
    assert.ok(result.problems.some((p) => /do not hash to its trailer/.test(p)));
  });

  // Bytes that are not JSON, and JSON that is not an object: each is named, and the
  // verifier goes on rather than stopping at the first thing it cannot read.
  const unreadable = ["not json", "[]"].map((text) => Buffer.from(text, "utf8").toString("base64url"));

  test("names a post whose canonical bytes are not the signed object, and goes on to check the rest", async () => {
    for (const text of ["not json", "null", "[]", "7", '"x"']) {
      const garbled = Buffer.from(text, "utf8").toString("base64url");
      const result = await verify(altered(/\/posts\?after=/, (t) => t.replace(/"canonical":"[A-Za-z0-9_-]+"/, `"canonical":"${garbled}"`)));
      assert.ok(result.problems.some((p) => /^post 1: canonical is not a JSON object$/.test(p)), `${text}: ${result.problems.join("\n")}`);
      assert.ok(result.problems.some((p) => /^post 1: object_id is not the hash of its canonical bytes$/.test(p)), `${text}: ${result.problems.join("\n")}`);
    }
    // An object, but without the fields every post's object carries.
    const empty = Buffer.from("{}", "utf8").toString("base64url");
    const result = await verify(altered(/\/posts\?after=/, (t) => t.replace(/"canonical":"[A-Za-z0-9_-]+"/, `"canonical":"${empty}"`)));
    for (const field of ["author", "space_id", "kind", "body", "fingerprints"]) {
      assert.ok(result.problems.includes(`post 1: ${field} is not what the object says`), `${field}: ${result.problems.join("\n")}`);
    }
  });

  test("names an event whose bytes are not a JSON object, and goes on to check the rest", async () => {
    for (const garbled of unreadable) {
      const result = await verify(altered(/\/events\?after=/, (t) => t.replace(/"canonical":"[A-Za-z0-9_-]+"/, `"canonical":"${garbled}"`)));
      assert.ok(result.problems.some((p) => /^event \d+: its bytes are not a JSON object$/.test(p)), result.problems.join("\n"));
      assert.ok(result.problems.some((p) => /command_id is not the hash of its bytes/.test(p)), result.problems.join("\n"));
    }
  });

  test("names an event whose bytes leave out its payload", async () => {
    const withoutPayload = (canonical: string) => {
      const { payload: _payload, ...rest } = JSON.parse(Buffer.from(canonical, "base64url").toString("utf8"));
      return Buffer.from(JSON.stringify(rest), "utf8").toString("base64url");
    };
    const result = await verify(
      altered(/\/events\?after=/, (t) => t.replace(/"canonical":"([A-Za-z0-9_-]+)"/, (_m, c) => `"canonical":"${withoutPayload(c)}"`)),
    );
    assert.ok(result.problems.some((p) => /^event \d+: the event is not what its bytes say$/.test(p)), result.problems.join("\n"));
  });

  test("names a checkpoint whose signed bytes or certificate are not a JSON object, and goes on to check the rest", async () => {
    const cases: [string, RegExp, RegExp][] = [
      ["canonical", /its signed bytes are not a JSON object/, /the signature does not verify against its signer/],
      ["certificate", /its certificate is not a JSON object/, /the certificate does not verify against its root/],
    ];
    for (const garbled of unreadable) {
      for (const [field, named, rest] of cases) {
        const result = await verify(altered(/\/checkpoints/, (t) => t.replace(new RegExp(`"${field}":"[A-Za-z0-9_-]+"`), `"${field}":"${garbled}"`)));
        assert.ok(result.problems.some((p) => named.test(p)), `${field}: ${result.problems.join("\n")}`);
        assert.ok(result.problems.some((p) => rest.test(p)), `${field}: ${result.problems.join("\n")}`);
      }
    }
  });

  test("names a missing post even when the page's hash was made to match", async () => {
    const drop = (text: string) => {
      const lines = text.trimEnd().split("\n");
      const trailer = JSON.parse(lines.pop()!);
      lines.splice(2, 1);
      trailer.export.segment_sha256 = createHash("sha256").update(lines.map((l) => `${l}\n`).join("")).digest("hex");
      return [...lines, JSON.stringify(trailer)].join("\n") + "\n";
    };
    const result = await verify(altered(/\/posts\?after=/, drop));
    assert.ok(result.problems.some((p) => /missing or out of order/.test(p)), result.problems.join("\n"));
    assert.ok(result.problems.some((p) => /holds \d+ of its \d+ positions/.test(p)), "the checkpoint over the gap should say so");
  });

  test("names a checkpoint whose root or signer was changed, or that another root signed", async () => {
    const result = await verify(altered(/\/checkpoints/, (t) => t.replace(/"merkle_root":"([0-9a-f])/, (_m, c) => `"merkle_root":"${c === "0" ? "1" : "0"}`)));
    assert.ok(result.problems.some((p) => /signed merkle_root is not the one served/.test(p)), result.problems.join("\n"));
    const other = await verify(direct, { root: "ab".repeat(32) });
    assert.ok(other.problems.some((p) => /not the root you trust/.test(p)));
  });

  test("names a SPACE whose posts the KEY may not read, rather than finding its record holds", async () => {
    const name = `export-private-${randomUUID().slice(0, 8)}`;
    await fixture.owner`
      select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${name}, ${"Private"}, ${""}, ${"invite"}, ${"private"})`;
    const stranger = await agent();
    const result = await verify(direct, { space: name, token: stranger.token });
    assert.deepEqual(result.problems, ["this KEY may not read the SPACE's posts"]);
  });

  test("a witness names a history that changed after it checked it", async () => {
    const witness = path.join(scratch, "witness.json");
    assert.deepEqual((await verify(direct, { witness })).problems, []);
    const forked = altered(/\/checkpoints/, (t) => {
      const body = JSON.parse(t);
      body.items = body.items.slice(1);
      return JSON.stringify(body);
    });
    const result = await verify(forked, { witness });
    assert.ok(result.problems.some((p) => /no longer served: the history changed/.test(p)), result.problems.join("\n"));
  });
});

describe("the scripts an agent copies", () => {
  test("GET /sign-post.mjs signs a post the service accepts, and GET /verify-post.mjs checks it and its proof", async () => {
    // Served exactly as the files the suite runs.
    const served = await app.request("/sign-post.mjs");
    assert.match(served.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(await served.text(), readFileSync(path.join(ROOT, "content", "sign-post.mjs"), "utf8"));
    const keydir = path.join(scratch, "key");
    mkdirSync(keydir, { recursive: true });
    writeFileSync(path.join(keydir, "key.pem"), owner.privateKey.export({ format: "pem", type: "pkcs8" }));
    const signedJson = spawnSync("node", [path.join(ROOT, "content", "sign-post.mjs"), space.id], {
      input: JSON.stringify({ kind: "result", title: "Signed by the example", body: "It works.", fingerprints: [{ scheme: "git.commit", value: "abc1234" }], data: { x_from: "example" } }),
      env: { ...process.env, KEYDIR: keydir },
      encoding: "utf8",
    });
    assert.equal(signedJson.status, 0, signedJson.stderr);
    const posted = await call("POST", `/v1/spaces/${space.name}/posts`, owner.token, JSON.parse(signedJson.stdout));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.signed, true);

    const one = await call("GET", `/v1/posts/${posted.body.post_id}`, owner.token);
    const run = (input: unknown, args: string[] = []) =>
      spawnSync("node", [path.join(ROOT, "content", "verify-post.mjs"), ...args], { input: JSON.stringify(input), encoding: "utf8" });
    let out = run(one.body);
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /the Ed25519 signature verifies/);
    assert.match(out.stdout, /verified/);

    out = run({ ...one.body, body: "It does not work." });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /FAIL post \d+: body is not what the object says/);

    await makeCheckpoints(db, key, { minAgeSeconds: 0 });
    const proof = await call("GET", `/v1/spaces/${space.name}/posts/${posted.body.seq}/proof`, owner.token);
    out = run(proof.body, ["--root", key.root.toString("hex")]);
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /the path leads from the leaf to the checkpoint's Merkle root/);
    assert.match(out.stdout, /the checkpoint was signed while the certificate was valid/);
    assert.match(out.stdout, /development key/);
    // A proof for a tree of another size than the checkpoint signed.
    out = run({ ...proof.body, inclusion: { ...proof.body.inclusion, tree_size: proof.body.inclusion.tree_size + 1 } }, ["--root", key.root.toString("hex")]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /FAIL the proof is for the tree the checkpoint signed/);

    // The passkey post, checked with the site that ran its prompt.
    const pkProof = await call("GET", `/v1/spaces/${space.name}/posts/3/proof`);
    out = run(pkProof.body, ["--rp-id", RP_ID, "--origin", ORIGIN, "--root", key.root.toString("hex")]);
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /ES256 passkey signature verifies/);
    assert.match(out.stdout, /object commits to a private part|unsigned|verified/);
  });

  // The download and the mirror verifier read the same proof, altered the ways a
  // dishonest server would alter it, and name the same faults in the same words. A
  // FAIL line of the download's that starts "post" or "checkpoint" is in the mirror's
  // words; the rest are what only the download checks (the leaf and its path).
  test("GET /verify-post.mjs names each fault the mirror verifier names, in its words", async () => {
    const root = key.root.toString("hex");
    const site = { rpId: RP_ID, origins: [ORIGIN] };
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    const decoded = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const flip = (h: string) => `${h[0] === "0" ? "1" : "0"}${h.slice(1)}`;
    const both = (input: any, trusted = root) => {
      const out = spawnSync("node", [path.join(ROOT, "content", "verify-post.mjs"), "--rp-id", RP_ID, "--origin", ORIGIN, "--root", trusted], {
        input: JSON.stringify(input),
        encoding: "utf8",
      });
      assert.ok(out.status === 0 || out.status === 1, `${out.status}: ${out.stderr}`);
      assert.equal(out.stderr, "", "the download threw");
      const fails = out.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5));
      const mirror = [
        ...verifyPost(input.post, site),
        ...verifyCheckpoint(input.checkpoint, input.post.space_id, null, { root: trusted, previous: null }),
      ];
      // Whether a checkpoint is the first is something only a verifier that walks the
      // whole record knows; the download sees one checkpoint.
      const walked = mirror.filter((m) => !m.endsWith(": the first checkpoint must start at 1 and name none before it"));
      return { status: out.status, fails, named: fails.filter((f) => /^(post|checkpoint) /.test(f)).sort(), mirror: walked.sort() };
    };

    // Post 1 is unsigned and follows the SPACE's genesis; post 2 is signed with an
    // Ed25519 KEY and has a private part; post 3 is signed with a passkey. All three
    // are in the first checkpoint.
    const first = (await call("GET", `/v1/spaces/${space.name}/posts/1/proof`, owner.token)).body;
    const ed = (await call("GET", `/v1/spaces/${space.name}/posts/2/proof`, owner.token)).body;
    const pk = (await call("GET", `/v1/spaces/${space.name}/posts/3/proof`, owner.token)).body;
    assert.equal(ed.checkpoint.first, "1");
    assert.ok(ed.post.proof.chain.admitted_control_hash);
    for (const input of [first, ed, pk]) {
      const clean = both(input);
      assert.equal(clean.status, 0, clean.fails.join("\n"));
      assert.deepEqual(clean.mirror, []);
    }

    const post = (base: any, change: (p: any) => void) => {
      const input = structuredClone(base);
      change(input.post);
      return input;
    };
    const proof = (base: any, change: (p: any) => void) => post(base, (p) => change(p.proof));
    const passkeySig = (change: (s: any) => void) => proof(pk, (p) => change(p.signature));
    const clientData = (change: (c: any) => void) =>
      passkeySig((s) => {
        const c = decoded(s.client_data_json);
        change(c);
        s.client_data_json = b64(JSON.stringify(c));
      });
    const authData = (change: (a: Buffer) => Buffer) =>
      passkeySig((s) => {
        s.authenticator_data = change(Buffer.from(s.authenticator_data, "base64url")).toString("base64url");
      });
    const checkpoint = (change: (c: any) => void) => {
      const input = structuredClone(ed);
      change(input.checkpoint);
      return input;
    };
    const certificate = (change: (c: any) => void) =>
      checkpoint((cp) => {
        const c = decoded(cp.signer.certificate);
        change(c);
        cp.signer.certificate = b64(JSON.stringify(c));
      });
    const cpAt = `checkpoint posts ${ed.checkpoint.first}-${ed.checkpoint.last}`;
    // A post whose object says it is sealed: digests that no shown part hashes to.
    const sealedObject = (p: any) => {
      p.proof.canonical = b64(JSON.stringify({ ...decoded(p.proof.canonical), sealed: { header: "00".repeat(32), ciphertext: "00".repeat(32) } }));
    };
    // A served field the checkpoint did not sign. A served stream, first or last is
    // also where the checkpoint is named.
    const served = (field: string, value: unknown): [string, any, string] => {
      const input = checkpoint((cp) => { cp[field] = value; });
      const { stream, first: from, last } = input.checkpoint;
      return [`served ${field}`, input, `checkpoint ${stream} ${from}-${last}: the signed ${field} is not the one served`];
    };

    const cases: [string, any, string, string?][] = [
      ...["not json", "null", "[]", "7", '"x"'].map((text): [string, any, string] => [`canonical ${text}`, proof(ed, (p) => { p.canonical = b64(text); }), "post 2: canonical is not a JSON object"]),
      ["canonical {}", proof(ed, (p) => { p.canonical = b64("{}"); }), "post 2: author is not what the object says"],
      ["canonical {} and no kind shown", post(ed, (p) => { p.proof.canonical = b64("{}"); delete p.kind; }), "post 2: kind is not what the object says"],
      ["body", post(ed, (p) => { p.body = "No."; }), "post 2: body is not what the object says"],
      ...([
        ["author", "ab".repeat(32)],
        ["space_id", randomUUID()],
        ["kind", "obs"],
        ["title", "It flies"],
        ["to", []],
        ["reply_to", randomUUID()],
        ["supersedes", randomUUID()],
        ["retracts", randomUUID()],
        ["fingerprints", [{ scheme: "git.commit", value: "abc1234" }]],
      ] as [string, unknown][]).map(([field, value]): [string, any, string] => [field, post(ed, (p) => { p[field] = value; }), `post 2: ${field} is not what the object says`]),
      ["sealed", post(ed, (p) => { p.sealed = { header: "", ciphertext: "" }; }), "post 2: sealed is not what the object says"],
      ["sealed digests", post(ed, (p) => { sealedObject(p); p.sealed = { header: b64("header"), ciphertext: b64("ciphertext") }; }), "post 2: the sealed header does not hash to the object's"],
      ["sealed parts not shown", post(ed, (p) => { sealedObject(p); p.sealed = {}; }), "post 2: a sealed post is checked with its header and ciphertext, which were not shown"],
      ["private digest", proof(ed, (p) => { p.private = b64(JSON.stringify(decoded(p.private), null, 1)); }), "post 2: the private part does not hash to private_digest"],
      ["private not json", proof(ed, (p) => { p.private = b64("not json"); }), "post 2: the private part is not a JSON object"],
      ["private data", proof(ed, (p) => { p.private = b64('{"data":{"x_flags":["-O3"]}}'); }), "post 2: data, budget or run_id is not the private part's"],
      ["ed25519 value", proof(ed, (p) => { p.signature.value = flip(p.signature.value); }), "post 2: the Ed25519 signature does not verify"],
      ["ed25519 key", proof(ed, (p) => { p.signature.public_key = "ab".repeat(32); }), "post 2: the signing key is not the author's KEY"],
      ["unknown alg", proof(ed, (p) => { p.signature.alg = "rsa"; }), "post 2: a signature of an unknown alg"],
      ["link position", proof(ed, (p) => { p.chain.seq = "5"; }), "post 2: the link names another position"],
      ["admission", proof(ed, (p) => { p.chain.admission = flip(p.chain.admission); }), "post 2: the admission is not its formula"],
      ["chain hash", proof(ed, (p) => { p.chain.chain_hash = flip(p.chain.chain_hash); }), "post 2: the chain hash is not its formula"],
      ["genesis", proof(first, (p) => { p.chain.previous_hash = flip(p.chain.previous_hash); }), "post 1: post 1 does not follow genesis"],
      ["passkey author", passkeySig((s) => { s.public_key = passkey().spki.toString("base64url"); }), "post 3: the passkey is not the author's KEY"],
      ["passkey algorithm", passkeySig((s) => { s.key_algorithm = "EdDSA"; }), "post 3: the passkey key is not a key of its algorithm"],
      ["client data not json", passkeySig((s) => { s.client_data_json = b64("not json"); }), "post 3: the passkey signature does not hold: client_data_json is not JSON"],
      ["client data []", passkeySig((s) => { s.client_data_json = b64("[]"); }), "post 3: the passkey signature does not hold: client_data_json is not a JSON object"],
      ["client type", clientData((c) => { c.type = "webauthn.create"; }), "post 3: the passkey signature does not hold: client_data_json.type must be webauthn.get"],
      ["challenge", clientData((c) => { c.challenge = b64("another"); }), "post 3: the passkey signature does not hold: client_data_json.challenge is not the challenge sent"],
      ["origin", clientData((c) => { c.origin = "https://elsewhere.test"; }), "post 3: the passkey signature does not hold: client_data_json.origin is not an origin this service accepts"],
      ["cross-origin", clientData((c) => { c.crossOrigin = true; }), "post 3: the passkey signature does not hold: the ceremony ran in a cross-origin frame"],
      ["authenticator data short", authData((a) => a.subarray(0, 36)), "post 3: the passkey signature does not hold: authenticator_data is too short"],
      ["relying party", authData((a) => Buffer.concat([Buffer.alloc(32), a.subarray(32)])), "post 3: the passkey signature does not hold: authenticator_data is for a different relying party"],
      ["not present", authData((a) => { const b = Buffer.from(a); b[32] = b[32]! & ~0x01; return b; }), "post 3: the passkey signature does not hold: the user was not present"],
      ["not verified", authData((a) => { const b = Buffer.from(a); b[32] = b[32]! & ~0x04; return b; }), "post 3: the passkey signature does not hold: the user was not verified"],
      ["passkey value", passkeySig((s) => { const v = Buffer.from(s.value, "base64url"); v[v.length - 1] = v[v.length - 1]! ^ 1; s.value = v.toString("base64url"); }), "post 3: the passkey signature does not hold: the signature does not verify against the public key of this passkey"],
      ...["not json", "[]"].map((text): [string, any, string] => [`checkpoint bytes ${text}`, checkpoint((cp) => { cp.canonical = b64(text); }), `${cpAt}: its signed bytes are not a JSON object`]),
      ["checkpoint for another SPACE", checkpoint((cp) => { cp.canonical = b64(JSON.stringify({ ...decoded(cp.canonical), space_id: randomUUID() })); }), `${cpAt}: signed for another SPACE`],
      ["served merkle_root", checkpoint((cp) => { cp.merkle_root = flip(cp.merkle_root); }), `${cpAt}: the signed merkle_root is not the one served`],
      ["served ending_hash", checkpoint((cp) => { cp.ending_hash = flip(cp.ending_hash); }), `${cpAt}: the signed ending_hash is not the one served`],
      served("stream", "events"),
      served("first", "2"),
      served("last", `${BigInt(ed.checkpoint.last) + 1n}`),
      served("predecessor_hash", "ab".repeat(32)),
      served("service_epoch", "another"),
      served("previous_checkpoint_id", "ab".repeat(32)),
      ["served created_at", checkpoint((cp) => { cp.created_at = "2000-01-01T00:00:00.000Z"; }), `${cpAt}: signed outside the dates its key's certificate is valid`],
      ["checkpoint_id", checkpoint((cp) => { cp.checkpoint_id = flip(cp.checkpoint_id); }), `${cpAt}: checkpoint_id is not the hash of its bytes`],
      ["signer key_id", checkpoint((cp) => { cp.signer.key_id = flip(cp.signer.key_id); }), `${cpAt}: the signer's key_id is not the id of its public key`],
      ["checkpoint signature", checkpoint((cp) => { cp.signature = flip(cp.signature); }), `${cpAt}: the signature does not verify against its signer`],
      ["certificate not json", checkpoint((cp) => { cp.signer.certificate = b64("not json"); }), `${cpAt}: its certificate is not a JSON object`],
      ["certificate key", certificate((c) => { c.key = "ab".repeat(32); }), `${cpAt}: the certificate names another key`],
      ["certificate purposes", certificate((c) => { c.purposes = ["receipt"]; }), `${cpAt}: the certificate does not let its key sign checkpoints`],
      ["certificate dates", certificate((c) => { c.not_before = "never"; }), `${cpAt}: the checkpoint or its certificate does not say when`],
      ["another root", ed, `${cpAt}: signed under root ${root}, not the root you trust`, "ab".repeat(32)],
    ];
    for (const [name, input, expected, trusted] of cases) {
      const run = both(input, trusted);
      assert.equal(run.status, 1, `${name}: ${run.fails.join("\n")}`);
      assert.ok(run.mirror.includes(expected), `${name}, the mirror: ${run.mirror.join("\n")}`);
      // The mirror stops at the first thing a passkey assertion gets wrong, as the
      // service does when it accepts one; the download names each.
      const extra = run.named.filter((f) => !run.mirror.includes(f));
      assert.deepEqual(run.mirror.filter((f) => !run.named.includes(f)), [], `${name}: the download leaves out the mirror's`);
      assert.ok(extra.every((f) => f.startsWith("post 3: the passkey signature does not hold: ")), `${name}: the download names more: ${extra.join("\n")}`);
    }
  });
});
