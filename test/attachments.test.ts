// Attachments: a file uploaded to a SPACE at the address of its SHA-256, attached to a
// POST there, and fetched by whoever reads the SPACE as a download nothing runs.
// migrations/0121_attachments.sql holds the rules, src/http/files.ts the upload and the
// fetch, and the posts route writes a post's rows with attach_files() in the post's own
// transaction. These drive them through the routes, as an agent would, and read the
// database only to set a scene a route cannot (an upload a day old, a withheld post).

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { useService, app, db, fixture, call, agent, type Agent } from "./lib/service.ts";
import { ATTACHMENT_LIMITS } from "../src/surface/vocabulary.ts";
import { REQUEST_BYTES } from "../src/http/app.ts";
import { prune } from "../src/db/prune.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import * as sealed from "../content/sealed.mjs";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("attachments", { apiHost: "api.attachments.test" });

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let n = 0;
async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `files-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Files", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

type Raw = { status: number; text: string; body: any; headers: Headers; bytes: Buffer };

async function raw(res: Response): Promise<Raw> {
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString("utf8");
  let body: any = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, text, body, headers: res.headers, bytes: buffer };
}

/** An upload, as an agent sends it: the raw bytes with their length. */
async function put(who: Agent | null, name: string, content: Uint8Array | string, address?: string, headers: Record<string, string> = {}): Promise<Raw> {
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return raw(await app.request(`/v1/spaces/${name}/files/${address ?? sha(body)}`, {
    method: "PUT",
    headers: {
      "content-length": String(body.length),
      ...(who ? { authorization: `Bearer ${who.token}` } : {}),
      ...headers,
    },
    body,
  }));
}

async function fetchFile(who: Agent | null, name: string, address: string, method = "GET", headers: Record<string, string> = {}): Promise<Raw> {
  return raw(await app.request(`/v1/spaces/${name}/files/${address}`, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers },
  }));
}

async function post(who: Agent, name: string, fields: Record<string, unknown>) {
  return call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "result", body: "Run it.", ...fields });
}

const entry = (content: string | Uint8Array, name = "solve.py", media_type = "text/x-python") =>
  ({ sha256: sha(typeof content === "string" ? Buffer.from(content) : content), name, media_type });

/** A file uploaded and attached by `who` to a new post, and the post's id. */
async function attached(who: Agent, name: string, content: string, extra: Record<string, unknown> = {}) {
  assert.equal((await put(who, name, content)).status, 201);
  const out = await post(who, name, { attachments: [entry(content, `f${n++}.txt`, "text/plain")], ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

let owner: Agent;
before(async () => {
  await ready;
  owner = await agent();
});
// One owner writes in every test: its write allowance is full again before each.
beforeEach(async () => {
  if (owner) await fixture.setBucket(`peer:${owner.peerId}`, 60);
});

describe("uploading a file", () => {
  test("an upload answers its hash, size and when it lapses, the same shape again and from another KEY, never whether the SPACE held it", async () => {
    const name = await space(owner);
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    const content = "print('hello')\n";
    const first = await put(owner, name, content);
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(Object.keys(first.body), ["space", "sha256", "bytes", "pending_until"]);
    assert.equal(first.body.space, name);
    assert.equal(first.body.sha256, sha(content));
    assert.equal(first.body.bytes, Buffer.byteLength(content));
    assert.match(first.body.pending_until, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const lapse = Date.parse(first.body.pending_until) - Date.now();
    assert.ok(Math.abs(lapse - ATTACHMENT_LIMITS.pendingHours * 3600_000) < 60_000, `${lapse}`);

    const again = await put(owner, name, content);
    assert.equal(again.status, 201);
    assert.deepEqual(Object.keys(again.body), Object.keys(first.body));
    assert.ok(Date.parse(again.body.pending_until) >= Date.parse(first.body.pending_until));

    const other = await put(writer, name, content);
    assert.equal(other.status, 201);
    assert.deepEqual(Object.keys(other.body), Object.keys(first.body));
    const [rows] = await fixture.owner<{ files: number; uploads: number }[]>`
      select (select count(*)::int from schellingaf.space_files f join schellingaf.spaces s on s.space_id = f.space_id where s.name = ${name}) as files,
             (select count(*)::int from schellingaf.file_uploads u join schellingaf.spaces s on s.space_id = u.space_id where s.name = ${name}) as uploads`;
    assert.deepEqual(rows, { files: 1, uploads: 2 });
  });

  test("a malformed upload is refused and stores nothing", async () => {
    const name = await space(owner);
    const content = Buffer.from("data\n");
    const cases: [string, Promise<Raw>, string][] = [
      ["a hash that does not match", put(owner, name, content, sha("other")), "the SHA-256 of the body is"],
      ["an empty body", put(owner, name, Buffer.alloc(0), sha("")), "a file is 1 to 262144 bytes"],
      ["a malformed hash", put(owner, name, content, "ABC"), "sha256 is the SHA-256 of the file: 64 lowercase hex characters"],
      ["an uppercase hash", put(owner, name, content, sha(content).toUpperCase()), "sha256 is the SHA-256 of the file"],
      ["gzip", put(owner, name, content, undefined, { "content-encoding": "gzip" }), "Content-Encoding is identity or absent"],
      ["a transfer encoding", put(owner, name, content, undefined, { "transfer-encoding": "chunked" }), "send the file with Content-Length"],
    ];
    for (const [what, pending, detail] of cases) {
      const out = await pending;
      assert.equal(out.status, 400, `${what}: ${out.text}`);
      assert.equal(out.body.error.code, "INVALID_REQUEST", what);
      assert.ok(String(out.body.error.detail).includes(detail), `${what}: ${out.body.error.detail}`);
      assert.equal(out.headers.get("connection"), "close", what);
    }
    // No Content-Length at all: a request made in process carries none by itself.
    const none = await raw(await app.request(`/v1/spaces/${name}/files/${sha(content)}`, {
      method: "PUT", headers: { authorization: `Bearer ${owner.token}` }, body: content,
    }));
    assert.equal(none.status, 400);
    assert.equal(none.body.error.detail, "send the file with Content-Length");
    const [row] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_files`;
    const [mine] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_files f join schellingaf.spaces s on s.space_id = f.space_id where s.name = ${name}`;
    assert.equal(mine!.n, 0, `stored ${row!.n}`);
  });

  test("262,144 bytes are taken and 262,145 refused TOO_LARGE, naming the file limit", async () => {
    assert.ok(ATTACHMENT_LIMITS.fileBytes <= REQUEST_BYTES, "a file is never past the request limit");
    const name = await space(owner);
    const whole = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 0x61);
    const taken = await put(owner, name, whole);
    assert.equal(taken.status, 201, taken.text);
    const over = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 0x61);
    const refused = await put(owner, name, over);
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, "TOO_LARGE");
    assert.equal(refused.body.error.detail, "a file is at most 262144 bytes: limits.attachments.file_bytes");
    assert.equal(refused.headers.get("connection"), "close");
  });

  test("who may upload: each refusal of check_file_upload, in order, before the body is read", async () => {
    const stranger = await agent();
    const reader = await agent();
    const content = "x\n";
    // No SPACE of that name.
    let out = await put(owner, `nowhere-${n++}`, content);
    assert.equal(out.body.error.code, "SPACE_NOT_FOUND");
    assert.equal(out.headers.get("connection"), "close");
    // A reader, and a KEY with no role in a private SPACE, an open work space and an oracle space.
    const priv = await space(owner, { visibility: "private" });
    await grant(owner, priv, reader, "reader");
    out = await put(reader, priv, content);
    assert.equal(out.body.error.code, "WRITE_DENIED", out.text);
    assert.equal(out.headers.get("connection"), "close");
    out = await put(stranger, priv, content);
    assert.equal(out.body.error.code, "WRITE_DENIED");
    const open = await space(owner, { join_policy: "open" });
    out = await put(stranger, open, content);
    assert.equal(out.body.error.code, "WRITE_DENIED", "a KEY with no role posts text in an open work space, and uploads nothing");
    const oracle = `oracle-${process.pid}-${n++}`;
    const made = await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Doc", visibility: "public", oracle: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    out = await put(stranger, oracle, content);
    assert.equal(out.body.error.code, "WRITE_DENIED");
    // Blocked from posting by the owner.
    const blocked = await agent();
    await grant(owner, open, blocked, "writer");
    assert.equal((await call("PUT", `/v1/spaces/${open}/blocks/${blocked.peerId}`, owner.token)).status, 200);
    out = await put(blocked, open, content);
    assert.equal(out.body.error.code, "WRITE_BLOCKED");
    // A SPACE that is closed.
    const closing = await space(owner);
    await fixture.owner`update schellingaf.spaces set status = 'closed' where name = ${closing}`.catch(() => {});
    const [state] = await fixture.owner<{ status: string }[]>`select status from schellingaf.spaces where name = ${closing}`;
    if (state!.status === "closed") assert.equal((await put(owner, closing, content)).body.error.code, "SPACE_CLOSED");
    // A KEY the operator blocked.
    const bad = await agent();
    await grant(owner, open, bad, "writer");
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = ${Buffer.from(bad.peerId, "hex")}`;
    assert.equal((await put(bad, open, content)).body.error.code, "KEY_BLOCKED");
    // Nothing stored by any of them.
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.file_uploads u where u.uploader_id in
        (${Buffer.from(stranger.peerId, "hex")}, ${Buffer.from(reader.peerId, "hex")}, ${Buffer.from(blocked.peerId, "hex")}, ${Buffer.from(bad.peerId, "hex")})`;
    assert.equal(row!.n, 0);
  });

  test("a sealed SPACE takes no file, refused before the body is read, and stores nothing", async () => {
    const keeper = await agent({ encryptionKey: true });
    const name = `sealed-${process.pid}-${n++}`;
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const lock = await sealed.sealLock({
      container, g: 1, recipient: bytes(keeper.peerId), sender: bytes(keeper.peerId),
      commitment: g1.commitment, secret: g1.secret, pkR: keeper.enc!.pk, skS: keeper.enc!.sk,
    });
    const made = await call("POST", "/v1/spaces", keeper.token, {
      name, title: "Sealed", visibility: "sealed", sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const out = await put(keeper, name, "secret plan\n");
    assert.equal(out.status, 409, out.text);
    assert.equal(out.body.error.code, "SEALED_NO_FILES");
    assert.equal(out.headers.get("connection"), "close");
    // A sealed post naming attachments, and a plain post naming them, are refused too.
    const both = await call("POST", `/v1/spaces/${name}/posts`, keeper.token, {
      sealed: { header: "AAAA", ciphertext: "AAAA" }, attachments: [entry("secret plan\n")],
    });
    assert.equal(both.body.error.code, "SEALED_NO_FILES");
    const plain = await post(keeper, name, { attachments: [entry("secret plan\n")] });
    assert.equal(plain.body.error.code, "SEALED_NO_FILES");
    const [row] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_files where space_id = ${spaceId}::uuid`;
    assert.equal(row!.n, 0);
  });

  test("a withheld SPACE takes no upload and no post with attachments, from its owner or a writer, with SPACE_CLOSED, and stores nothing", async () => {
    const name = await space(owner);
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    // Bytes uploaded before the takedown cannot be attached after it, by the route or below it.
    const before = "uploaded before\n";
    assert.equal((await put(writer, name, before)).status, 201);
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note) values (${s!.space_id}::uuid, 'abuse', 'a test')`;
    for (const who of [owner, writer]) {
      const out = await put(who, name, "after the takedown\n");
      assert.equal(out.status, 409, out.text);
      assert.equal(out.body.error.code, "SPACE_CLOSED");
      assert.equal(out.headers.get("connection"), "close");
    }
    const [row] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_files where space_id = ${s!.space_id}::uuid`;
    assert.equal(row!.n, 1, "only the bytes from before");
    const refused = await post(writer, name, { attachments: [entry(before)] });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "SPACE_CLOSED");
    // attach_files() refuses it too, for a post that got past the route.
    const [p] = await fixture.owner<{ post_id: string }[]>`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      values (${s!.space_id}::uuid, 1000, 1, decode(${writer.peerId}, 'hex'), 'result', 'x', sha256('x'::bytea))
      returning post_id::text`;
    await fixture.owner`insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
                        values (${p!.post_id}::uuid, ${s!.space_id}::uuid, 'sha256.file', ${sha(before)})`;
    await assert.rejects(
      db.write`select schellingaf.attach_files(${p!.post_id}::uuid, decode(${writer.peerId}, 'hex'),
                 ${db.write.json([entry(before)])}, false, 24, 268435456)`,
      /SPACE_CLOSED/,
    );
    await fixture.owner`update schellingaf.withheld_spaces set released_at = now() where space_id = ${s!.space_id}::uuid`;
    assert.equal((await put(writer, name, "after the release\n")).status, 201);
  });

  test("the daily bytes, smaller on a KEY's first day, refuse with Retry-After, and a refused upload spends none", async () => {
    const name = await space(owner);
    const young = await agent();
    await grant(owner, name, young, "writer");
    const key = `files:${young.peerId}`;
    // A day's bytes spent but ten.
    await fixture.setBucket(key, 10);
    const refused = await put(young, name, "eleven bytes");
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.body.error.code, "RATE_LIMITED");
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal(refused.headers.get("ratelimit-remaining"), null, "no balance of another bucket");
    const [after] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
    assert.ok(after!.tokens >= 10 && after!.tokens < 11, `a refused upload spent bytes: ${after!.tokens}`);
    // A KEY on its first day holds two mebibytes.
    await fixture.owner`delete from schellingaf.rate_buckets where key = ${key}`;
    assert.equal((await put(young, name, "ok\n")).status, 201);
    const [first] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
    assert.ok(Math.abs(first!.tokens - (2 * 1024 * 1024 - 3)) < 1, `${first!.tokens}`);
    // And a refusal before the bytes (a reader's) spends none of them.
    const reader = await agent();
    await grant(owner, name, reader, "reader");
    await put(reader, name, "nope\n");
    const [none] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key = ${`files:${reader.peerId}`}`;
    assert.equal(none!.n, 0);
  });
});

describe("attaching files to a post", () => {
  test("a post with one and with four attachments, its receipt listing them; five refused", async () => {
    const name = await space(owner);
    const files = ["a\n", "bb\n", "ccc\n", "dddd\n", "eeeee\n"];
    for (const f of files) assert.equal((await put(owner, name, f)).status, 201);
    const one = await post(owner, name, { attachments: [entry(files[0]!, "a.txt", "text/plain")] });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    assert.deepEqual(one.body.attachments, [{ sha256: sha(files[0]!), name: "a.txt", media_type: "text/plain", bytes: 2 }]);
    const four = await post(owner, name, { attachments: files.slice(0, 4).map((f, i) => entry(f, `f${i}.txt`, "text/plain")) });
    assert.equal(four.status, 201, JSON.stringify(four.body));
    assert.deepEqual(four.body.attachments.map((a: any) => a.name), ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]);
    // Each hash is a sha256.file fingerprint of the post, added by the service.
    const read = await call("GET", `/v1/posts/${four.body.post_id}`, owner.token);
    for (const f of files.slice(0, 4)) {
      assert.ok(read.body.fingerprints.some((p: any) => p.scheme === "sha256.file" && p.value === sha(f)));
    }
    const five = await post(owner, name, { attachments: files.map((f, i) => entry(f, `g${i}.txt`, "text/plain")) });
    assert.equal(five.status, 400);
    assert.equal(five.body.error.detail, "attachments: at most 4");
  });

  test("a repeated hash or name, a malformed name or type, an extra field, and a version are refused", async () => {
    const name = await space(owner, { document: true });
    const a = entry("same\n", "x.txt", "text/plain");
    const cases: [string, unknown, string, string?][] = [
      ["a repeated hash", [a, { ...a, name: "y.txt" }], "attachments[1].sha256 is named twice"],
      ["a repeated name", [a, { ...entry("other\n"), name: "x.txt" }], "attachments[1].name is named twice"],
      ["an empty name", [{ ...a, name: "" }], "attachments[0].name"],
      ["a slash", [{ ...a, name: "a/b" }], "attachments[0].name: no control or format character, no slash or backslash, and no leading dot"],
      ["a backslash", [{ ...a, name: "a\\b" }], "attachments[0].name: no control or format character"],
      ["a leading dot", [{ ...a, name: ".env" }], "attachments[0].name: no control or format character"],
      ["a newline", [{ ...a, name: "a\nb" }], "attachments[0].name: no control or format character"],
      ["a C1 control", [{ ...a, name: `a${String.fromCharCode(0x85)}b` }], "attachments[0].name: no control or format character"],
      // Characters that make a name read as another: report<RLO>txt.py shows as reportyp.txt.
      ...[0x202e, 0x2066, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff].map((code): [string, unknown, string] =>
        [`U+${code.toString(16)}`, [{ ...a, name: `report${String.fromCharCode(code)}txt.py` }], "attachments[0].name: no control or format character"]),
      ["a long name", [{ ...a, name: "n".repeat(256) }], "attachments[0].name"],
      ["an uppercase type", [{ ...a, media_type: "Text/Plain" }], "attachments[0].media_type is a lowercase type/subtype, no parameters"],
      ["a parameter", [{ ...a, media_type: "text/plain; charset=utf-8" }], "attachments[0].media_type is a lowercase"],
      ["a short type", [{ ...a, media_type: "a/" }], "attachments[0].media_type"],
      ["a long type", [{ ...a, media_type: `text/${"x".repeat(123)}` }], "attachments[0].media_type"],
      ["no subtype", [{ ...a, media_type: "text" }], "attachments[0].media_type is a lowercase"],
      ["an uppercase hash", [{ ...a, sha256: a.sha256.toUpperCase() }], "attachments[0].sha256 is 64 lowercase hex characters"],
      ["an extra field", [{ ...a, size: 4 }], "attachments[0].size is not a field of an attachment"],
      ["not a list", { a }, "attachments is a list"],
    ];
    for (const [what, attachments, detail] of cases) {
      const out = await post(owner, name, { attachments });
      assert.equal(out.status, 400, `${what}: ${JSON.stringify(out.body)}`);
      assert.ok(String(out.body.error.detail).startsWith(detail), `${what}: ${out.body.error.detail}`);
    }
    const version = await post(owner, name, { kind: "version", body: "# Doc\n", attachments: [a] });
    assert.equal(version.status, 400);
    assert.equal(version.body.error.detail, "a version is its document, its body, and takes no attachments");
    // The zero-width non-joiner and joiner are part of Persian and Indic names.
    for (const [i, joiner] of ["\u200c", "\u200d"].entries()) {
      const content = `joined ${i}\n`;
      await put(owner, name, content);
      const named = await post(owner, name, { attachments: [entry(content, `\u0645\u06cc${joiner}\u062e\u0648\u0627\u0647\u0645.txt`, "text/plain")] });
      assert.equal(named.status, 201, JSON.stringify(named.body));
    }
    // An empty list and null are no list.
    assert.equal((await post(owner, name, { attachments: [] })).status, 201);
    assert.equal((await post(owner, name, { attachments: null })).status, 201);
  });

  test("bytes another KEY uploaded, and bytes older than the window, are ATTACHMENT_NOT_FOUND and post nothing", async () => {
    const name = await space(owner);
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    const content = "theirs\n";
    assert.equal((await put(owner, name, content)).status, 201);
    const theirs = await post(writer, name, { attachments: [entry(content)], idempotency_key: "t1" });
    assert.equal(theirs.status, 422, JSON.stringify(theirs.body));
    assert.equal(theirs.body.error.code, "ATTACHMENT_NOT_FOUND");
    assert.equal(theirs.body.error.detail, sha(content));
    // A day and a minute old.
    assert.equal((await put(writer, name, content)).status, 201);
    await fixture.owner`
      update schellingaf.file_uploads set uploaded_at = now() - interval '24 hours 1 minute'
       where uploader_id = ${Buffer.from(writer.peerId, "hex")}`;
    const stale = await post(writer, name, { attachments: [entry(content)], idempotency_key: "t1" });
    assert.equal(stale.body.error.code, "ATTACHMENT_NOT_FOUND");
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.posts where author_id = ${Buffer.from(writer.peerId, "hex")}`;
    assert.equal(row!.n, 0, "the post rolled back with its attachments");
    // Uploaded again, it attaches.
    assert.equal((await put(writer, name, content)).status, 201);
    assert.equal((await post(writer, name, { attachments: [entry(content)], idempotency_key: "t1" })).status, 201);
  });

  test("a SPACE's attached bytes are capped at FILE_LIMIT, a file attached twice counted once", async () => {
    const name = await space(owner);
    const big = Buffer.alloc(1000, 0x62);
    const small = Buffer.alloc(10, 0x63);
    await put(owner, name, big);
    await put(owner, name, small);
    // The limit, as the posts route passes it, is the constant; here the total stands near it.
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    await fixture.owner`
      insert into schellingaf.space_file_totals (space_id, attached_bytes)
      values (${s!.space_id}::uuid, ${ATTACHMENT_LIMITS.attachedBytesPerSpace - 1005})`;
    const first = await post(owner, name, { attachments: [{ sha256: sha(big), name: "big.bin", media_type: "application/octet-stream" }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // The same bytes again cost nothing.
    await put(owner, name, big);
    const twice = await post(owner, name, { attachments: [{ sha256: sha(big), name: "big.bin", media_type: "application/octet-stream" }] });
    assert.equal(twice.status, 201, JSON.stringify(twice.body));
    const over = await post(owner, name, { attachments: [{ sha256: sha(small), name: "small.bin", media_type: "application/octet-stream" }] });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, "FILE_LIMIT");
    const [total] = await fixture.owner<{ b: string }[]>`select attached_bytes::text as b from schellingaf.space_file_totals where space_id = ${s!.space_id}::uuid`;
    assert.equal(Number(total!.b), ATTACHMENT_LIMITS.attachedBytesPerSpace - 5);
  });

  test("hiding or withholding the post that holds a SPACE's bytes gives them back; showing or releasing it takes them back, never refused", async () => {
    const name = await space(owner);
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    const big = Buffer.alloc(1000, 0x66);
    const next = Buffer.alloc(500, 0x67);
    const shared = Buffer.alloc(300, 0x68);
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    const total = async () => {
      const [t] = await fixture.owner<{ b: string }[]>`select attached_bytes::text as b from schellingaf.space_file_totals where space_id = ${s!.space_id}::uuid`;
      return Number(t?.b ?? 0);
    };
    const limit = ATTACHMENT_LIMITS.attachedBytesPerSpace;
    await fixture.owner`insert into schellingaf.space_file_totals (space_id, attached_bytes) values (${s!.space_id}::uuid, ${limit - 1000})`;
    await put(writer, name, big);
    const holder = await post(writer, name, { attachments: [entry(big, "big.bin", "application/octet-stream")] });
    assert.equal(holder.status, 201, JSON.stringify(holder.body));
    assert.equal(await total(), limit);
    await put(owner, name, next);
    const full = await post(owner, name, { attachments: [entry(next, "next.bin", "application/octet-stream")] });
    assert.equal(full.body.error.code, "FILE_LIMIT");

    // Hidden, the post gives its 1000 bytes back, and the next file fits.
    assert.equal((await call("PUT", `/v1/posts/${holder.body.post_id}/hidden`, owner.token)).status, 200);
    assert.equal(await total(), limit - 1000);
    const fits = await post(owner, name, { attachments: [entry(next, "next.bin", "application/octet-stream")] });
    assert.equal(fits.status, 201, JSON.stringify(fits.body));
    assert.equal(await total(), limit - 500);
    // Shown again, the post takes them back, past the limit, and is not refused.
    assert.equal((await call("DELETE", `/v1/posts/${holder.body.post_id}/hidden`, owner.token)).status, 200);
    assert.equal(await total(), limit + 500);

    // A file two posts attach is given back only when neither is shown.
    await fixture.owner`update schellingaf.space_file_totals set attached_bytes = 0 where space_id = ${s!.space_id}::uuid`;
    // A SPACE's owner hides its writers' posts, never its own.
    const second = await agent();
    await grant(owner, name, second, "writer");
    await put(writer, name, shared);
    await put(second, name, shared);
    const one = await post(writer, name, { attachments: [entry(shared, "s.bin", "application/octet-stream")] });
    const two = await post(second, name, { attachments: [entry(shared, "s.bin", "application/octet-stream")] });
    assert.equal(await total(), 300);
    const withhold = (id: string) => fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${id}::uuid`;
    await withhold(one.body.post_id);
    assert.equal(await total(), 300, "the other post still holds it");
    const hid = await call("PUT", `/v1/posts/${two.body.post_id}/hidden`, owner.token);
    assert.equal(hid.status, 200, JSON.stringify(hid.body));
    assert.equal(await total(), 0);
    // Hiding a withheld post changes nothing; releasing it while hidden changes nothing.
    await call("PUT", `/v1/posts/${one.body.post_id}/hidden`, owner.token);
    await fixture.owner`update schellingaf.withheld set released_at = now() where post_id = ${one.body.post_id}::uuid and released_at is null`;
    assert.equal(await total(), 0);
    await call("DELETE", `/v1/posts/${one.body.post_id}/hidden`, owner.token);
    assert.equal(await total(), 300);

    // Attach, hide, attach again from a second post, hide the second: counted while some
    // shown post attaches it, and never below zero.
    const third = Buffer.alloc(200, 0x69);
    await fixture.owner`update schellingaf.space_file_totals set attached_bytes = 0 where space_id = ${s!.space_id}::uuid`;
    await put(writer, name, third);
    const a = await post(writer, name, { attachments: [entry(third, "t.bin", "application/octet-stream")] });
    assert.equal(await total(), 200);
    await call("PUT", `/v1/posts/${a.body.post_id}/hidden`, owner.token);
    assert.equal(await total(), 0);
    await put(second, name, third);
    const b = await post(second, name, { attachments: [entry(third, "t.bin", "application/octet-stream")] });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(await total(), 200);
    await call("PUT", `/v1/posts/${b.body.post_id}/hidden`, owner.token);
    assert.equal(await total(), 0);
    await call("DELETE", `/v1/posts/${a.body.post_id}/hidden`, owner.token);
    await call("DELETE", `/v1/posts/${b.body.post_id}/hidden`, owner.token);
    assert.equal(await total(), 200, "counted once, however many posts show it");
  });

  test("the operator may erase a file's bytes only while every post attaching it is withheld, and it is never served again", async () => {
    const name = await space(owner, { visibility: "public" });
    const content = "unlawful bytes\n";
    const first = await attached(owner, name, content);
    await put(owner, name, content);
    const second = await post(owner, name, { attachments: [entry(content)] });
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    const erase = () => fixture.owner`
      update schellingaf.space_files set content = null
       where space_id = ${s!.space_id}::uuid and sha256 = decode(${sha(content)}, 'hex')`;
    const withhold = (id: string) => fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'legal_order', 'a test' from schellingaf.posts p where p.post_id = ${id}::uuid`;
    await assert.rejects(erase(), /IMMUTABLE_RECORD/, "both posts are shown");
    await withhold(first);
    await assert.rejects(erase(), /IMMUTABLE_RECORD/, "one post is still shown");
    // Hidden is not withheld: the SPACE's owner cannot have bytes erased.
    await call("PUT", `/v1/posts/${second.body.post_id}/hidden`, owner.token);
    await assert.rejects(erase(), /IMMUTABLE_RECORD/, "a hidden post is not withheld");
    await call("DELETE", `/v1/posts/${second.body.post_id}/hidden`, owner.token);
    await withhold(second.body.post_id);
    await erase();
    // Nothing else may change with it, and nothing brings the bytes back.
    await assert.rejects(fixture.owner`
      update schellingaf.space_files set content = convert_to(${content}, 'UTF8')
       where space_id = ${s!.space_id}::uuid and sha256 = decode(${sha(content)}, 'hex')`, /IMMUTABLE_RECORD/);
    await fixture.owner`update schellingaf.withheld set released_at = now() where space_id = ${s!.space_id}::uuid and released_at is null`;
    const fetched = await raw(await app.request(`/v1/spaces/${name}/files/${sha(content)}`));
    assert.equal(fetched.status, 404);
    assert.equal(fetched.body.error.code, "FILE_NOT_FOUND");
    // Absent for good: an upload stores nothing, and a new post naming the hash is refused,
    // its author's upload from before the erasure included.
    assert.equal((await put(owner, name, content)).status, 201);
    const again = await post(owner, name, { attachments: [entry(content)] });
    assert.equal(again.status, 422, JSON.stringify(again.body));
    assert.equal(again.body.error.code, "ATTACHMENT_NOT_FOUND");
    const [kept] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_files
       where space_id = ${s!.space_id}::uuid and sha256 = decode(${sha(content)}, 'hex') and content is not null`;
    assert.equal(kept!.n, 0);
    // The posts still list the file: its hash, name and size are kept, its bytes are not.
    const one = await call("GET", `/v1/posts/${second.body.post_id}`, owner.token);
    assert.equal(one.body.attachments[0].sha256, sha(content));
  });

  test("fingerprints past 32 with the added ones are refused; one the author sent is not added twice", async () => {
    const name = await space(owner);
    const content = "fp\n";
    await put(owner, name, content);
    const prints = Array.from({ length: 32 }, (_, i) => ({ scheme: "test.n", value: String(i) }));
    const over = await post(owner, name, { fingerprints: prints, attachments: [entry(content)] });
    assert.equal(over.status, 400);
    assert.equal(over.body.error.detail, "fingerprints and one sha256.file for each attachment: at most 32 in all");
    const own = [...prints.slice(0, 31), { scheme: "sha256.file", value: sha(content) }];
    const fits = await post(owner, name, { fingerprints: own, attachments: [entry(content)] });
    assert.equal(fits.status, 201, JSON.stringify(fits.body));
  });

  test("a replay with the same list answers the same; a changed name or a dropped list is IDEMPOTENCY_CONFLICT", async () => {
    const name = await space(owner);
    const content = "replay\n";
    await put(owner, name, content);
    const fields = { attachments: [entry(content, "r.txt", "text/plain")], idempotency_key: "replay-1" };
    const first = await post(owner, name, fields);
    assert.equal(first.status, 201);
    const again = await post(owner, name, fields);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.post_id, first.body.post_id);
    assert.deepEqual(again.body.attachments, first.body.attachments);
    const renamed = await post(owner, name, { ...fields, attachments: [entry(content, "s.txt", "text/plain")] });
    assert.equal(renamed.body.error.code, "IDEMPOTENCY_CONFLICT");
    // The same fingerprints sent by hand, and no list: a conflict, not a replay.
    const dropped = await post(owner, name, {
      idempotency_key: "replay-1", fingerprints: [{ scheme: "sha256.file", value: sha(content) }],
    });
    assert.equal(dropped.body.error.code, "IDEMPOTENCY_CONFLICT", JSON.stringify(dropped.body));
  });

  test("a post made without attachments replays byte for byte as before", async () => {
    const name = await space(owner);
    const fields = { title: "Plain", fingerprints: [{ scheme: "test.k", value: "v" }], idempotency_key: "plain-1" };
    const first = await post(owner, name, fields);
    const again = await post(owner, name, fields);
    assert.equal(again.status, 200);
    // A first answer says sealed: false and a replay leaves it out, as before this change.
    const { replayed: _r, receipt: _s, sealed: _u, ...a } = first.body;
    const { replayed: _q, receipt: _t, ...b } = again.body;
    assert.deepEqual(b, a);
    assert.equal("attachments" in again.body, false);
  });

  test("a signed post whose hashes are in canonical is taken and checks with GET /verify-post.mjs; one whose hash is not, refused", async () => {
    const name = await space(owner);
    const content = "signed\n";
    await put(owner, name, content);
    const good = await signed(owner, name, [{ scheme: "sha256.file", value: sha(content) }], "sig-1");
    const ok = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { ...good, attachments: [entry(content)] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.signed, true);
    assert.equal(ok.body.attachments.length, 1);
    // The served verifier checks the post as it reads back, attachments beside it.
    const one = await call("GET", `/v1/posts/${ok.body.post_id}`, owner.token);
    assert.equal(one.body.attachments.length, 1);
    const checked = spawnSync(process.execPath, [new URL("../content/verify-post.mjs", import.meta.url).pathname], { input: JSON.stringify(one.body), encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /the Ed25519 signature verifies/);
    const bad = await signed(owner, name, [], "sig-2");
    const refused = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { ...bad, attachments: [entry(content)] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.detail, "attachments[0].sha256 is not a sha256.file fingerprint in canonical: put it there before you sign");
  });
});

/** A signed post's request, as an agent signing with its Ed25519 KEY sends it. */
async function signed(who: Agent, name: string, fingerprints: { scheme: string; value: string }[], key: string) {
  const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
  const built = buildPostObject({
    spaceId: s!.space_id, author: who.peerId, idempotencyKey: key, kind: "result", title: "A signed POST in a test",
    body: "Run: python3 solve.py", to: [], replyTo: null, supersedes: null, retracts: null,
    fingerprints, data: null, budget: null, runId: null,
  });
  const signature = sign(null, signaturePreimageOf(built.objectId), who.privateKey).toString("hex");
  return { canonical: built.canonical.toString("base64url"), alg: "ed25519", signature };
}

describe("fetching a file", () => {
  test("a text file and a binary one are served whole and inert, every header in place", async () => {
    const name = await space(owner);
    const text = "\ufeffline one\r\nline two\r\n";
    const binary = Buffer.from([0x68, 0x69, 0x00, 0x0d, 0x0a, 0xff]);
    await put(owner, name, text);
    await put(owner, name, binary);
    const out = await post(owner, name, { attachments: [entry(text, "bom.txt", "text/html"), { sha256: sha(binary), name: "x.svg", media_type: "image/svg+xml" }] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    for (const [content, type] of [[Buffer.from(text), "text/plain; charset=utf-8"], [binary, "application/octet-stream"]] as const) {
      const got = await fetchFile(owner, name, sha(content));
      assert.equal(got.status, 200);
      assert.ok(got.bytes.equals(content), "the bytes unchanged");
      assert.equal(got.headers.get("content-type"), type, "the service's type, never the author's");
      assert.equal(got.headers.get("content-length"), String(content.length));
      assert.equal(got.headers.get("content-disposition"), `attachment; filename="${sha(content)}"`);
      assert.equal(got.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.equal(got.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(got.headers.get("accept-ranges"), "none");
      assert.equal(got.headers.get("x-content-type-options"), "nosniff");
      assert.equal(got.headers.get("x-robots-tag"), "noindex");
      assert.equal(got.headers.get("cache-control"), "no-store");
      assert.equal(got.headers.get("etag"), null, "no validator for a caller with a token");
      // HEAD: the same headers, no body. A Range is answered whole.
      const head = await fetchFile(owner, name, sha(content), "HEAD");
      assert.equal(head.status, 200);
      assert.equal(head.bytes.length, 0);
      assert.equal(head.headers.get("content-length"), String(content.length));
      assert.equal(head.headers.get("content-type"), type);
      const ranged = await fetchFile(owner, name, sha(content), "GET", { range: "bytes=0-1" });
      assert.equal(ranged.status, 200);
      assert.ok(ranged.bytes.equals(content));
      // Markdown asked for changes nothing.
      const md = await fetchFile(owner, name, sha(content), "GET", { accept: "text/markdown" });
      assert.ok(md.bytes.equals(content));
    }
  });

  test("a caller with no token in a public SPACE may revalidate: ETag, 304; with a token, never", async () => {
    const name = await space(owner);
    const content = "cache me\n";
    await attached(owner, name, content);
    const anon = await fetchFile(null, name, sha(content));
    assert.equal(anon.status, 200);
    assert.equal(anon.headers.get("cache-control"), "public, max-age=60");
    const etag = anon.headers.get("etag");
    assert.equal(etag, `"${sha(content).slice(0, 32)}"`);
    const again = await fetchFile(null, name, sha(content), "GET", { "if-none-match": etag! });
    assert.equal(again.status, 304);
    const member = await fetchFile(owner, name, sha(content), "GET", { "if-none-match": etag! });
    assert.equal(member.status, 200);
    assert.equal(member.headers.get("etag"), null);
  });

  test("everything the caller may not read answers one FILE_NOT_FOUND, byte for byte, for GET and HEAD", async () => {
    const pub = await space(owner);
    const priv = await space(owner, { visibility: "private" });
    const writer = await agent();
    const reader = await agent();
    const stranger = await agent();
    for (const s of [pub, priv]) {
      await grant(owner, s, writer, "writer");
      await grant(owner, s, reader, "reader");
    }
    const never = sha("never held\n");
    // Bytes pending, never attached.
    await put(owner, pub, "pending\n");
    // Bytes whose only post is hidden, and whose only post is withheld.
    const hiddenPost = await attached(writer, pub, "hidden\n");
    assert.equal((await call("PUT", `/v1/posts/${hiddenPost}/hidden`, owner.token)).status, 200);
    const withheldPost = await attached(owner, pub, "withheld\n");
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'credential_exposure', 'test' from schellingaf.posts p where p.post_id = ${withheldPost}::uuid`;
    // A private SPACE's file, which a stranger cannot read.
    await attached(owner, priv, "private\n");
    // A sealed SPACE's address is no different from a missing one's.
    const cases: [string, string][] = [
      [`nowhere-${n++}`, sha("x")],
      [pub, never],
      [pub, sha("pending\n")],
      [pub, sha("hidden\n")],
      [pub, sha("withheld\n")],
    ];
    const strip = (r: Raw) => {
      const headers = [...r.headers.entries()]
        .filter(([k]) => !["x-request-id", "date"].includes(k) && !k.startsWith("ratelimit"))
        .sort();
      const body = r.body ? { ...r.body, error: { ...r.body.error, request_id: "-" } } : null;
      return JSON.stringify({ status: r.status, headers, body });
    };
    for (const who of [null, stranger, reader, writer]) {
      for (const method of ["GET", "HEAD"]) {
        const answers = [];
        for (const [s, a] of cases) answers.push(strip(await fetchFile(who, s, a, method)));
        if (who === null || who === stranger) answers.push(strip(await fetchFile(who, priv, sha("private\n"), method)));
        const first = answers[0]!;
        assert.ok(first.includes("404"), first);
        for (const [i, answer] of answers.entries()) assert.equal(answer, first, `case ${i} for ${who === null ? "no token" : "a KEY"} ${method}`);
      }
    }
    const one = await fetchFile(null, pub, never);
    assert.equal(one.body.error.code, "FILE_NOT_FOUND");
    assert.equal(one.body.error.detail, undefined);
    assert.equal(one.headers.get("content-disposition"), null);
    assert.equal(one.headers.get("etag"), null);
    // The writer and the owner read the private file.
    assert.equal((await fetchFile(reader, priv, sha("private\n"))).status, 200);
  });

  test("a malformed address is INVALID_REQUEST before any query, for every SPACE alike", async () => {
    for (const s of [`nowhere-${n++}`, await space(owner)]) {
      const out = await fetchFile(null, s, "nothex");
      assert.equal(out.status, 400);
      assert.equal(out.body.error.detail, "sha256 is the SHA-256 of the file: 64 lowercase hex characters");
    }
  });

  test("hidden bytes are served again once another visible post attaches them; retracting or superseding stops nothing", async () => {
    const name = await space(owner);
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    const content = "shared\n";
    const hidden = await attached(writer, name, content);
    await call("PUT", `/v1/posts/${hidden}/hidden`, owner.token);
    assert.equal((await fetchFile(null, name, sha(content))).status, 404);
    await attached(owner, name, content);
    assert.equal((await fetchFile(null, name, sha(content))).status, 200);
    // Retracted and superseded posts keep serving.
    const kept = "kept\n";
    const first = await attached(owner, name, kept);
    assert.equal((await post(owner, name, { retracts: first, body: "withdrawn" })).status, 201);
    assert.equal((await fetchFile(null, name, sha(kept))).status, 200);
    const other = "kept too\n";
    const second = await attached(owner, name, other);
    assert.equal((await post(owner, name, { supersedes: second, body: "newer" })).status, 201);
    assert.equal((await fetchFile(null, name, sha(other))).status, 200);
  });

  test("a file in one SPACE is never reached by naming another", async () => {
    const here = await space(owner);
    const there = await space(owner);
    const content = "only here\n";
    await attached(owner, here, content);
    assert.equal((await fetchFile(owner, there, sha(content))).status, 404);
  });
});

describe("every read of a post carries its files' count, and at full their list", () => {
  test("a page, one post, a batch, a mailbox item, a SEEK hit and an export line", async () => {
    const name = await space(owner);
    const reader = await agent();
    await grant(owner, name, reader, "writer");
    const content = "read me\n";
    await put(owner, name, content);
    const out = await post(owner, name, { to: [reader.peerId], attachments: [entry(content, "r.txt", "text/plain")] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const id = out.body.post_id;
    const list = [{ sha256: sha(content), name: "r.txt", media_type: "text/plain", bytes: Buffer.byteLength(content) }];
    const counts = (item: any) => ({ count: item.attachment_count, bytes: item.attachment_bytes, list: item.attachments });
    // A page at its default detail, headlines: a flag. At snippets the count and the bytes, no list.
    const headlines = await call("GET", `/v1/spaces/${name}/posts?after=0`, reader.token);
    assert.ok(headlines.body.items.find((p: any) => p.seq === out.body.seq).flags.includes("files"), JSON.stringify(headlines.body));
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=snippets`, reader.token);
    assert.deepEqual(counts(page.body.items.find((p: any) => p.post_id === id)), { count: 1, bytes: list[0]!.bytes, list: undefined });
    const full = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=full`, reader.token);
    assert.deepEqual(full.body.items.find((p: any) => p.post_id === id).attachments, list);
    // One post and a batch, full by default.
    assert.deepEqual((await call("GET", `/v1/posts/${id}`, reader.token)).body.attachments, list);
    assert.deepEqual((await call("GET", `/v1/posts?ids=${id}`, reader.token)).body.items[0].attachments, list);
    // The mailbox, at snippets by default.
    const mail = await call("GET", "/v1/mailbox", reader.token);
    const item = mail.body.items.find((m: any) => (m.post?.post_id ?? m.post_id) === id);
    assert.ok(item, JSON.stringify(mail.body).slice(0, 400));
    const mailed = item.post ?? item;
    assert.equal(mailed.attachment_count, 1);
    assert.equal(mailed.attachment_bytes, list[0]!.bytes);
    // A SEEK by the file's fingerprint finds the post; at full, its list says the SPACE holds the bytes.
    const seek = await call("GET", `/v1/seek?fingerprint=sha256.file:${sha(content)}&space=${name}`, reader.token);
    assert.equal(seek.status, 200, JSON.stringify(seek.body));
    const hit = seek.body.items.find((h: any) => (h.post?.post_id ?? h.post_id) === id);
    assert.ok(hit, JSON.stringify(seek.body).slice(0, 400));
    assert.equal((hit.post ?? hit).attachment_count, 1);
    const seekFull = await call("GET", `/v1/seek?fingerprint=sha256.file:${sha(content)}&space=${name}&detail=full`, reader.token);
    const fullHit = seekFull.body.items.find((h: any) => (h.post?.post_id ?? h.post_id) === id);
    assert.deepEqual((fullHit.post ?? fullHit).attachments, list);
    // An export line carries the list and never the bytes; its trailer is as it was.
    const exported = await raw(await app.request(`/v1/spaces/${name}/posts`, {
      headers: { authorization: `Bearer ${reader.token}`, accept: "application/x-ndjson" },
    }));
    const lines = exported.text.trim().split("\n").map((l) => JSON.parse(l));
    const line = lines.find((l) => l.post_id === id);
    assert.deepEqual(line.attachments, list);
    assert.equal(exported.text.includes(Buffer.from(content).toString("base64")), false, "no file bytes in an export");
    const trailer = lines[lines.length - 1];
    assert.equal(trailer.export.version, 2);
    assert.equal(trailer.export.format, "schellingaf-ndjson");
  });
});

describe("the prune and the rows' rules", () => {
  test("the prune removes pending bytes a day old, keeps attached ones and fresh uploads", async () => {
    const name = await space(owner);
    await put(owner, name, "old pending\n");
    await put(owner, name, "fresh pending\n");
    await attached(owner, name, "attached\n");
    await fixture.owner`
      update schellingaf.file_uploads set uploaded_at = now() - interval '25 hours'
       where sha256 in (${Buffer.from(sha("old pending\n"), "hex")}, ${Buffer.from(sha("attached\n"), "hex")})`;
    const result = await prune(db);
    assert.equal(result.state, "pruned");
    const left = await fixture.owner<{ h: string }[]>`
      select encode(f.sha256, 'hex') as h from schellingaf.space_files f join schellingaf.spaces s on s.space_id = f.space_id where s.name = ${name} order by 1`;
    assert.deepEqual(left.map((r) => r.h).sort(), [sha("attached\n"), sha("fresh pending\n")].sort());
  });

  test("the prune loses the race to an upload and to a post, in both orders", async () => {
    const name = await space(owner);
    const content = "racing\n";
    await put(owner, name, content);
    await fixture.owner`update schellingaf.file_uploads set uploaded_at = now() - interval '25 hours' where sha256 = ${Buffer.from(sha(content), "hex")}`;
    // An upload that holds the row while the prune runs: the prune skips it.
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    await fixture.owner.begin(async (tx) => {
      await tx`select 1 from schellingaf.space_files where space_id = ${s!.space_id}::uuid for key share`;
      const [n1] = await db.write<{ n: number }[]>`select schellingaf.prune_files(${ATTACHMENT_LIMITS.pendingHours})::int as n`;
      assert.equal(n1!.n, 0, "a row an upload holds is skipped");
      // The upload lands while the prune waited.
      await tx`insert into schellingaf.file_uploads (space_id, sha256, uploader_id)
               values (${s!.space_id}::uuid, ${Buffer.from(sha(content), "hex")}, ${Buffer.from(owner.peerId, "hex")})
               on conflict (space_id, sha256, uploader_id) do update set uploaded_at = now()`;
    });
    // Now fresh, it survives a prune, and attaches.
    const [n2] = await db.write<{ n: number }[]>`select schellingaf.prune_files(${ATTACHMENT_LIMITS.pendingHours})::int as n`;
    assert.equal(n2!.n, 0);
    const ok = await post(owner, name, { attachments: [entry(content)] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    // The other order: a prune that took the row first, then an upload of the same bytes,
    // which inserts it again.
    const gone = "gone\n";
    await put(owner, name, gone);
    await fixture.owner`update schellingaf.file_uploads set uploaded_at = now() - interval '25 hours' where sha256 = ${Buffer.from(sha(gone), "hex")}`;
    const [n3] = await db.write<{ n: number }[]>`select schellingaf.prune_files(${ATTACHMENT_LIMITS.pendingHours})::int as n`;
    assert.ok(n3!.n >= 1);
    const back = await put(owner, name, gone);
    assert.equal(back.status, 201);
    assert.equal((await post(owner, name, { attachments: [entry(gone)] })).status, 201);
  });

  test("a file row changes only from pending to attached, and an attached one is never deleted", async () => {
    const name = await space(owner);
    await attached(owner, name, "fixed\n");
    const h = Buffer.from(sha("fixed\n"), "hex");
    for (const change of [
      fixture.owner`update schellingaf.space_files set attached = false where sha256 = ${h}`,
      fixture.owner`update schellingaf.space_files set is_text = false where sha256 = ${h}`,
      fixture.owner`update schellingaf.space_files set stored_at = now() - interval '1 day' where sha256 = ${h}`,
      fixture.owner`delete from schellingaf.space_files where sha256 = ${h}`,
      fixture.owner`delete from schellingaf.post_attachments where sha256 = ${h}`,
      fixture.owner`update schellingaf.post_attachments set name = 'other.txt' where sha256 = ${h}`,
    ]) {
      await assert.rejects(change, /IMMUTABLE_RECORD|violates foreign key/);
    }
    await put(owner, name, "loose\n");
    const loose = Buffer.from(sha("loose\n"), "hex");
    await assert.rejects(fixture.owner`update schellingaf.space_files set bytes = 1 where sha256 = ${loose}`, /IMMUTABLE_RECORD|check constraint/);
  });

  test("the limits are the CHECKs' numbers", async () => {
    const checks = await fixture.owner<{ name: string; def: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid in ('schellingaf.space_files'::regclass, 'schellingaf.post_attachments'::regclass) and contype = 'c'`;
    const all = checks.map((c) => c.def).join("\n");
    assert.ok(all.includes(`${ATTACHMENT_LIMITS.fileBytes}`), all);
    assert.ok(all.includes(`BETWEEN 1 AND ${ATTACHMENT_LIMITS.perPost}`) || all.includes(`<= ${ATTACHMENT_LIMITS.perPost}`), all);
    assert.ok(all.includes(`${ATTACHMENT_LIMITS.nameBytes}`), all);
    assert.ok(all.includes(`${ATTACHMENT_LIMITS.mediaTypeBytes}`), all);
    const migration = readFileSync(new URL("../migrations/0121_attachments.sql", import.meta.url), "utf8");
    assert.ok(migration.includes(`BETWEEN 1 AND ${ATTACHMENT_LIMITS.fileBytes}`));
    assert.ok(migration.includes(`ord BETWEEN 1 AND ${ATTACHMENT_LIMITS.perPost}`));
    assert.ok(migration.includes(`BETWEEN 1 AND ${ATTACHMENT_LIMITS.nameBytes}`));
    assert.ok(migration.includes(`BETWEEN 3 AND ${ATTACHMENT_LIMITS.mediaTypeBytes}`));
  });

  test("the api role reads no pending file, no upload and no total", async () => {
    const name = await space(owner);
    await put(owner, name, "unseen\n");
    const rows = await fixture.asCaller(owner.peerId, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_files f join schellingaf.spaces s on s.space_id = f.space_id where s.name = ${name}`);
    assert.equal(rows[0]!.n, 0);
    await assert.rejects(fixture.api`select 1 from schellingaf.file_uploads`, /permission denied/);
    await assert.rejects(fixture.api`select 1 from schellingaf.space_file_totals`, /permission denied/);
  });

  test("fifty concurrent posts with attachments in one SPACE, beside uploads and a prune, finish without a deadlock", async () => {
    const name = await space(owner);
    const writers = await Promise.all(Array.from({ length: 10 }, () => agent()));
    for (const w of writers) await grant(owner, name, w, "writer");
    const shared = "shared by all\n";
    for (const w of writers) assert.equal((await put(w, name, shared)).status, 201);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      const w = writers[i % writers.length]!;
      const own = `own ${i}\n`;
      jobs.push((async () => {
        const up = await put(w, name, own);
        assert.equal(up.status, 201, up.text);
        const out = await post(w, name, { attachments: [entry(shared, "shared.txt", "text/plain"), entry(own, "own.txt", "text/plain")] });
        assert.equal(out.status, 201, JSON.stringify(out.body));
      })());
      if (i % 10 === 0) jobs.push(prune(db));
    }
    await Promise.all(jobs);
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.post_attachments a join schellingaf.spaces s on s.space_id = a.space_id where s.name = ${name}`;
    assert.equal(row!.n, 100);
  });
});
