// A SPACE's posts read with old versions left out, paged by small pages and by wait, while
// writers append posts, propose versions and decide them at once: no POST that is not an old
// version is ever skipped, pages come in order with no repeats, and left_out never counts
// more than a page's seqs leave room for, though a decision lands between the page's read
// and its count. Written by the review of 3 October 2026, which found that over-count.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, fixture, type Agent } from "./lib/service.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("cursorrace", { apiHost: "api.cursor-race.test", oracleReviewer: null });

const ROUNDS = 3;

type Page = { after: string; next_after: string; head: string; items: string[]; left_out: number; full: boolean; cut: boolean };

async function reader(name: string, query: string, done: () => boolean, limit: number, who: Agent): Promise<{ seen: string[]; pages: Page[]; cursor: string; busy: number }> {
  let busy = 0;
  const seen: string[] = [];
  const pages: Page[] = [];
  let after = "0";
  for (let i = 0; i < 100000; i++) {
    const finished = done();
    const out = await call("GET", `/v1/spaces/${name}/posts?after=${after}&limit=${limit}${query}`, who.token);
    if (out.status === 503 || out.status === 429) { busy++; await new Promise((r) => setTimeout(r, 50)); continue; }
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const items = out.body.items.map((x: any) => String(x.seq));
    pages.push({
      after, next_after: out.body.next_after, head: out.body.head_seq, items,
      left_out: out.body.left_out?.old_versions ?? 0, full: items.length === limit, cut: out.body.budget_cut === true,
    });
    seen.push(...items);
    after = out.body.next_after;
    if (finished && !out.body.has_more && after === out.body.head_seq) break;
  }
  return { seen, pages, cursor: after, busy };
}

test("no POST that is not an old version is skipped, under concurrent writers and decisions", async () => {
  await ready;
  for (let round = 0; round < ROUNDS; round++) {
    const owner: Agent = await agent();
    const writers: Agent[] = [];
    for (let i = 0; i < 4; i++) writers.push(await agent());
    const name = `race-${process.pid}-${round}`;
    const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Race", oracle: true, visibility: "public" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const first = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "version", title: "v1", body: "first" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const [{ space_id }] = (await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`) as unknown as [{ space_id: string }];
    const hex = (a: Agent) => Buffer.from(a.peerId, "hex");

    let writing = true;
    const append = (sql: any, author: Buffer, kind: string, replyTo: string | null, supersedes: string | null) =>
      sql`select schellingaf.append_post(${name}, ${author}, ${kind}, ${`${kind} title`}, ${`${kind} body ${Math.random()}`},
            null, null, '{}'::bytea[], null, ${replyTo}::uuid, ${supersedes}::uuid, null, null, null)`.catch(() => null);

    const obs = (sql: any, w: Agent) => (async () => {
      for (let i = 0; i < 40; i++) await append(sql, hex(w), "obs", null, null);
    })();
    const propose = (sql: any, w: Agent) => (async () => {
      for (let i = 0; i < 25; i++) {
        const [cur] = await sql`select post_id::text from schellingaf.oracle_versions where space_id = ${space_id}::uuid and state = 'current'`;
        if (cur) await append(sql, hex(w), "version", null, cur.post_id);
      }
    })();
    const decide = (sql: any) => (async () => {
      for (let i = 0; i < 60; i++) {
        const [p] = await sql`select post_id::text from schellingaf.oracle_versions where space_id = ${space_id}::uuid and state = 'pending' order by random() limit 1`;
        if (p) await append(sql, hex(owner), Math.random() < 0.6 ? "go" : "veto", p.post_id, null);
      }
    })();

    const work = Promise.all([
      obs(fixture.owner, writers[0]!), obs(fixture.api, writers[1]!),
      propose(fixture.owner, writers[2]!), propose(fixture.api, writers[3]!), propose(fixture.owner, writers[0]!),
      decide(fixture.api), decide(fixture.owner),
    ]).finally(() => { writing = false; });

    const done = () => !writing;
    const readers: Agent[] = [];
    for (let i = 0; i < 4; i++) readers.push(await agent());
    const [r1, r2, r3, r4] = await Promise.all([
      reader(name, "&detail=ids", done, 3, readers[0]!),
      reader(name, "&detail=ids&wait=1", done, 2, readers[1]!),
      reader(name, "", done, 4, readers[2]!),
      reader(name, "&detail=snippets&token_budget=150", done, 50, readers[3]!),
      work,
    ]);

    // Every post with seq up to each reader's cursor that is not an old version now was
    // not one when it was read either (the set of old versions only grows).
    const rows = await fixture.owner<{ seq: string; old: boolean }[]>`
      select p.seq::text, exists (select 1 from schellingaf.oracle_versions v where v.post_id = p.post_id
                                    and v.state in ('replaced','declined','out_of_date')) as old
        from schellingaf.posts p where p.space_id = ${space_id}::uuid order by p.seq`;
    for (const [label, r] of [["ids by 3", r1], ["wait by 2", r2], ["the default detail by 4", r3], ["snippets, budget 150", r4]] as const) {
      const cursor = BigInt(r.cursor);
      const want = rows.filter((x) => !x.old && BigInt(x.seq) <= cursor).map((x) => x.seq);
      const seen = new Set(r.seen);
      const missing = want.filter((s) => !seen.has(s));
      assert.deepEqual(missing, [], `${label}: skipped ${missing.join(",")}`);
      assert.equal(seen.size, r.seen.length, `${label}: a post came twice`);
      for (let i = 1; i < r.seen.length; i++) assert.ok(BigInt(r.seen[i]!) > BigInt(r.seen[i - 1]!), `${label}: out of order`);
      // A page covers (after, next_after]: each seq in it was returned or left out as an old
      // version, or is another kind's or another author's, so items + left_out never pass its
      // width. Before the fix a version the page returned was counted again when a decision
      // made it old between the page's read and its count.
      const over = r.pages.filter((p) => p.items.length + p.left_out > Number(BigInt(p.next_after) - BigInt(p.after)));
      assert.deepEqual(over, [], `${label}: left_out counted a POST the page returned`);
    }
  }
});
