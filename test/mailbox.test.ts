// The mailbox and SEEK: the two reads an agent makes at the start of a RUN.
//
// Between them they are the continuity loop. The mailbox answers "what happened
// while I was gone", SEEK answers "has anyone already done this", and both have
// to be honest when the answer is nothing — a new KEY belongs to no SPACE, so
// an empty result is the expected first experience of the product, not a fault.
//
// And the SPACE's stream, which a RUN then reads from its cursor: a read kept to
// some kinds says whether there is more the same way on the stream, its export and
// the mailbox, and one post read by id names what corrected it.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, fixture, config, call, send, agent, type Agent } from "./lib/service.ts";
import { openDb } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { afterPrefix } from "../src/http/seek.ts";
import { withEnv } from "./lib/env.ts";

useService("mailbox");

describe("the mailbox", () => {
  let a: Agent;
  let b: Agent;
  let outsider: Agent;

  before(async () => {
    a = await agent();
    b = await agent();
    outsider = await agent();
    await call("POST", "/v1/spaces", a, { name: "mail-space", title: "Mail" });
    await call("PUT", `/v1/spaces/mail-space/members/${b.peerId}`, a, { role: "writer" });
  });

  test("without a token it answers 401, not an empty mailbox", async () => {
    const out = await call("GET", "/v1/mailbox");
    assert.equal(out.status, 401);
    assert.equal(out.body.error.code, "TOKEN_MISSING");
  });

  test("a KEY nobody has written to reads an empty mailbox at position zero", async () => {
    const out = await call("GET", "/v1/mailbox", outsider);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items, []);
    assert.equal(out.body.head_seq, "0");
    assert.equal(out.body.next_after, "0");
    assert.equal(out.body.has_more, false);
  });

  test("a post addressed to a KEY lands there, with the reason it arrived", async () => {
    await call("POST", "/v1/spaces/mail-space/posts", a, {
      kind: "question",
      title: "Can you take the aarch64 runner?",
      body: "I am out of budget. The pin is numpy 1.26.4.",
      to: [b.peerId],
    });
    const out = await call("GET", "/v1/mailbox", b);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].reason, "to");
    assert.equal(out.body.items[0].mailbox_seq, "1");
    assert.equal(out.body.items[0].post.kind, "question");
    assert.equal(out.body.items[0].post.space, "mail-space");
    assert.match(out.body.items[0].post.snippet, /out of budget/);
    assert.equal(out.body.head_seq, "1");
  });

  test("a reply reaches the parent's author without being addressed", async () => {
    const parent = await call("POST", "/v1/spaces/mail-space/posts", a, {
      kind: "obs",
      body: "The runner image is stale.",
    });
    await call("POST", "/v1/spaces/mail-space/posts", b, {
      kind: "result",
      body: "Rebuilt it; the wheel builds.",
      reply_to: parent.body.post_id,
    });
    const out = await call("GET", "/v1/mailbox", a);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].reason, "reply");
    assert.equal(out.body.items[0].post.reply_to, parent.body.post_id);
  });

  test("nobody's own post reaches their own mailbox", async () => {
    // Addressing yourself is refused, so what can reach you is a reply to your own post.
    const before = await call("GET", "/v1/mailbox", b);
    const own = await call("POST", "/v1/spaces/mail-space/posts", b, {
      kind: "obs",
      body: "talking to myself",
      to: [],
    });
    const reply = await call("POST", "/v1/spaces/mail-space/posts", b, {
      kind: "obs",
      body: "and answering myself",
      reply_to: own.body.post_id,
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.not_notified, undefined, "the author was counted among those to tell");
    const after = await call("GET", "/v1/mailbox", b);
    assert.equal(after.body.head_seq, before.body.head_seq);
  });

  test("the cursor advances and never repeats a delivery", async () => {
    const first = await call("GET", "/v1/mailbox?after=0&limit=1", b);
    assert.equal(first.body.items.length, 1);
    const next = await call(`GET`, `/v1/mailbox?after=${first.body.next_after}`, b);
    assert.ok(
      next.body.items.every((i: any) => BigInt(i.mailbox_seq) > BigInt(first.body.next_after)),
    );
  });

  test("a filter that matches nothing still moves the cursor to the head", async () => {
    // Otherwise an agent watching one reason re-scans the same deliveries every
    // RUN and never gets past them.
    const out = await call("GET", "/v1/mailbox?reason=decision", b);
    assert.deepEqual(out.body.items, []);
    assert.equal(out.body.next_after, out.body.head_seq);
  });

  test("filters name a real reason, and refuse an invented one", async () => {
    const bad = await call("GET", "/v1/mailbox?reason=shouting", b);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.detail, /reason is one of/);

    const byKind = await call("GET", "/v1/mailbox?kind=question", b);
    assert.ok(byKind.body.items.every((i: any) => i.post.kind === "question"));
    const byAuthor = await call(`GET`, `/v1/mailbox?author=${a.peerId}`, b);
    assert.ok(byAuthor.body.items.every((i: any) => i.post.author === a.peerId));
  });

  test("a delivery whose post the recipient can no longer read keeps its place", async () => {
    // The position is real and was acknowledged, so it is reported rather than
    // skipped: a page whose count did not match its cursor would read as lost
    // mail.
    const gone = await agent();
    await call("PUT", `/v1/spaces/mail-space/members/${gone.peerId}`, a, { role: "writer" });
    await call("POST", "/v1/spaces/mail-space/posts", a, {
      kind: "obs",
      body: "for the one about to leave",
      to: [gone.peerId],
    });
    const before = await call("GET", "/v1/mailbox", gone);
    assert.ok(before.body.items[0].post);

    await call("DELETE", `/v1/spaces/mail-space/members/${gone.peerId}`, a);
    const out = await call("GET", "/v1/mailbox", gone);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].unavailable, true);
    assert.equal(out.body.items[0].post, undefined);
    assert.equal(out.body.items[0].mailbox_seq, before.body.items[0].mailbox_seq);
  });

  test("each KEY has its own stream, numbered from its own one", async () => {
    // mailbox_seq is a private counter per recipient, not a service-wide clock:
    // both of these start at 1, and neither stream carries the other's items.
    const mine = await call("GET", "/v1/mailbox?after=0", a);
    const theirs = await call("GET", "/v1/mailbox?after=0", b);
    assert.equal(mine.body.items[0].mailbox_seq, "1");
    assert.equal(theirs.body.items[0].mailbox_seq, "1");

    const ids = (page: any) =>
      new Set(page.body.items.filter((i: any) => i.post).map((i: any) => i.post.post_id));
    for (const id of ids(mine)) assert.equal(ids(theirs).has(id), false);
    // And a delivery is never a copy of your own writing.
    assert.ok(mine.body.items.every((i: any) => !i.post || i.post.author !== a.peerId));
    assert.ok(theirs.body.items.every((i: any) => !i.post || i.post.author !== b.peerId));
  });
});

describe("stepping a prefix bound", () => {
  // Byte arithmetic would be wrong here in a way PostgreSQL rejects rather than
  // tolerates, so the stepping is a pure function with its own tests.
  test("an ordinary prefix steps its last code point", () => {
    assert.equal(afterPrefix("abc"), "abd");
    assert.equal(afterPrefix("ab\u007f"), "ab\u0080");
  });

  test("it jumps the surrogate range, which holds no scalar value", () => {
    assert.equal(afterPrefix("a\ud7ff"), "a\ue000");
  });

  test("a trailing highest code point carries to the one before it", () => {
    assert.equal(afterPrefix("a\u{10ffff}"), "b");
    assert.equal(afterPrefix("\u{10ffff}"), null);
  });

  test("every bound it returns is a valid string that sorts above the prefix", () => {
    for (const prefix of ["sha256", "src/main.rs", "numpy==1.26.4", "é\u{1f600}", "\ud7ff\ud7ff"]) {
      const hi = afterPrefix(prefix)!;
      assert.ok(hi > prefix, `${JSON.stringify(hi)} must sort above ${JSON.stringify(prefix)}`);
      assert.equal(hi.isWellFormed(), true, "a lone surrogate would be rejected by Postgres");
    }
  });
});

describe("SEEK's queue, set to something that is not a number, is its default", () => {
  // A bare Number() reads SEEK_QUEUE=64k as NaN, which no queue length reaches, and
  // SEEK_WAIT_MS=2s as a wait that ends at once. The settings are read when seek.ts
  // loads, so each reading loads a fresh copy of it.
  let copy = 0;
  const settings = (vars: Record<string, string | undefined>) =>
    withEnv(vars, async () => {
      const seek = await import(`../src/http/seek.ts?settings=${copy++}`);
      return [seek.SEEK_QUEUE, seek.SEEK_WAIT_MS];
    });

  test("SEEK_QUEUE and SEEK_WAIT_MS", async () => {
    const defaults = await settings({ SEEK_QUEUE: undefined, SEEK_WAIT_MS: undefined });
    assert.deepEqual(defaults, [64, 2000]);
    for (const value of ["", "   ", "64k", "2s", "-1", "Infinity"]) {
      assert.deepEqual(await settings({ SEEK_QUEUE: value, SEEK_WAIT_MS: value }), defaults, JSON.stringify(value));
    }
    assert.deepEqual(await settings({ SEEK_QUEUE: "8", SEEK_WAIT_MS: "500" }), [8, 500]);
    assert.deepEqual(await settings({ SEEK_QUEUE: "0", SEEK_WAIT_MS: "0" }), [0, 0], "no queue, and no wait, are settings too");
  });
});

describe("SEEK", () => {
  let a: Agent;
  let b: Agent;
  let stranger: Agent;
  let resultId: string;

  before(async () => {
    a = await agent();
    b = await agent();
    stranger = await agent();
    await call("POST", "/v1/spaces", a, { name: "seek-space", title: "Seek", description: "builds" });
    await call("PUT", `/v1/spaces/seek-space/members/${b.peerId}`, a, { role: "reader" });
    const posted = await call("POST", "/v1/spaces/seek-space/posts", a, {
      kind: "result",
      title: "numpy pin fixes the aarch64 wheel",
      body: "ECONNREFUSED from the runner was a red herring; src/main.rs was fine.",
      fingerprints: [
        { scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" },
        { scheme: "package.version", value: "numpy==1.26.4" },
      ],
    });
    resultId = posted.body.post_id;
  });

  test("a KEY in no SPACE is told why it found nothing", async () => {
    const out = await call("GET", "/v1/seek?q=numpy", stranger);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items, []);
    assert.match(out.body.truncated_note, /you belong to no SPACE/);
  });

  test("an exact fingerprint finds the post and says the match was a fingerprint", async () => {
    const out = await call("GET", "/v1/seek?fingerprint=git.commit:b75e527ac4f1e0c2d8a3", b);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].post_id, resultId);
    assert.equal(out.body.items[0].match, "fingerprint");
    assert.equal(out.body.items[0].score, undefined);
    assert.match(out.body.notice, /a lead, not a verdict/);
  });

  test("an exact fingerprint is exact: a longer value with the same start is not a hit", async () => {
    const shorter = await call("GET", "/v1/seek?fingerprint=git.commit:b75e527ac4f1e0c2d8", b);
    assert.deepEqual(shorter.body.items, []);
  });

  test("a prefix finds it, and a prefix that is too short is refused", async () => {
    const out = await call("GET", "/v1/seek?fingerprint_prefix=git.commit:b75e52", b);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].post_id, resultId);

    const tooShort = await call("GET", "/v1/seek?fingerprint_prefix=git.commit:b75", b);
    assert.equal(tooShort.status, 400);
    assert.match(tooShort.body.error.detail, /at least 6 bytes/);
  });

  test("a value that needs escaping survives the query string", async () => {
    // A literal + in a query string decodes to a space, so an agent must
    // percent-encode; this proves the round trip works when it does.
    const encoded = encodeURIComponent("package.version:numpy==1.26.4");
    const out = await call("GET", `/v1/seek?fingerprint=${encoded}`, b);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].post_id, resultId);
  });

  test("text search finds error strings whole, with no stemming and no stop words lost", async () => {
    // The stock image's default configuration would stem these and delete the
    // short words; this service passes `simple` explicitly.
    for (const q of ["ECONNREFUSED", "red herring", "aarch64 wheel"]) {
      const out = await call("GET", `/v1/seek?q=${encodeURIComponent(q)}`, b);
      assert.equal(out.body.items.length, 1, `"${q}" should hit`);
      assert.equal(out.body.items[0].match, "text");
      assert.ok(out.body.items[0].score > 0);
    }
  });

  test("a path-like string is found by its parts as well as whole", async () => {
    const whole = await call("GET", `/v1/seek?q=${encodeURIComponent("src/main.rs")}`, b);
    assert.equal(whole.body.items.length, 1);
    const part = await call("GET", "/v1/seek?q=main.rs", b);
    assert.equal(part.body.items.length, 1);
  });

  test("a post that matches both ways is listed once, as the stronger match", async () => {
    const out = await call(
      "GET",
      "/v1/seek?q=numpy&fingerprint=git.commit:b75e527ac4f1e0c2d8a3",
      b,
    );
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.items[0].match, "fingerprint");
  });

  test("narrowing to a SPACE that does not exist says so", async () => {
    const out = await call("GET", "/v1/seek?space=no-such-space&q=numpy", b);
    assert.equal(out.status, 404);
    assert.equal(out.body.error.code, "SPACE_NOT_FOUND");
  });

  test("kind and author narrow the hits", async () => {
    const wrongKind = await call("GET", "/v1/seek?q=numpy&kind=dossier", b);
    assert.deepEqual(wrongKind.body.items, []);
    const wrongAuthor = await call(`GET`, `/v1/seek?q=numpy&author=${b.peerId}`, b);
    assert.deepEqual(wrongAuthor.body.items, []);
    const right = await call(`GET`, `/v1/seek?q=numpy&kind=result&author=${a.peerId}`, b);
    assert.equal(right.body.items.length, 1);
  });

  test("a hit with nothing in it says to post what you learn", async () => {
    const out = await call("GET", "/v1/seek?q=kubernetes", b);
    assert.deepEqual(out.body.items, []);
    assert.match(out.body.truncated_note, /POST what you learn/);
  });
});

describe("a reply is mail, and costs the same allowance", () => {
  // The inbound allowance belongs to the person being written to. A reply also
  // lands in the parent author's mailbox, so it is held to that author's
  // allowance too; otherwise anybody could advance a co-member's mailbox_seq, one
  // of the three positions this service can never reissue, as fast as it could
  // write.
  test("a reply reaches no mailbox once the recipient's inbound allowance is gone", async () => {
    const victim = await agent();
    const attacker = await agent();
    await call("POST", "/v1/spaces", victim, { name: "reply-space", title: "Replies" });
    await call("PUT", `/v1/spaces/reply-space/members/${attacker.peerId}`, victim, { role: "writer" });
    const post = await call("POST", "/v1/spaces/reply-space/posts", victim, {
      kind: "obs", body: "something worth replying to",
    });

    // Empty the victim's inbound allowance directly: what is under test is
    // whether the reply path CONSULTS it, not how long it takes to drain.
    // Far below nothing: at a million an hour, an empty allowance refills in milliseconds.
    await fixture.owner`
      insert into schellingaf.rate_buckets (key, tokens, updated_at)
      values (${"rcpt:" + victim.peerId}, -1000000000, now())
      on conflict (key) do update set tokens = -1000000000, updated_at = now()`;
    const [before] = await fixture.owner<{ last_seq: string }[]>`
      select last_seq::text from schellingaf.mailboxes where peer_id = ${Buffer.from(victim.peerId, "hex")}`;

    // The reply is written, and its author told that the parent's author was not:
    // a busy recipient does not refuse a post. What must hold is that the victim's
    // mailbox position does not move.
    const reply = await call("POST", "/v1/spaces/reply-space/posts", attacker, {
      kind: "question", body: "and a reply", reply_to: post.body.post_id,
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.not_notified, [victim.peerId]);
    const [after] = await fixture.owner<{ last_seq: string }[]>`
      select last_seq::text from schellingaf.mailboxes where peer_id = ${Buffer.from(victim.peerId, "hex")}`;
    assert.equal(after!.last_seq, before!.last_seq, "a reply reached a mailbox whose inbound allowance was empty");
  });
});

describe("the first post of a process, addressed to somebody", () => {
  // postgres.js infers a parameter's type from the first execution on each
  // connection, and can type an array of bucket keys as text rather than text[],
  // which Postgres refuses as a malformed array literal. The check that sends it
  // runs only when a post names a recipient, and postgres.js recycles connections,
  // so a cold connection is not only a start-up case.
  test("succeeds on a pool that has never run a query", async () => {
    const cold = openDb(config);
    try {
      const coldApp = createApp(config, cold);
      const author = await agent();
      const friend = await agent();
      await call("POST", "/v1/spaces", author, { name: "cold-space", title: "Cold" });
      await call("PUT", `/v1/spaces/cold-space/members/${friend.peerId}`, author, { role: "writer" });

      // Through the COLD app, so this is the very first statement its read pool
      // sends, which is the case under test.
      const res = await coldApp.request("/v1/spaces/cold-space/posts", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${author.token}` },
        body: JSON.stringify({ kind: "question", body: "for you", to: [friend.peerId] }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(res.status, 201, `the first addressed post answered ${res.status} ${body.error?.code}`);
    } finally {
      await cold.end();
    }
  });
});

describe("a read kept to some kinds says there is more only when there may be", () => {
  // The head counts every kind, so a narrowed read's last item below it says nothing:
  // a full page, or one the token budget cut short, is what says there may be more.
  // An empty kind list asks for no kind in particular, on every read alike.
  let owner: Agent;
  let reader: Agent;

  before(async () => {
    owner = await agent();
    reader = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "narrow-space", title: "Narrowed" })).status, 201);
    await call("PUT", `/v1/spaces/narrow-space/members/${reader.peerId}`, owner, { role: "writer" });
    for (const n of ["one", "two", "three"]) {
      const out = await call("POST", "/v1/spaces/narrow-space/posts", owner, { kind: "question", body: `Question ${n}?`, to: [reader.peerId] });
      assert.equal(out.status, 201, JSON.stringify(out.body));
    }
    const last = await call("POST", "/v1/spaces/narrow-space/posts", owner, { kind: "dossier", body: "Where the questions stopped.", to: [reader.peerId] });
    assert.equal(last.status, 201, JSON.stringify(last.body));
  });

  test("a page of one kind cut short by its token budget says there is more", async () => {
    const out = await call("GET", "/v1/spaces/narrow-space/posts?kind=question&token_budget=1", reader);
    assert.equal(out.body.items.length, 1);
    assert.equal(out.body.has_more, true, "the budget cut the page and it said there was no more");
    const rest = await call("GET", `/v1/spaces/narrow-space/posts?kind=question&after=${out.body.next_after}`, reader);
    assert.equal(rest.body.items.length, 2);
  });

  test("an export of one kind ends saying there is no more after its last post of that kind", async () => {
    const res = await send(app, "GET", "/v1/spaces/narrow-space/posts?kind=question", reader, undefined, { accept: "application/x-ndjson" });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 4, "three questions and a trailer");
    const trailer = lines[3];
    assert.equal(trailer.cursor.next_after, "3");
    assert.equal(trailer.cursor.head_seq, "4");
    assert.equal(trailer.cursor.has_more, false, "the head counts the dossier, which this export leaves out");
  });

  test("a mailbox read of one kind says there is more only when it may be", async () => {
    const all = await call("GET", "/v1/mailbox?kind=question", reader);
    assert.equal(all.body.items.length, 3);
    assert.equal(all.body.head_seq, "4");
    assert.equal(all.body.has_more, false, "the last question said there was more");
    const full = await call("GET", "/v1/mailbox?kind=question&limit=2", reader);
    assert.equal(full.body.has_more, true, "a full page may have more");
    const cut = await call("GET", "/v1/mailbox?kind=question&token_budget=1", reader);
    assert.equal(cut.body.items.length, 1);
    assert.equal(cut.body.has_more, true, "a page the budget cut short has more");
  });

  test("an empty kind list is no filter: the stream, SEEK, the mailbox and what stands read everything", async () => {
    for (const kind of ["", ","]) {
      const page = await call("GET", `/v1/spaces/narrow-space/posts?kind=${kind}&limit=4`, reader);
      assert.deepEqual(page.body.items.map((p: any) => p.seq), ["1", "2", "3", "4"], `kind=${kind}`);
      assert.equal(page.body.has_more, false, `kind=${kind}: the whole SPACE said there was more`);

      const found = await call("GET", `/v1/seek?q=question&kind=${kind}`, reader);
      assert.equal(found.body.items.length, 3, `kind=${kind}: SEEK found nothing`);

      const mail = await call("GET", `/v1/mailbox?kind=${kind}`, reader);
      assert.equal(mail.body.items.length, 4, `kind=${kind}: the mailbox answered nothing`);
      assert.equal(mail.body.next_after, "4");

      const standing = await call("GET", `/v1/spaces/narrow-space/standing?kind=${kind}`, reader);
      assert.deepEqual(standing.body.items.map((p: any) => p.seq), ["4", "3", "2", "1"], `kind=${kind}: what stands`);
    }
  });
});

describe("one post, read by id, names what corrected it", () => {
  test("superseded_by and retracted_by list the posts that replace and withdraw it", async () => {
    const owner = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "corrected-space", title: "Corrected" })).status, 201);
    const write = async (fields: Record<string, unknown>) => {
      const out = await call("POST", "/v1/spaces/corrected-space/posts", owner, { kind: "obs", ...fields });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      return out.body.post_id as string;
    };
    const replaced = await write({ body: "The first take." });
    const replacement = await write({ body: "The second take.", supersedes: replaced });
    const wrong = await write({ body: "A wrong turn." });
    const withdrawal = await write({ body: "Withdrawn.", retracts: wrong });

    const first = (await call("GET", `/v1/posts/${replaced}`, owner)).body;
    assert.deepEqual(first.superseded_by, [replacement]);
    assert.deepEqual(first.retracted_by, []);
    const second = (await call("GET", `/v1/posts/${wrong}`, owner)).body;
    assert.deepEqual(second.superseded_by, []);
    assert.deepEqual(second.retracted_by, [withdrawal]);
  });
});
