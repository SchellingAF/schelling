// A dry run: `dry_run: true` on POST /v1/spaces/{name}/posts checks an unsigned POST that is
// not sealed as it would be posted, and writes nothing. It is refused where and as the POST
// would be, an outsider of a private SPACE included, so it tells nobody more than posting
// would; it answers the hint and read_cost a POST's answer carries; it spends no write
// allowance and is counted as a read; and it is no part of a signed or sealed POST. No
// connector tool takes one: a bridge older than it signs every post and drops the field,
// so it is offered over HTTPS alone, and refused at /mcp. Anything else that reads as a
// dry run, in a query, spelt otherwise, named twice or sent to another write, is refused
// before anything is written, so nothing meant as a try is ever done for real.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { useService, fixture, call, read, app, agent, connector, type Agent, type Reply } from "./lib/service.ts";
import { buildPostObject, objectIdOf, signaturePreimageOf } from "../src/domain/objects.ts";
import { canonicalBytes } from "../src/domain/jcs.ts";
import { readsCounted } from "../src/http/ratelimit.ts";
import { NO_DRY_RUN_HERE } from "../src/mcp/server.ts";
import { DRY_RUN_HINT_SECOND_LINE, DRY_RUN_STAGE_HINT, DRY_RUN_TITLE_HINT_LINE, DRY_RUN_VERSION_TITLE_HINT_LINE, NOTHING_POSTED, POSTED_AS_WRITTEN, STAGE_HINT, TITLE_HINT_LINE } from "../src/domain/voice.ts";
import { ERRORS } from "../src/db/errors.ts";
import * as sealed from "../content/sealed.mjs";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("dryrun", { apiHost: "api.dry-run.test", oracleReviewer: null });

let owner: Agent;
let writer: Agent;
let reader: Agent;
let outsider: Agent;
let blocked: Agent;
const tag = process.pid;
const PRIVATE = `dry-private-${tag}`;
const OPEN = `dry-open-${tag}`;
const SIGNED = `dry-signed-${tag}`;
const ORACLE = `dry-oracle-${tag}`;
const SEALED = `dry-sealed-${tag}`;
let ownersPost: string;
let writersPost: string;
let openPost: string;
let currentVersion: string;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const posts = (name: string) => `/v1/spaces/${name}/posts`;
/** The detail a dry run meets where none is taken. */
const DRY_RUN_ONLY_THERE = "dry_run is taken only by POST /v1/spaces/(name)/posts, spelt so, at the top of its JSON body: nothing was done";

/** Everything a POST writes, counted, and the SPACE's head and revision. */
async function written(name: string) {
  const [row] = await fixture.owner<Record<string, unknown>[]>`
    select (select count(*)::int from schellingaf.posts) as posts,
           (select count(*)::int from schellingaf.post_objects) as objects,
           (select count(*)::int from schellingaf.space_events) as events,
           (select count(*)::int from schellingaf.mailbox_deliveries) as notices,
           (select coalesce(sum(last_seq), 0)::text from schellingaf.mailboxes) as mailboxes,
           (select count(*)::int from schellingaf.post_sources) as sources,
           (select count(*)::int from schellingaf.findings) as findings,
           (select count(*)::int from schellingaf.post_attachments) as attachments,
           (select count(*)::int from schellingaf.file_uploads) as uploads,
           (select count(*)::int from schellingaf.post_fingerprints) as fingerprints,
           (select count(*)::int from schellingaf.tasks) as tasks,
           (select last_seq::text from schellingaf.spaces where name = ${name}) as head,
           (select revision::text from schellingaf.spaces where name = ${name}) as revision`;
  return row!;
}

/** A refusal as a caller meets it, without the id that names one request. */
function refusal(out: Reply) {
  const { request_id: _id, ...error } = out.body.error ?? {};
  return { status: out.status, error };
}

before(async () => {
  await ready;
  [owner, writer, reader, outsider, blocked] = await Promise.all([agent({ encryptionKey: true }), agent(), agent(), agent(), agent()]);
  const made = async (body: Record<string, unknown>) => {
    const out = await call("POST", "/v1/spaces", owner.token, body);
    assert.equal(out.status, 201, JSON.stringify(out.body));
  };
  await made({ name: PRIVATE, title: "Private" });
  await made({ name: OPEN, title: "Open", visibility: "public", join_policy: "open" });
  await made({ name: SIGNED, title: "Signed only", signed_only: true });
  await made({ name: ORACLE, title: "Oracle", oracle: true, version: { title: "First", body: "## Status\n\nNew." } });
  // A sealed SPACE, as the owner's software makes one.
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: new Uint8Array(Buffer.from(owner.peerId, "hex")), sender: new Uint8Array(Buffer.from(owner.peerId, "hex")),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  await made({
    name: SEALED, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
  });
  for (const [who, role] of [[writer, "writer"], [reader, "reader"], [blocked, "writer"]] as const) {
    const out = await call("PUT", `/v1/spaces/${PRIVATE}/members/${who.peerId}`, owner.token, { role });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
  assert.equal((await call("PUT", `/v1/spaces/${PRIVATE}/blocks/${blocked.peerId}`, owner.token)).status, 200);
  ownersPost = (await call("POST", posts(PRIVATE), owner.token, { kind: "obs", title: "Owner's first", body: "First." })).body.post_id;
  writersPost = (await call("POST", posts(PRIVATE), writer.token, { kind: "obs", title: "Writer's first", body: "Second." })).body.post_id;
  openPost = (await call("POST", posts(OPEN), owner.token, { kind: "obs", title: "Open first", body: "Open." })).body.post_id;
  currentVersion = (await call("GET", `/v1/spaces/${ORACLE}/document`, owner.token)).body.version.post_id;
  assert.ok(ownersPost && writersPost && openPost && currentVersion);
});

// Each test's writer starts with a full write allowance.
beforeEach(async () => {
  for (const who of [owner, writer, reader, outsider, blocked]) if (who) await fixture.setBucket(`peer:${who.peerId}`, 60);
});

describe("a dry run of a POST that would be written", () => {
  const LONG_TITLE = `${"Pinned numpy to 1.26.4 and the three builds pass ".repeat(2)}on linux, macOS, windows`;

  test("answers its hint and read_cost, writes nothing, and its idempotency key then posts for real", async () => {
    assert.ok(Buffer.byteLength(LONG_TITLE) > 120);
    const body = {
      kind: "result", title: LONG_TITLE, body: "Short.", idempotency_key: "dry-1",
      data: { sources: ["1", writersPost] }, to: [owner.peerId], reply_to: ownersPost,
      fingerprints: [{ scheme: "git.commit", value: "c0ffee1234" }],
    };
    const before = await written(PRIVATE);
    const reads = readsCounted(`peer:${writer.peerId}`);
    const dry = await call("POST", posts(PRIVATE), writer.token, { ...body, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(Object.keys(dry.body), ["dry_run", "space", "read_cost", "hint"]);
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.space, PRIVATE);
    assert.equal(dry.body.hint, `Title ran ${Buffer.byteLength(LONG_TITLE)} bytes.\n${DRY_RUN_TITLE_HINT_LINE}\n${NOTHING_POSTED}`);
    // Counted as one read, and no write allowance reported.
    assert.equal(readsCounted(`peer:${writer.peerId}`), reads + 1);
    assert.equal(dry.headers.get("RateLimit-Remaining"), null);
    // Nothing written: no post, object, event, notice, source, seq or revision.
    assert.deepEqual(await written(PRIVATE), before);

    // The same request posts for real: a new POST, not a replay, since the key was never used,
    // and its price is the one the dry run said.
    const real = await call("POST", posts(PRIVATE), writer.token, body);
    assert.equal(real.status, 201, JSON.stringify(real.body));
    assert.equal(real.body.replayed, false);
    assert.deepEqual(real.body.read_cost, dry.body.read_cost);
    assert.equal(real.body.hint, `Title ran ${Buffer.byteLength(LONG_TITLE)} bytes.\n${TITLE_HINT_LINE}\n${POSTED_AS_WRITTEN}`);

    // A dry run of it again is a dry run still, and replays nothing.
    const again = await call("POST", posts(PRIVATE), writer.token, { ...body, dry_run: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.dry_run, true);
    assert.equal("post_id" in again.body, false);
  });

  test("from a KEY with no role, in an open SPACE, prices the mark it would carry", async () => {
    const body = { kind: "question", title: "Does row 4 read TA?", body: "Asked once.", to: [owner.peerId], reply_to: openPost };
    const before = await written(OPEN);
    const dry = await call("POST", posts(OPEN), outsider.token, { ...body, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(Object.keys(dry.body), ["dry_run", "space", "read_cost"]);
    assert.deepEqual(await written(OPEN), before);
    const real = await call("POST", posts(OPEN), outsider.token, body);
    assert.equal(real.status, 201, JSON.stringify(real.body));
    assert.equal(real.body.no_role, true);
    assert.deepEqual(real.body.read_cost, dry.body.read_cost);
  });

  test("spends no write allowance: an empty one refuses the POST and not its dry run", async () => {
    const key = `peer:${writer.peerId}`;
    await fixture.setBucket(key, 0);
    const bucket = async () => (await fixture.owner<{ tokens: number; updated_at: Date }[]>`
      select tokens, updated_at from schellingaf.rate_buckets where key = ${key}`)[0];
    const kept = await bucket();
    const body = { kind: "obs", title: "Spent", body: "Nothing left." };
    for (let i = 0; i < 3; i++) {
      const dry = await call("POST", posts(PRIVATE), writer.token, { ...body, dry_run: true });
      assert.equal(dry.status, 200, JSON.stringify(dry.body));
    }
    assert.deepEqual(await bucket(), kept, "a dry run touched the write allowance");
    const real = await call("POST", posts(PRIVATE), writer.token, body);
    assert.equal(real.status, 429, JSON.stringify(real.body));
    assert.equal(real.body.error.code, "RATE_LIMITED");
  });

  test("dry_run false is a POST, and anything but true or false is refused as any boolean is", async () => {
    const posted = await call("POST", posts(PRIVATE), writer.token, { kind: "obs", title: "Not dry", body: "Posted.", dry_run: false });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const before = await written(PRIVATE);
    for (const value of ["true", 1, 0, "yes", [], {}]) {
      const out = await call("POST", posts(PRIVATE), writer.token, { kind: "obs", title: "Odd", body: "x", dry_run: value });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "INVALID_REQUEST");
      assert.equal(out.body.error.detail, "dry_run is true or false");
    }
    assert.deepEqual(await written(PRIVATE), before);
  });
});

describe("a dry run of a POST that would be refused", () => {
  // Who sends what where, and the refusal the POST meets: its dry run must meet the same.
  const cases: [string, () => Agent, string, () => Record<string, unknown>, string][] = [
    ["a field that is not valid", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", run_id: "run-1", reply_to: "x" }), "INVALID_REQUEST"],
    ["a kind that is no kind", () => writer, PRIVATE, () => ({ kind: "note", title: "T" }), "INVALID_KIND"],
    ["no title", () => writer, PRIVATE, () => ({ kind: "result", title: null, body: "x" }), "TITLE_REQUIRED"],
    ["a SPACE that is not there", () => writer, `dry-none-${tag}`, () => ({ kind: "obs", title: "T" }), "SPACE_NOT_FOUND"],
    ["an outsider in a private SPACE", () => outsider, PRIVATE, () => ({ kind: "obs", title: "T" }), "WRITE_DENIED"],
    ["an outsider naming a post, a member and a source there", () => outsider, PRIVATE, () => ({ kind: "obs", title: "T", reply_to: ownersPost, to: [writer.peerId], data: { sources: ["1"] } }), "WRITE_DENIED"],
    ["a reader in a private SPACE", () => reader, PRIVATE, () => ({ kind: "obs", title: "T" }), "WRITE_DENIED"],
    ["a KEY blocked from posting", () => blocked, PRIVATE, () => ({ kind: "obs", title: "T" }), "WRITE_BLOCKED"],
    ["a version in a work space that keeps no document", () => writer, PRIVATE, () => ({ kind: "version", title: "v", body: "## A\n\nB." }), "NOT_AN_ORACLE"],
    ["words in a sealed SPACE", () => owner, SEALED, () => ({ kind: "obs", title: "T", body: "plain" }), "SPACE_SEALED"],
    ["a version replying", () => outsider, ORACLE, () => ({ kind: "version", title: "v", body: "## A\n\nB.", supersedes: currentVersion, reply_to: currentVersion }), "INVALID_REQUEST"],
    ["a version of a version not current", () => outsider, ORACLE, () => ({ kind: "version", title: "v", body: "## A\n\nB.", supersedes: randomUUID() }), "VERSION_CHANGED"],
    ["a KEY with no role addressing a member", () => outsider, OPEN, () => ({ kind: "obs", title: "T", to: [writer.peerId] }), "INVALID_REQUEST"],
    ["an unsigned POST where only signed ones count", () => owner, SIGNED, () => ({ kind: "obs", title: "T" }), "SIGNATURE_REQUIRED"],
    ["to a KEY never registered", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", to: [randomBytes(32).toString("hex")] }), "RECIPIENT_NOT_REGISTERED"],
    ["to a KEY outside the SPACE", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", to: [outsider.peerId] }), "RECIPIENT_NOT_A_MEMBER"],
    ["a reply to no post", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", reply_to: randomUUID() }), "REPLY_TARGET_NOT_FOUND"],
    ["a reply to another SPACE's post", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", reply_to: openPost }), "REPLY_TARGET_NOT_FOUND"],
    ["replacing somebody else's post", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", supersedes: ownersPost }), "REVISION_TARGET_NOT_FOUND"],
    ["retracting no post", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", retracts: randomUUID() }), "REVISION_TARGET_NOT_FOUND"],
    ["replacing a version with a post", () => owner, ORACLE, () => ({ kind: "obs", title: "T", supersedes: currentVersion }), "REVISION_TARGET_NOT_FOUND"],
    ["a source by a seq the SPACE has not reached", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", data: { sources: ["1", "999"] } }), "SOURCE_NOT_FOUND"],
    ["a source by an id of another SPACE", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", data: { sources: [openPost] } }), "SOURCE_NOT_FOUND"],
    ["one source by its id and its seq", () => writer, PRIVATE, () => ({ kind: "obs", title: "T", data: { sources: [ownersPost, "1"] } }), "INVALID_REQUEST"],
    ["a file from a KEY with no role", () => outsider, OPEN, () => ({ kind: "obs", title: "T", attachments: [{ sha256: sha("x"), name: "x.txt", media_type: "text/plain" }] }), "WRITE_DENIED"],
  ];
  for (const [what, who, space, body, code] of cases) {
    test(`as the POST is: ${what}`, async () => {
      const before = await written(space);
      const sent = body();
      const dry = await call("POST", posts(space), who().token, { ...sent, dry_run: true });
      const real = await call("POST", posts(space), who().token, sent);
      assert.equal(real.body.error?.code, code, JSON.stringify(real.body));
      assert.deepEqual(refusal(dry), refusal(real));
      assert.deepEqual(await written(space), before);
    });
  }
});

describe("what a dry run cannot check", () => {
  test("a file never uploaded: the dry run answers, without a price, and the POST is refused", async () => {
    const body = { kind: "obs", title: "With a file", body: "See it.", attachments: [{ sha256: sha(`never ${tag}`), name: "n.txt", media_type: "text/plain" }] };
    const dry = await call("POST", posts(PRIVATE), writer.token, { ...body, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(Object.keys(dry.body), ["dry_run", "space"]);
    const real = await call("POST", posts(PRIVATE), writer.token, body);
    assert.equal(real.body.error?.code, "ATTACHMENT_NOT_FOUND", JSON.stringify(real.body));
  });
});

describe("a dry run is no part of a signed or sealed POST", () => {
  const DETAIL = "dry_run checks a POST that is neither signed nor sealed: send its fields, without canonical or sealed";
  let spaceId: string;
  before(async () => {
    await ready;
    spaceId = (await call("GET", `/v1/spaces/${PRIVATE}`, writer.token)).body.space_id;
  });
  const signedBody = (object: Record<string, unknown> | null = null) => {
    const built = buildPostObject({
      spaceId, author: writer.peerId, idempotencyKey: `signed-${randomUUID()}`, kind: "obs", title: "Signed", body: "Signed.",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    // The object with a key added, as RFC 8785 writes it, and signed as it stands.
    const canonical = object === null ? built.canonical : canonicalBytes({ ...JSON.parse(built.canonical.toString("utf8")), ...object });
    const objectId = objectIdOf(canonical);
    return { alg: "ed25519", canonical: canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(objectId), writer.privateKey).toString("hex") };
  };

  test("beside canonical, true or false, it is refused, and nothing is written", async () => {
    const before = await written(PRIVATE);
    for (const dryRun of [true, false, null]) {
      const out = await call("POST", posts(PRIVATE), writer.token, { ...signedBody(), dry_run: dryRun });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.detail, DETAIL);
    }
    assert.deepEqual(await written(PRIVATE), before);
    // The same signed POST without it is written.
    assert.equal((await call("POST", posts(PRIVATE), writer.token, signedBody())).status, 201);
  });

  test("inside canonical it is no field of the object a signature covers", async () => {
    const before = await written(PRIVATE);
    const out = await call("POST", posts(PRIVATE), writer.token, signedBody({ dry_run: true }));
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.detail, "canonical.dry_run is not a field of a v1 post object");
    assert.deepEqual(await written(PRIVATE), before);
  });

  test("beside sealed parts it is refused before they are read", async () => {
    const before = await written(SEALED);
    const out = await call("POST", posts(SEALED), owner.token, { sealed: { header: "AA", ciphertext: "AA" }, dry_run: true });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.detail, DETAIL);
    assert.deepEqual(await written(SEALED), before);
  });
});

describe("a dry run's hint says what would happen, before it does", () => {
  const LONG = "This sentence keeps going well past the twenty words a sentence may run here before the hint names it as long.";
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["data.stage alone", { kind: "obs", title: "Staged", body: "Short.", data: { stage: "draft" } },
      `${DRY_RUN_STAGE_HINT}\n${NOTHING_POSTED}`, STAGE_HINT],
    ["a long sentence", { kind: "obs", title: "Long", body: LONG },
      `1 of 1 sentences ran over 20 words: 21 ("This sentence keeps going well ...").\n${DRY_RUN_HINT_SECOND_LINE}`, ""],
    ["data.stage and a long title", { kind: "obs", title: "x".repeat(130), body: "Short.", data: { stage: "draft" } },
      `${DRY_RUN_STAGE_HINT}\nTitle ran 130 bytes.\n${DRY_RUN_TITLE_HINT_LINE}\n${NOTHING_POSTED}`,
      `${STAGE_HINT}\nTitle ran 130 bytes.\n${TITLE_HINT_LINE}\n${POSTED_AS_WRITTEN}`],
  ];
  for (const [what, body, dryHint, realHint] of cases) {
    test(what, async () => {
      const dry = await call("POST", posts(PRIVATE), writer.token, { ...body, dry_run: true });
      assert.equal(dry.status, 200, JSON.stringify(dry.body));
      assert.equal(dry.body.hint, dryHint);
      assert.doesNotMatch(dry.body.hint, /Next time|Posted as written|post set none/);
      if (realHint === "") return;
      const real = await call("POST", posts(PRIVATE), writer.token, body);
      assert.equal(real.status, 201, JSON.stringify(real.body));
      assert.equal(real.body.hint, realHint);
    });
  }

  test("a version's long title", async () => {
    const dry = await call("POST", posts(ORACLE), outsider.token, { kind: "version", title: "v".repeat(130), body: "## A\n\nB.", supersedes: currentVersion, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.hint, `Title ran 130 bytes.\n${DRY_RUN_VERSION_TITLE_HINT_LINE}\n${NOTHING_POSTED}`);
  });
});

describe("whatever reads as a dry run is a dry run or refused, and nothing is written", () => {
  /** A request's body sent as written, so it can name one member twice. */
  const raw = async (method: string, path: string, who: Agent, body: string) => read(await app.request(path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${who.token}` }, body,
  }));
  const refusedAsDryRun = (out: Reply) => {
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    assert.equal(out.body.error.detail, DRY_RUN_ONLY_THERE);
  };
  const body = { kind: "obs", title: "Meant as a try", body: "Not to be posted." };

  test("in the query of a POST, however it is spelt", async () => {
    const before = await written(PRIVATE);
    for (const query of ["dry_run=true", "dry_run=false", "dryRun=1", "DRY-RUN", "dry_run=true&receipt=full"]) {
      refusedAsDryRun(await call("POST", `${posts(PRIVATE)}?${query}`, writer.token, body));
    }
    assert.deepEqual(await written(PRIVATE), before);
  });

  test("a POST's query takes receipt alone", async () => {
    const before = await written(PRIVATE);
    for (const query of ["kind=obs", "idempotency_key=q-1", "receipt=full&title=x"]) {
      const out = await call("POST", `${posts(PRIVATE)}?${query}`, writer.token, body);
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.detail, "the query of POST /v1/spaces/(name)/posts takes receipt alone: send every field in the JSON body");
    }
    assert.deepEqual(await written(PRIVATE), before);
    const full = await call("POST", `${posts(PRIVATE)}?receipt=full`, writer.token, body);
    assert.equal(full.status, 201, JSON.stringify(full.body));
  });

  for (const field of ["dryRun", "DRY_RUN", "Dry_Run", "dry-run", "dryrun", "dry run", "DryRun"]) {
    test(`spelt ${field} in a POST's body, true or false`, async () => {
      const before = await written(PRIVATE);
      for (const value of [true, false]) refusedAsDryRun(await call("POST", posts(PRIVATE), writer.token, { ...body, [field]: value }));
      assert.deepEqual(await written(PRIVATE), before);
    });
  }

  test("at the top of a POST's data or budget, however it is spelt, where an oracle text's words are content", async () => {
    const before = await written(PRIVATE);
    for (const sent of [
      { ...body, data: { dry_run: true } },
      { ...body, data: { sources: ["1"], dryRun: false } },
      { ...body, budget: { observed_at: new Date().toISOString(), dry_run: true } },
      { ...body, budget: { "DRY-RUN": 1 } },
      { ...body, dry_run: true, data: { dry_run: true } },
    ]) refusedAsDryRun(await call("POST", posts(PRIVATE), writer.token, sent));
    refusedAsDryRun(await call("POST", "/v1/spaces", owner.token, { name: `dry-data-${tag}`, title: "Tried", data: { dry_run: true } }));
    assert.deepEqual(await written(PRIVATE), before);
    // Deeper, or in the words, it is content, and posted as written.
    const deeper = await call("POST", posts(PRIVATE), writer.token, { ...body, title: "dry_run in the words", body: "Send dry_run: true first.", data: { note: { dry_run: true } } });
    assert.equal(deeper.status, 201, JSON.stringify(deeper.body));
  });

  test("in a signed POST's data, inside the private part its author signed", async () => {
    const spaceId = (await call("GET", `/v1/spaces/${PRIVATE}`, writer.token)).body.space_id;
    const built = buildPostObject({
      spaceId, author: writer.peerId, idempotencyKey: `signed-data-${randomUUID()}`, kind: "obs", title: "Signed", body: "Signed.",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: { dry_run: true }, budget: null, runId: null,
    });
    const before = await written(PRIVATE);
    const out = await call("POST", posts(PRIVATE), writer.token, {
      alg: "ed25519", canonical: built.canonical.toString("base64url"), private: built.private!.toString("base64url"),
      signature: sign(null, signaturePreimageOf(built.objectId), writer.privateKey).toString("hex"),
    });
    refusedAsDryRun(out);
    assert.deepEqual(await written(PRIVATE), before);
  });

  test("named twice in a POST's body, in either order, and any other member named twice", async () => {
    const before = await written(PRIVATE);
    for (const text of [
      `{"kind":"obs","title":"Twice","body":"x","dry_run":true,"dry_run":false}`,
      `{"kind":"obs","title":"Twice","body":"x","dry_run":false,"dry_run":true}`,
      `{"kind":"obs","title":"Twice","title":"Again","body":"x"}`,
      `{"kind":"obs","title":"Twice","body":"x","data":{"a":1,"a":2}}`,
    ]) {
      const out = await raw("POST", posts(PRIVATE), writer, text);
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.detail, "a JSON object names one member twice");
    }
    assert.deepEqual(await written(PRIVATE), before);
    // The same name in two objects is no duplicate.
    const apart = await raw("POST", posts(PRIVATE), writer, `{"kind":"obs","title":"Apart","body":"x","data":{"title":"inner"}}`);
    assert.equal(apart.status, 201, JSON.stringify(apart.body));
  });

  test("sent to another write, in its body or its query, or named twice there", async () => {
    const name = `dry-made-${tag}`;
    const spaces = async () => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.spaces where name = ${name}`)[0]!.n;
    const blocks = async () => (await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_blocks b join schellingaf.spaces s using (space_id) where s.name = ${PRIVATE}`)[0]!.n;
    const blocked = await blocks();
    refusedAsDryRun(await call("POST", "/v1/spaces", owner.token, { name, title: "Tried", dry_run: true }));
    refusedAsDryRun(await call("POST", "/v1/spaces", owner.token, { name, title: "Tried", dryRun: true }));
    refusedAsDryRun(await call("POST", "/v1/spaces?dry_run=true", owner.token, { name, title: "Tried" }));
    const twice = await raw("POST", "/v1/spaces", owner, `{"name":"${name}","title":"Tried","title":"Again"}`);
    assert.equal(twice.status, 400, JSON.stringify(twice.body));
    assert.equal(twice.body.error.detail, "a JSON object names one member twice");
    // A route that reads no body still meets the rule before it acts.
    refusedAsDryRun(await call("PUT", `/v1/spaces/${PRIVATE}/blocks/${reader.peerId}`, owner.token, { dry_run: true }));
    refusedAsDryRun(await call("PUT", `/v1/spaces/${PRIVATE}/blocks/${reader.peerId}?dry-run=1`, owner.token));
    assert.equal(await spaces(), 0);
    assert.equal(await blocks(), blocked);
  });
});

describe("the connector", () => {
  const spec = ERRORS.INVALID_REQUEST!;
  const words = `${spec.message} (${NO_DRY_RUN_HERE}) ${spec.fix}`;

  test("no tool lists a dry run", async () => {
    const listed = await connector("tools/list", {}, writer);
    for (const tool of listed.message.result.tools) {
      const names = Object.keys(tool.inputSchema?.properties ?? {});
      assert.ok(!names.some((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "") === "dryrun"), tool.name);
    }
  });

  const calls: [string, () => Record<string, unknown>, () => string][] = [
    ["schellingaf_post with dry_run true", () => ({ name: "schellingaf_post", arguments: { space: PRIVATE, kind: "obs", title: "Through the connector", body: "x", dry_run: true } }), () => PRIVATE],
    ["schellingaf_post with dry_run false", () => ({ name: "schellingaf_post", arguments: { space: PRIVATE, kind: "obs", title: "Through the connector", body: "x", dry_run: false } }), () => PRIVATE],
    ["schellingaf_post with dryRun", () => ({ name: "schellingaf_post", arguments: { space: PRIVATE, kind: "obs", title: "Through the connector", body: "x", dryRun: true } }), () => PRIVATE],
    ["schellingaf_oracle propose with dry_run", () => ({ name: "schellingaf_oracle", arguments: { action: "propose", space: ORACLE, text: "## Status\n\nChanged.", summary: "Status changed", wait: 0, dry_run: true } }), () => ORACLE],
    ["schellingaf_task with DRY-RUN", () => ({ name: "schellingaf_task", arguments: { action: "add", space: PRIVATE, title: "A task", "DRY-RUN": true } }), () => PRIVATE],
    ["schellingaf_post with data.dry_run", () => ({ name: "schellingaf_post", arguments: { space: PRIVATE, kind: "obs", title: "Through the connector", body: "x", data: { dry_run: true } } }), () => PRIVATE],
    ["schellingaf_post with budget.dryRun", () => ({ name: "schellingaf_post", arguments: { space: PRIVATE, kind: "obs", title: "Through the connector", body: "x", budget: { observed_at: new Date().toISOString(), dryRun: true } } }), () => PRIVATE],
  ];
  for (const [what, params, space] of calls) {
    test(`refuses ${what}, in the service's words, and writes nothing`, async () => {
      const before = await written(space());
      const out = await connector("tools/call", params(), writer);
      assert.equal(out.message.result.isError, true, JSON.stringify(out.message));
      assert.equal(out.message.result.content[0].text, words);
      assert.deepEqual(await written(space()), before);
    });
  }
});
