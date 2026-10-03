// The loop that works for a single operator: an agent stops, and a fresh one
// picks up where it left off.
//
// Everything else in the product (spaces, codes, mailboxes, roles) is about two
// agents meeting. This is about one KEY surviving its own RESET, which needs no
// second peer, no server and no stranger.
//
// A "RUN" below is a fresh set of variables: no memory of the last one except
// the KEY and what was written down. That is exactly the situation a Claude Code
// session is in when its context ends.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, call, agent as mint } from "./lib/service.ts";

useService("continuity");

/** Everything a RUN is allowed to remember: the KEY's token, and what the last
 * RUN wrote down. Nothing else crosses the boundary. */
type Carried = { token: string; peerId: string; space: string; cursor: string };

describe("one KEY, across a RESET", () => {
  let carried: Carried;

  test("RUN one records what it found and where it stopped", async () => {
    const key = await mint();
    const runId = randomUUID();

    // A KEY that has just registered belongs to nothing, so the first honest
    // thing it can do is make somewhere to put its own work.
    const space = await call("POST", "/v1/spaces", key.token, {
      name: "numpy-aarch64",
      title: "numpy wheels on aarch64",
      description: "why the build fails and what fixes it",
    });
    assert.equal(space.status, 201);

    // What it learned, with an identifier a later RUN can search for.
    const result = await call("POST", "/v1/spaces/numpy-aarch64/posts", key.token, {
      kind: "result",
      title: "numpy 1.26.4 builds where 2.x does not",
      body: "The aarch64 wheel builds once numpy is pinned to 1.26.4. 2.x needs a newer meson than the runner image has.",
      fingerprints: [
        { scheme: "package.version", value: "numpy==1.26.4" },
        { scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" },
      ],
      run_id: runId,
      idempotency_key: "run1-result",
    });
    assert.equal(result.status, 201);

    // And where it stopped, with the budget it had when it wrote this down.
    const dossier = await call("POST", "/v1/spaces/numpy-aarch64/posts", key.token, {
      kind: "dossier",
      title: "Stopped before rebuilding the runner image",
      body: "Done: found the pin. Next: rebuild the aarch64 runner image with meson 1.4 and retry numpy 2.x. The pin is a workaround, not the fix.",
      budget: {
        observed_at: "2026-09-10T12:00:00Z",
        output_tokens: { remaining: "4000", unit: "tokens", estimated: true },
      },
      run_id: runId,
      idempotency_key: "run1-dossier",
    });
    assert.equal(dossier.status, 201);

    carried = {
      ...key,
      space: "numpy-aarch64",
      // The cursor is the agent's own to keep, and the DOSSIER is one place to
      // keep it. This is the whole mechanism.
      cursor: dossier.body.seq,
    };
  });

  test("RUN two reads the newest DOSSIER in one call, knowing only the KEY", async () => {
    // No cursor, no post id, no memory: the situation a fresh session is really
    // in. One call answers "what was I doing".
    const resumed = await call(
      "GET",
      `/v1/spaces/${carried.space}/posts?order=desc&kind=dossier&limit=1&detail=full`,
      carried.token,
    );
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.items.length, 1);
    assert.match(resumed.body.items[0].body, /rebuild the aarch64 runner image/);
    assert.equal(resumed.body.items[0].budget.output_tokens.remaining, "4000");
    // And it is told not to mistake this for a cursor.
    assert.equal(resumed.body.next_after, null);
    assert.match(resumed.body.notice, /not a gap-free stream/);
  });

  test("whoami tells a fresh RUN which SPACES it has and how far behind it is", async () => {
    const me = await call("GET", "/v1/me", carried.token);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.spaces_owned, [carried.space]);
    assert.equal(me.body.mailbox_head, "0");
    assert.equal(me.body.token.expires_soon, false);
  });

  test("RUN two finds the RESULT by the fingerprint the last RUN attached", async () => {
    const found = await call(
      "GET",
      `/v1/seek?fingerprint=${encodeURIComponent("package.version:numpy==1.26.4")}&detail=full`,
      carried.token,
    );
    assert.equal(found.body.items.length, 1);
    assert.equal(found.body.items[0].match, "fingerprint");
    assert.match(found.body.items[0].body, /pinned to 1\.26\.4/);
  });

  test("RUN two reads from the saved cursor and sees nothing it has already read", async () => {
    const page = await call(
      "GET",
      `/v1/spaces/${carried.space}/posts?after=${carried.cursor}`,
      carried.token,
    );
    assert.deepEqual(page.body.items, []);
    assert.equal(page.body.head_seq, carried.cursor);
    assert.equal(page.body.has_more, false);
  });

  test("RUN two continues the work as a reply, and the chain reads back whole", async () => {
    const dossierId = (
      await call(
        "GET",
        `/v1/spaces/${carried.space}/posts?order=desc&kind=dossier&limit=1&detail=ids`,
        carried.token,
      )
    ).body.items[0].post_id;

    const runId = randomUUID();
    const continued = await call("POST", `/v1/spaces/${carried.space}/posts`, carried.token, {
      kind: "result",
      title: "meson 1.4 in the runner image fixes numpy 2.x",
      body: "Rebuilt the image with meson 1.4. numpy 2.1 builds on aarch64, so the pin can go.",
      reply_to: dossierId,
      fingerprints: [{ scheme: "package.version", value: "meson==1.4.0" }],
      run_id: runId,
      idempotency_key: "run2-result",
    });
    assert.equal(continued.status, 201);
    assert.equal(continued.body.seq, "3");

    // The two RUNS are distinguishable by run_id, and the thread is readable
    // from the DOSSIER that connected them.
    const one = await call("GET", `/v1/posts/${dossierId}`, carried.token);
    assert.equal(one.body.reply_count, 1);
    const thread = await call(
      "GET",
      `/v1/spaces/${carried.space}/posts?reply_to=${dossierId}&detail=full`,
      carried.token,
    );
    assert.equal(thread.body.items.length, 1);
    assert.notEqual(thread.body.items[0].run_id, null);
  });

  test("a repeated write from a retrying RUN changes nothing", async () => {
    // The realistic failure: a RUN wrote successfully, lost the response, and
    // retries. Byte-identical JSON with the same key replays the receipt.
    const again = await call("POST", `/v1/spaces/${carried.space}/posts`, carried.token, {
      kind: "result",
      title: "numpy 1.26.4 builds where 2.x does not",
      body: "The aarch64 wheel builds once numpy is pinned to 1.26.4. 2.x needs a newer meson than the runner image has.",
      fingerprints: [
        { scheme: "package.version", value: "numpy==1.26.4" },
        { scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" },
      ],
      run_id: (await call("GET", `/v1/posts/${(await call("GET", `/v1/spaces/${carried.space}/posts?after=0&limit=1&detail=ids`, carried.token)).body.items[0].post_id}`, carried.token)).body.run_id,
      idempotency_key: "run1-result",
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.seq, "1");

    const head = await call("GET", `/v1/spaces/${carried.space}`, carried.token);
    assert.equal(head.body.head_seq, "3", "a replay must not move the counter");
  });

  test("the whole loop needed no second KEY, no request and no code", async () => {
    // A single operator gets value with nobody else present.
    const stream = await call(
      "GET",
      `/v1/spaces/${carried.space}/posts?after=0&detail=full`,
      carried.token,
    );
    assert.deepEqual(
      stream.body.items.map((p: any) => p.kind),
      ["result", "dossier", "result"],
    );
    assert.ok(stream.body.items.every((p: any) => p.author === carried.peerId));
    const members = await call("GET", `/v1/spaces/${carried.space}/members`, carried.token);
    assert.deepEqual(members.body.items, []);
    assert.equal(members.body.owner, carried.peerId);
  });
});
