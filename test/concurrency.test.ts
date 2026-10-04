// The claim this file tests is the one the whole read design rests on: within a
// SPACE, sequence numbers are gap-free in commit order, so a reader's plain
// after=<seq> cursor can never skip a post. Same for a mailbox.
//
// It is worth testing under real concurrency rather than in sequence, because
// the mechanism is a row lock: the space row is taken FOR NO KEY UPDATE before
// the counter moves, so the next writer cannot take it until the previous
// commit is visible. If that were wrong, a gap would appear only under load.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { charge } from "../src/http/ratelimit.ts";
import type { Db } from "../src/db/sql.ts";

let fixture: Fixture;

const SPACES = 5;
const AUTHORS = 5;
const POSTS_PER_AUTHOR = 10; // 5 authors x 10 = 50 concurrent appends

const authors = Array.from({ length: AUTHORS }, (_, i) => publicKey(`conc-author-${i}`));
const authorIds = authors.map((k) => Buffer.from(peerIdOf(k), "hex"));
const spaceNames = Array.from({ length: SPACES }, (_, i) => `conc-space-${i}`);

const opened = setUp(async () => {
  fixture = await cloneDatabase("concurrency");
  for (const k of authors) await fixture.owner`select schellingaf.register_peer(${k})`;
  for (const name of spaceNames) {
    await fixture.owner`select schellingaf.create_space(${authorIds[0]!}, ${name}, 'Concurrency')`;
    for (const id of authorIds.slice(1)) {
      await fixture.owner`select schellingaf.grant_membership(${name}, ${authorIds[0]!}, ${id}, 'writer', null)`;
    }
  }
});

after(async () => {
  await opened;
  await fixture.end();
});

test("fifty concurrent appends leave no gap in any space or any mailbox", async () => {
  const work: Promise<unknown>[] = [];

  for (let a = 0; a < AUTHORS; a++) {
    for (let n = 0; n < POSTS_PER_AUTHOR; n++) {
      const space = spaceNames[(a + n) % SPACES]!;
      const author = authorIds[a]!;
      // Every post is addressed to two other authors, so the mailbox counters
      // contend as hard as the space counters do. Recipients are locked in
      // ascending peer id inside the function, which is what keeps fifty
      // writers from deadlocking against each other.
      const recipients = [authorIds[(a + 1) % AUTHORS]!, authorIds[(a + 2) % AUTHORS]!];
      work.push(
        fixture.owner`
          select schellingaf.append_post(${space}, ${author}, 'obs', null,
            ${`post ${a}-${n}`}, null, null, ${fixture.owner.array(recipients)}::bytea[],
            null, null, null, null, null, null)`,
      );
    }
  }

  const results = await Promise.allSettled(work);
  const failures = results.filter((r) => r.status === "rejected");
  assert.deepEqual(
    failures.map((f) => (f as PromiseRejectedResult).reason?.message),
    [],
    "no append should fail, and in particular none should deadlock",
  );

  // Per space: the sequence numbers are exactly 1..count, and the counter on the
  // space row agrees with them.
  for (const name of spaceNames) {
    const [row] = await fixture.owner<
      { total: number; distinct_seq: number; max_seq: string; head: string }[]
    >`
      select count(*)::int as total,
             count(distinct p.seq)::int as distinct_seq,
             max(p.seq)::text as max_seq,
             s.last_seq::text as head
        from schellingaf.spaces s
        join schellingaf.posts p on p.space_id = s.space_id
       where s.name = ${name}
       group by s.last_seq`;
    assert.ok(row, `${name} should have posts`);
    assert.equal(row.distinct_seq, row.total, `${name} reused a sequence number`);
    assert.equal(Number(row.max_seq), row.total, `${name} has a gap in its sequence`);
    assert.equal(row.head, row.max_seq, `${name}'s counter disagrees with its posts`);
  }

  const [totals] = await fixture.owner<{ n: number }[]>`
    select count(*)::int as n from schellingaf.posts`;
  assert.equal(totals?.n, AUTHORS * POSTS_PER_AUTHOR);

  // Per mailbox: same property, and every delivery is distinct.
  for (const id of authorIds) {
    const [row] = await fixture.owner<
      { total: number; distinct_seq: number; max_seq: string; head: string }[]
    >`
      select count(*)::int as total,
             count(distinct d.mailbox_seq)::int as distinct_seq,
             coalesce(max(d.mailbox_seq), 0)::text as max_seq,
             mb.last_seq::text as head
        from schellingaf.mailboxes mb
        left join schellingaf.mailbox_deliveries d on d.recipient_id = mb.peer_id
       where mb.peer_id = ${id}
       group by mb.last_seq`;
    assert.ok(row, "every author should have a mailbox");
    assert.equal(row.distinct_seq, row.total, "a mailbox reused a sequence number");
    assert.equal(Number(row.max_seq), row.total, "a mailbox has a gap");
    assert.equal(row.head, row.max_seq, "a mailbox counter disagrees with its deliveries");
  }
});

describe("a rate limit cannot be multiplied by asking in parallel", () => {
  // take_tokens locks the bucket before it reads the balance: two calls that both
  // read the same balance would both write the same debited value, and with N
  // requests in flight N-1 debits would be lost. Every limit the service has
  // runs through this one function, including the redemption bucket where
  // failures count because guessing is the attack.
  test("fifty parallel takes from a bucket of ten allow exactly ten", async () => {
    const key = `test:parallel:${Date.now()}`;
    const takes = await Promise.all(
      Array.from({ length: 50 }, () =>
        fixture.owner<{ r: { allowed: boolean } }[]>`
          select schellingaf.take_tokens(${key}, 10::float8, 0::float8, 1::float8) as r`),
    );
    const allowed = takes.filter((t) => t[0]!.r.allowed).length;
    assert.equal(allowed, 10, `a bucket of ten allowed ${allowed} parallel takes`);

    const [row] = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${key}`;
    assert.equal(Number(row!.tokens), 0, "the bucket did not end empty");
  });

  test("a refusal neither debits nor restarts the refill clock", async () => {
    // A bucket that moved its timestamp on every refusal would never refill for
    // a caller that keeps trying, which punishes the agent backing off correctly.
    const key = `test:refusal:${Date.now()}`;
    await fixture.owner`select schellingaf.take_tokens(${key}, 1::float8, 0.01::float8, 1::float8)`;
    const [before] = await fixture.owner<{ tokens: number; updated_at: Date }[]>`
      select tokens, updated_at from schellingaf.rate_buckets where key = ${key}`;

    for (let i = 0; i < 5; i++) {
      const [out] = await fixture.owner<{ r: { allowed: boolean } }[]>`
        select schellingaf.take_tokens(${key}, 1::float8, 0.01::float8, 1::float8) as r`;
      assert.equal(out!.r.allowed, false, "an empty bucket allowed a take");
    }

    const [after] = await fixture.owner<{ tokens: number; updated_at: Date }[]>`
      select tokens, updated_at from schellingaf.rate_buckets where key = ${key}`;
    assert.equal(Number(after!.tokens), Number(before!.tokens), "a refusal debited the bucket");
    assert.equal(
      after!.updated_at.getTime(),
      before!.updated_at.getTime(),
      "a refusal moved the refill clock, so the bucket would never refill",
    );
  });

  // The four SHARED buckets are not spent through take_tokens at all. They are
  // read without a debit before the write — an outsider must not be able to
  // drain a peer's allowance by addressing a post it may not send — and
  // debited after the write function has decided the caller had the authority.
  // A debit that arrives after the fact cannot refuse, so it must not be a
  // take: take_tokens declines to debit an empty bucket, and every delivery
  // past the moment the bucket ran dry was therefore free.
  test("a charge that overruns a bucket leaves it owing, not empty", async () => {
    const key = `test:charge:${Date.now()}`;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fixture.owner`select schellingaf.charge_tokens(${key}, 5::float8, 0::float8, 1::float8)`),
    );
    const [row] = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = ${key}`;
    // Twenty charges against a bucket of five overrun it by fifteen. It owes, and
    // it owes one full allowance, not fifteen: charge_tokens bounds the debt,
    // because these buckets belong to somebody other than the spender and a
    // deficit there is time that recipient or that SPACE is shut out.
    assert.equal(
      Number(row!.tokens),
      -5,
      `twenty charges against a bucket of five left it at ${row!.tokens}: either forgiven, or owed without a bound`,
    );

    // And the deficit is what the next caller meets, rather than a bucket that
    // floored at zero and refilled from there as though the burst never was.
    const [out] = await fixture.owner<{ r: { allowed: boolean } }[]>`
      select schellingaf.take_tokens(${key}, 5::float8, 0::float8, 1::float8) as r`;
    assert.equal(out!.r.allowed, false, "a bucket that was overdrawn allowed the next take");

    // And a single charge bigger than the whole bucket starts it at the floor too.
    const big = `test:big:${Date.now()}`;
    await fixture.owner`select schellingaf.charge_tokens(${big}, 3::float8, 0::float8, 50::float8)`;
    const [first] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${big}`;
    assert.equal(Number(first!.tokens), -3);
  });

  test("a post's buckets are charged in one call, each once, by callers naming them in any order", async () => {
    // The api charges every bucket a post spent in one call (charge_tokens_each), which
    // holds each until it commits. Taken in key order, twenty callers naming the same
    // ten buckets forwards and backwards queue behind one another; taken in the order
    // given, two of them could each hold what the other waits for. Through charge() and
    // the service's own role, as a post charges them.
    const keys = Array.from({ length: 10 }, (_, i) => `test:many:${Date.now()}:${i}`);
    const buckets = keys.map((key) => ({ key, capacity: 100, refillPerSec: 0, own: false }));
    const service = { write: fixture.api } as unknown as Db;
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => charge(service, n % 2 === 0 ? buckets : [...buckets].reverse())),
    );
    const rows = await fixture.owner<{ tokens: number }[]>`
      select tokens from schellingaf.rate_buckets where key = any(${keys}::text[])`;
    assert.equal(rows.length, 10);
    assert.deepEqual(rows.map((r) => Number(r.tokens)), keys.map(() => 80), "a bucket was charged other than once per call");
  });
});
