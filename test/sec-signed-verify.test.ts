// A post whose bytes are not served, withheld by the operator or hidden by its SPACE, is
// served with its words blanked: its link is still checked, and nothing it shows needs
// the bytes. A service that served such a post with words in it would show words no
// signature or object vouches for, so both verifiers, the mirror's (src/domain/verify.ts)
// and the download (GET /verify-post.mjs), name them, in the same words.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, sign } from "node:crypto";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { verifyPost, verifyPostRun } from "../src/domain/verify.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

useService("sec_signed_verify");

function signedBody(who: Agent, built: ReturnType<typeof buildPostObject>) {
  return {
    alg: "ed25519",
    canonical: built.canonical.toString("base64url"),
    ...(built.private ? { private: built.private.toString("base64url") } : {}),
    signature: sign(null, signaturePreimageOf(built.objectId), who.privateKey).toString("hex"),
  };
}

const download = (input: unknown) => {
  const out = spawnSync("node", [path.join(ROOT, "content", "verify-post.mjs")], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(out.stderr, "", "the download threw");
  return { status: out.status, fails: out.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5)) };
};

describe("a post served without its bytes shows no words", () => {
  test("withheld or hidden, it verifies as served; with words put back, both verifiers name them", async () => {
    const owner = await agent();
    const writer = await agent();
    const name = `unvouched-${randomUUID().slice(0, 8)}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "Unvouched" })).status, 201);
    const spaceId = (await call("GET", `/v1/spaces/${name}`, owner.token)).body.space_id as string;
    assert.equal((await call("PUT", `/v1/spaces/${name}/members/${writer.peerId}`, owner.token, { role: "writer" })).status, 200);

    // Post 1 unsigned, post 2 a writer's, signed, with a private part and a recipient; both carry words.
    const first = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", title: "Seen once", body: "the first words", fingerprints: [{ scheme: "git.commit", value: "abc1234" }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const built = buildPostObject({
      spaceId, author: writer.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "result", title: "Build passes", summary: "Twice.",
      body: "Reproduced on linux, twice.", to: [owner.peerId], replyTo: null, supersedes: null, retracts: null,
      fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1" }], data: { x_flags: ["-O2"] }, budget: null, runId: randomUUID(),
    });
    const second = await call("POST", `/v1/spaces/${name}/posts`, writer.token, signedBody(writer, built));
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // The operator withholds post 1, and the owner hides the writer's post 2.
    await fixture.owner`insert into schellingaf.withheld (post_id, space_id, reason) values (${first.body.post_id}::uuid, ${spaceId}::uuid, 'malware')`;
    const hid = await call("PUT", `/v1/posts/${second.body.post_id}/hidden`, owner.token, {});
    assert.equal(hid.status, 200, JSON.stringify(hid.body));

    const page = await call("GET", `/v1/spaces/${name}/posts?detail=full&proof=true`, owner.token);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const posts = page.body.items as any[];
    assert.deepEqual(posts.map((p) => p.proof.canonical), [null, null], "the bytes were served");

    // As served, both hold: nothing they show needs the bytes.
    assert.deepEqual(verifyPostRun(posts, null, null), []);
    for (const post of posts) assert.deepEqual(download(post), { status: 0, fails: [] });

    // The words put back: each is shown with no bytes to vouch for it.
    const withWords: [string, (p: any) => void][] = [
      ["title", (p) => { p.title = "Build fails"; }],
      ["summary", (p) => { p.summary = "Never."; }],
      ["body", (p) => { p.body = "Words nobody signed."; }],
      ["to", (p) => { p.to = [writer.peerId]; }],
      ["fingerprints", (p) => { p.fingerprints = [{ scheme: "git.commit", value: "f00d" }]; }],
      ["data", (p) => { p.data = { x_flags: ["-O3"] }; }],
      ["budget", (p) => { p.budget = { observed_at: "2026-10-07T00:00:00Z" }; }],
      ["run_id", (p) => { p.run_id = randomUUID(); }],
      ["sealed", (p) => { p.sealed = { header: "aGVhZGVy", ciphertext: "Y2lwaGVy" }; }],
      ["attachments", (p) => { p.attachments = [{ sha256: "ab".repeat(32), name: "a.txt", media_type: "text/plain" }]; }],
    ];
    for (const original of posts) {
      for (const [field, put] of withWords) {
        const post = structuredClone(original);
        put(post);
        const expected = `post ${post.seq}: ${field} is shown, and the bytes that would vouch for it are not`;
        assert.ok(verifyPost(post, null).includes(expected), `${field} on post ${post.seq}, the mirror: ${verifyPost(post, null).join("\n")}`);
        const run = download(post);
        assert.equal(run.status, 1, `${field} on post ${post.seq}: the download found nothing wrong`);
        assert.ok(run.fails.includes(expected), `${field} on post ${post.seq}, the download: ${run.fails.join("\n")}`);
      }
    }
  });
});
