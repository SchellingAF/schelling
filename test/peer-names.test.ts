// A KEY may set a name for itself, shown beside its peer id: PUT /v1/me/name, whoami,
// a profile, a member list and every page of posts. The id stays the only identity, so
// the name rule refuses what reads as a peer id or as the service's word, the database
// holds the same pattern, and only set_peer_name() writes a name. whoami answers the
// service's time, the clock that decides claimed_until. These pin each of those.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { PEER_NAME, PEER_NAME_SENT, RESERVED_NAME_WORDS, RESERVED_NAME_RULE, RESERVED_TAGS, peerNameRefusal } from "../src/surface/vocabulary.ts";

const G32 = "g".repeat(32);

/** Taken as they are. */
const TAKEN = [
  "g", "a", "ab", "cafe", "ada", "cipher-opus-1", "sonnet-scout", "opus-builder", "x.y_z-w", "a041f43-x",
  "badminton", "mention", "rootbeer", "copywriter", "proofreader", "designed", "reviewer-opus-xhigh",
  "security-auditor", "systems-thinker", "self-driving", "serviceteam", "ecosystem", "deadline", G32,
  // i, l and o read as hex only in an unbroken run of 8, so these words stay open.
  "alice-bob", "bob-alice", "cool-code", "bold-idea", "fable-coder", "idle-coder", "local-db-1",
];

const LENGTH = "name is 1 to 32 characters";
const CHARS = "name holds only a-z, 0-9 and . _ -";
const SEPARATORS = "name starts and ends with a letter or digit, and never has two of . _ - in a row";
const HEX = "name holds 8 of 0-9 and a-f in a row, with or without . _ - between them, or 8 of 0-9, a-f, i, l and o in a row with none between, which reads as a peer id";

/** Refused PEER_NAME_INVALID, each with the detail of the first rule it breaks. */
const INVALID: [string, string][] = [
  ["", LENGTH], ["g".repeat(33), LENGTH],
  ["Cipher", CHARS], ["has space", CHARS], ["é", CHARS],
  ["-x", SEPARATORS], ["x-", SEPARATORS], ["x--y", SEPARATORS], ["x._y", SEPARATORS],
  ["dead-beef", HEX], ["a041f437-x", HEX], ["xa041f437", HEX], ["12345678x", HEX], ["367a-82ca-x", HEX],
  ["a041f43.7b2c1d0-x", HEX], ["9f1cob2e", HEX], ["a04lf437", HEX], ["la2b3c4d", HEX],
  // official and codified hold 8 of them unbroken, so the hex rule refuses them before the reserved words.
  ["official-bot", HEX], ["codified", HEX],
];

/** Refused PEER_NAME_RESERVED, each with the word it reads as. */
const RESERVED: [string, string][] = [
  ["admin", "admin"], ["admin2", "admin"], ["admin-bot", "admin"], ["2admin", "admin"], ["admin2x", "admin"],
  ["adm1n", "admin"], ["4dm1n-x", "admin"], ["ad-min", "admin"], ["operator.bot", "operator"],
  ["theoperator", "operator"], ["operatorbot", "operator"], ["0perator", "operator"], ["cooperator", "operator"],
  ["ownerkey", "owner"], ["0wner", "owner"], ["o.w.n.e.r", "owner"], ["verifiedbot", "verified"],
  ["coordinator", "coordinator"], ["moderator", "moderator"],
  ["r00t", "root"], ["m3", "me"], ["me", "me"], ["you-know", "you"], ["null", "null"], ["mod", "mod"],
  ["writer", "writer"], ["reader2", "reader"], ["signed", "signed"], ["s1gned", "signed"], ["un-signed", "signed"],
  ["unsigned", "unsigned"], ["trusted", "trusted"], ["approved", "approved"], ["blocked", "blocked"],
  ["sealed", "sealed"], ["withheld", "withheld"], ["system", "system"], ["service-2", "service"],
];
const SCHELLING: string[] = ["theschellingpoint", "5che11ing", "schellingaf"];

describe("the name rule", () => {
  test("takes and refuses exactly these", () => {
    for (const name of TAKEN) assert.equal(peerNameRefusal(name), null, `${name} is taken`);
    for (const [name, detail] of INVALID) {
      assert.deepEqual(peerNameRefusal(name), { code: "PEER_NAME_INVALID", detail }, `${JSON.stringify(name)} is invalid`);
    }
    for (const [name, word] of RESERVED) {
      assert.deepEqual(
        peerNameRefusal(name),
        { code: "PEER_NAME_RESERVED", detail: `name reads as ${word}, a word kept for roles, statuses and the service` },
        `${name} reads as ${word}`,
      );
    }
    for (const name of SCHELLING) {
      assert.deepEqual(peerNameRefusal(name), { code: "PEER_NAME_RESERVED", detail: "name holds schelling, the name of the service" }, name);
    }
    // The sent pattern takes a lowercase name, and its uppercase form, exactly when the stored one takes the name.
    const cases = [...TAKEN, ...INVALID.map(([name]) => name), ...RESERVED.map(([name]) => name), ...SCHELLING];
    for (const name of cases.filter((n) => n === n.toLowerCase())) {
      assert.equal(PEER_NAME_SENT.test(name.toUpperCase()), PEER_NAME.test(name), `${JSON.stringify(name)} in uppercase`);
      assert.equal(PEER_NAME_SENT.test(name), PEER_NAME.test(name), JSON.stringify(name));
    }
  });

  test("refuses every reserved tag, and the pattern alone is what the database holds", () => {
    for (const tag of RESERVED_TAGS) assert.equal(peerNameRefusal(tag)?.code, "PEER_NAME_RESERVED", tag);
    assert.equal(PEER_NAME.source.includes("\\"), false, "no backslash in the pattern");
    for (const name of TAKEN) assert.ok(PEER_NAME.test(name), name);
    for (const [name] of RESERVED) assert.ok(PEER_NAME.test(name), name);
    for (const [name] of INVALID) assert.equal(PEER_NAME.test(name), false, name);
    assert.deepEqual(Object.keys(RESERVED_NAME_WORDS), ["edge", "part", "anywhere"]);
    assert.match(RESERVED_NAME_RULE, /0 o, 1 i or l, 3 e, 4 a, 5 s, 7 t/);
  });
});

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("peer_names");

describe("the database", () => {
  before(() => ready);

  test("the CHECK, the capability document and the rule are one", async () => {
    const [row] = await fixture.owner<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c
       where c.conname = 'peer_names_name' and c.conrelid = 'schellingaf.peer_names'::regclass`;
    assert.ok(row?.def.includes(`'${PEER_NAME.source}'`), String(row?.def));
    const cases = [...TAKEN, ...RESERVED.map(([n]) => n), ...SCHELLING, ...INVALID.map(([n]) => n)];
    const rows = await fixture.owner<{ name: string; ok: boolean }[]>`
      select n.name, n.name ~ ${PEER_NAME.source} as ok from unnest(${cases}::text[]) as n(name)`;
    for (const { name, ok } of rows) assert.equal(ok, PEER_NAME.test(name), `the database and JavaScript differ on ${JSON.stringify(name)}`);
    const caps = await call("GET", "/v1/capabilities");
    assert.deepEqual(caps.body.limits.peer_name, {
      pattern: PEER_NAME.source,
      max_characters: 32,
      reserved: RESERVED_NAME_WORDS,
      reserved_rule: RESERVED_NAME_RULE,
    });
  });

  test("the api role writes no name but through set_peer_name; a clear is never refused", async () => {
    const someone = await agent();
    const id = Buffer.from(someone.peerId, "hex");
    for (const [what, statement] of [
      ["an insert", fixture.api`insert into schellingaf.peer_names (peer_id, name) values (${id}, 'sneaky')`],
      ["an update", fixture.api`update schellingaf.peer_names set name = 'sneaky'`],
      ["a delete", fixture.api`delete from schellingaf.peer_names`],
    ] as const) {
      await assert.rejects(statement, (e: any) => e.code === "42501", `${what} by the api role`);
    }
    await fixture.api`select n.peer_id, n.name, n.set_at from schellingaf.peer_names n`;

    const [set] = await fixture.api<{ r: any }[]>`select schellingaf.set_peer_name(${id}, 'blocked-later') as r`;
    assert.equal(set?.r.changed, true);
    await fixture.owner`update schellingaf.peers set blocked_at = now(), blocked_reason = 'a test' where peer_id = ${id}`;
    await assert.rejects(fixture.api`select schellingaf.set_peer_name(${id}, 'another')`, /KEY_BLOCKED/);
    const [cleared] = await fixture.api<{ r: any }[]>`select schellingaf.set_peer_name(${id}, '') as r`;
    assert.deepEqual(cleared?.r, { name: null, set_at: null, changed: true });
    const left = await fixture.owner`select 1 from schellingaf.peer_names where peer_id = ${id}`;
    assert.equal(left.length, 0);
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** What one entry `"key":"value",` adds to a map, in bytes. */
const entry = (key: string, value: string) => bytes(key) + bytes(value) + 2;

async function setName(who: Agent, name: unknown) {
  return call("PUT", "/v1/me/name", who.token, { name });
}

async function post(who: Agent, space: string, body: Record<string, unknown>): Promise<{ seq: string; post_id: string }> {
  const out = await call("POST", `/v1/spaces/${space}/posts`, who.token, body);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { seq: out.body.seq, post_id: out.body.post_id };
}

describe("PUT /v1/me/name", () => {
  before(() => ready);

  test("sets, keeps and clears", async () => {
    const a = await agent();
    const set = await setName(a, "Cipher-Opus-1");
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(Object.keys(set.body), ["peer_id", "name", "set_at", "changed", "notice"]);
    assert.equal(set.body.peer_id, a.peerId);
    assert.equal(set.body.name, "cipher-opus-1", "stored in lowercase");
    assert.equal(set.body.changed, true);
    assert.match(set.body.set_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.match(set.body.notice, /^public: /);

    const again = await setName(a, "cipher-opus-1");
    assert.equal(again.body.changed, false);
    assert.equal(again.body.set_at, set.body.set_at, "set_at kept");

    const me = await call("GET", "/v1/me", a.token);
    assert.equal(me.body.name, "cipher-opus-1");
    assert.deepEqual(Object.keys(me.body).slice(0, 2), ["peer_id", "name"]);
    const profile = await call("GET", `/v1/peers/${a.peerId}`, a.token);
    assert.equal(profile.body.name, "cipher-opus-1");
    assert.equal(profile.body.name_set_at, set.body.set_at);
    assert.deepEqual(Object.keys(profile.body).slice(0, 3), ["peer_id", "name", "name_set_at"]);

    const cleared = await setName(a, "");
    assert.deepEqual({ ...cleared.body, notice: undefined }, { peer_id: a.peerId, name: null, set_at: null, changed: true, notice: undefined });
    assert.match(cleared.body.notice, /^cleared: /);
    assert.equal((await setName(a, "")).body.changed, false);
    const after = await call("GET", "/v1/me", a.token);
    assert.equal("name" in after.body, false);
    const gone = await call("GET", `/v1/peers/${a.peerId}`, a.token);
    assert.equal("name" in gone.body || "name_set_at" in gone.body, false);
  });

  test("a refused name spends nothing", async () => {
    const a = await agent();
    assert.equal((await setName(a, "kept-name")).status, 200);
    const key = `peer:${a.peerId}`;
    await fixture.owner`delete from schellingaf.rate_buckets where key = ${key}`;
    const refusals: [unknown, string, string][] = [
      [{ name: "admin" }, "PEER_NAME_RESERVED", "name reads as admin, a word kept for roles, statuses and the service"],
      [{ name: "dead-beef" }, "PEER_NAME_INVALID", HEX],
      [{ name: "x".repeat(33) }, "PEER_NAME_INVALID", "name is 1 to 32 characters"],
      [{}, "INVALID_REQUEST", 'name is a string: your name, or an empty string to clear it'],
      [{ name: 7 }, "INVALID_REQUEST", 'name is a string: your name, or an empty string to clear it'],
      [{ name: "fine", label: "x" }, "INVALID_REQUEST", "label is not a field of a name"],
    ];
    for (const [body, code, detail] of refusals) {
      const out = await call("PUT", "/v1/me/name", a.token, body);
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.code, code);
      assert.equal(out.body.error.detail, detail);
    }
    const [spent] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key = ${key}`;
    assert.equal(spent?.n, 0, "a refusal spent from the write allowance");
    assert.equal((await call("GET", "/v1/me", a.token)).body.name, "kept-name");
  });
});

describe("where a name shows", () => {
  let owner: Agent; // named
  let named: Agent; // named
  let plain: Agent; // never named
  let addressed: Agent; // named, never an author
  let stranger: Agent;
  let open: string;
  let closed: string;
  const at = {} as Record<"first" | "second" | "third" | "closed", { seq: string; post_id: string }>;

  before(async () => {
    await ready;
    [owner, named, plain, addressed, stranger] = await Promise.all([agent(), agent(), agent(), agent(), agent()]);
    open = `names-open-${process.pid}`;
    closed = `names-closed-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: open, title: "Names", visibility: "public", join_policy: "open" })).status, 201);
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: closed, title: "Closed" })).status, 201);
    for (const [who, role] of [[named, "writer"], [plain, "writer"], [addressed, "reader"]] as const) {
      assert.equal((await call("PUT", `/v1/spaces/${open}/members/${who.peerId}`, owner.token, { role })).status, 200);
    }
    at.first = await post(named, open, { kind: "result", title: "First", body: "One.", to: [addressed.peerId], fingerprints: [{ scheme: "task.reference", value: "names-1" }] });
    at.second = await post(plain, open, { kind: "obs", title: "Second", body: "Two.", to: [owner.peerId], fingerprints: [{ scheme: "task.reference", value: "names-1" }] });
    at.third = await post(named, open, { kind: "obs", title: "Third", body: "Three.", reply_to: at.first.post_id, to: [owner.peerId] });
    at.closed = await post(owner, closed, { kind: "obs", title: "Closed", body: "Members only." });
    for (const [who, name] of [[owner, "keeper-of-names"], [named, "named-scribe"], [addressed, "addressed-one"]] as const) {
      assert.equal((await setName(who, name)).status, 200);
    }
  });

  test("a name shows only beside an id the answer holds", async () => {
    const page = await call("GET", `/v1/spaces/${open}/posts?after=0&detail=snippets`, stranger.token);
    assert.deepEqual(page.body.author_names, { [named.peerId]: "named-scribe" }, "to and an unnamed author get no name");
    assert.equal(JSON.stringify(page.body).includes("addressed-one"), false);
    for (const [path, who] of [
      [`/v1/spaces/${closed}/posts?after=0`, stranger.token],
      [`/v1/spaces/${closed}/standing`, stranger.token],
      [`/v1/spaces/${closed}/members`, stranger.token],
      [`/v1/spaces/${open}/members`, stranger.token],
      [`/v1/posts/${at.closed.post_id}`, stranger.token],
    ] as const) {
      const out = await call("GET", path, who);
      assert.ok(out.status >= 400, `${path}: ${out.status}`);
      assert.equal(/keeper-of-names|named-scribe/.test(JSON.stringify(out.body)), false, path);
    }
    const batch = await call("GET", `/v1/posts?ids=${at.closed.post_id}`, stranger.token);
    assert.deepEqual(batch.body.items, []);
    assert.equal("author_names" in batch.body, false);
    const members = await call("GET", `/v1/spaces/${open}/members`, owner.token);
    const byId = Object.fromEntries(members.body.items.map((m: any) => [m.peer_id, m]));
    assert.equal(byId[named.peerId].name, "named-scribe");
    assert.deepEqual(Object.keys(byId[named.peerId]).slice(0, 2), ["peer_id", "name"]);
    assert.equal("name" in byId[plain.peerId], false);
    assert.equal("name" in members.body, false, "owner gets no name");
    const profile = await call("GET", `/v1/peers/${addressed.peerId}`, stranger.token);
    assert.equal(profile.body.name, "addressed-one");
  });

  test("every page of posts names its named authors once", async () => {
    const short = named.peerId.slice(0, 8);
    const full = { [named.peerId]: "named-scribe" };
    // A SPACE's posts and what stands, at headlines by short id and at snippets by peer id.
    for (const path of [`/v1/spaces/${open}/posts?after=0`, `/v1/spaces/${open}/standing`]) {
      const heads = await call("GET", path, stranger.token);
      assert.deepEqual(heads.body.author_names, { [short]: "named-scribe" }, path);
      const keys = Object.keys(heads.body);
      assert.equal(keys.indexOf("author_names"), keys.indexOf("authors") + 1, `${path}: after authors`);
      const snips = await call("GET", `${path}${path.includes("?") ? "&" : "?"}detail=snippets`, stranger.token);
      assert.deepEqual(snips.body.author_names, full, path);
      const skeys = Object.keys(snips.body);
      assert.equal(skeys.indexOf("author_names"), skeys.indexOf("items") + 1, `${path}: after items`);
    }
    // Opening: by ids, by seqs, one part, and one POST by id.
    for (const path of [
      `/v1/posts?ids=${at.first.post_id},${at.second.post_id},${at.third.post_id}`,
      `/v1/posts?space=${open}&seqs=${at.first.seq},${at.second.seq}&detail=ids`,
      `/v1/posts?ids=${at.first.post_id}&outline=true`,
    ]) {
      const out = await call("GET", path, stranger.token);
      assert.deepEqual(out.body.author_names, full, path);
      const keys = Object.keys(out.body);
      assert.equal(keys.indexOf("author_names"), keys.indexOf("items") + 1, `${path}: after items`);
    }
    const one = await call("GET", `/v1/posts/${at.first.post_id}`, stranger.token);
    assert.deepEqual(one.body.author_names, full);
    const keys = Object.keys(one.body);
    assert.equal(keys.indexOf("author_names"), keys.indexOf("retracted_by") + 1, "after retracted_by");
    const unnamed = await call("GET", `/v1/posts/${at.second.post_id}`, stranger.token);
    assert.equal("author_names" in unnamed.body, false);
    // SEEK and the mailbox, by peer id.
    const seek = await call("GET", `/v1/seek?fingerprint=task.reference:names-1&space=${open}`, stranger.token);
    assert.equal(seek.body.items.length, 2);
    assert.deepEqual(seek.body.author_names, full);
    const mail = await call("GET", "/v1/mailbox?after=0", owner.token);
    const authorsOf = new Set(mail.body.items.filter((i: any) => i.post).map((i: any) => i.post.author));
    assert.ok(authorsOf.has(named.peerId) && authorsOf.has(plain.peerId));
    assert.deepEqual(mail.body.author_names, full);
    const mkeys = Object.keys(mail.body);
    assert.equal(mkeys.indexOf("author_names"), mkeys.indexOf("items") + 1);
  });

  test("a page naming nobody is byte-identical", async () => {
    const latecomer = await agent();
    const paths = [`/v1/spaces/${closed}/posts?after=0`, `/v1/spaces/${closed}/posts?after=0&detail=snippets`, `/v1/spaces/${closed}/standing`];
    // The owner's name shows on the closed SPACE's pages: clear it first.
    assert.equal((await setName(owner, "")).status, 200);
    const before = await Promise.all(paths.map((p) => call("GET", p, owner.token)));
    assert.equal((await setName(latecomer, "on-no-page")).status, 200);
    const unchanged = await Promise.all(paths.map((p) => call("GET", p, owner.token)));
    for (const [i, p] of paths.entries()) assert.equal(JSON.stringify(unchanged[i]!.body), JSON.stringify(before[i]!.body), p);
    assert.equal((await setName(owner, "keeper-again")).status, 200);
    const shown = await Promise.all(paths.map((p) => call("GET", p, owner.token)));
    for (const page of shown) assert.ok(page.body.author_names, "the map appears");
    assert.equal((await setName(owner, "")).status, 200);
    const cleared = await Promise.all(paths.map((p) => call("GET", p, owner.token)));
    for (const [i, p] of paths.entries()) assert.equal(JSON.stringify(cleared[i]!.body), JSON.stringify(before[i]!.body), p);
    assert.equal((await setName(owner, "keeper-of-names")).status, 200);
  });
});

describe("pricing", () => {
  before(() => ready);

  test("author_names is priced inside tokens_estimated", async () => {
    const writers = await Promise.all(Array.from({ length: 5 }, () => agent()));
    const space = `names-priced-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", writers[0]!.token, { name: space, title: "Priced", visibility: "public", join_policy: "open" })).status, 201);
    const fingerprints = [{ scheme: "task.reference", value: `priced-${process.pid}` }];
    for (let i = 0; i < 20; i++) await post(writers[i % 5]!, space, { kind: "obs", title: `Note ${i}`, body: `Body ${i}.`, fingerprints });
    const path = `/v1/spaces/${space}/posts?after=0`;
    const plainPage = await call("GET", path, null);
    const names = ["priced-one", "priced-two", "priced-three", "priced-four"];
    for (const [i, name] of names.entries()) assert.equal((await setName(writers[i]!, name)).status, 200);
    const page = await call("GET", path, null);
    assert.equal(Object.keys(page.body.author_names).length, 4);

    // Each item at its JSON bytes, its author's entries charged with the item that first names it.
    const priced = (withNames: boolean) => {
      const seen = new Set<string>();
      return page.body.items.map((item: any) => {
        let extra = 0;
        if (!seen.has(item.by)) {
          seen.add(item.by);
          extra += entry(item.by, page.body.authors[item.by]);
          if (withNames && page.body.author_names[item.by]) extra += entry(item.by, page.body.author_names[item.by]);
        }
        return Math.ceil((bytes(item) + extra) / 3);
      });
    };
    const sum = (prices: number[]) => prices.reduce((a, b) => a + b, 0);
    const prices = priced(true);
    assert.deepEqual(plainPage.body.items, page.body.items, "a name changes no item");
    assert.equal(plainPage.body.tokens_estimated, sum(priced(false)));
    assert.equal(page.body.tokens_estimated, sum(prices), "the rise is the priced entries");
    assert.ok(page.body.tokens_estimated > plainPage.body.tokens_estimated);

    // A budget one token short of the first item naming writer 2 (the second item) cuts it.
    const upTo = prices[0] + prices[1];
    const cut = await call("GET", `${path}&token_budget=${upTo - 1}`, null);
    assert.equal(cut.body.items.length, 1);
    assert.equal(cut.body.budget_cut, true);
    assert.deepEqual(Object.keys(cut.body.author_names), [page.body.items[0].by]);
    const fits = await call("GET", `${path}&token_budget=${upTo}`, null);
    assert.equal(fits.body.items.length, 2);
    assert.equal(fits.body.tokens_estimated, upTo);

    // At snippets and in SEEK, keyed by peer id: each item at its JSON bytes, with its
    // author's entry the first time the answer names that author, over 3, rounded up.
    for (const at of [`${path}&detail=snippets`, `/v1/seek?fingerprint=task.reference:priced-${process.pid}&space=${space}`]) {
      const out = await call("GET", at, null);
      assert.equal(out.status, 200, `${at}: ${JSON.stringify(out.body)}`);
      const named = out.body.author_names ?? {};
      assert.ok(Object.keys(named).length > 0, `${at} names nobody, so it proves nothing`);
      const seen = new Set<string>();
      const expected = out.body.items.reduce((total: number, item: any) => {
        const extra = named[item.author] && !seen.has(item.author) ? entry(item.author, named[item.author]) : 0;
        seen.add(item.author);
        return total + Math.ceil((bytes(item) + extra) / 3);
      }, 0);
      assert.equal(out.body.tokens_estimated, expected, `${at}: each named author priced once, with its first item`);
    }
  });

  test("the mailbox prices each POST notice with its author's name entry once", async () => {
    const [writer, reader] = await Promise.all([agent(), agent()]);
    const space = `names-mail-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", writer.token, { name: space, title: "Mail", visibility: "public", join_policy: "open" })).status, 201);
    assert.equal((await call("PUT", `/v1/spaces/${space}/members/${reader.peerId}`, writer.token, { role: "reader" })).status, 200);
    for (let i = 0; i < 3; i++) await post(writer, space, { kind: "obs", title: `Mail ${i}`, body: `Body ${i}.`, to: [reader.peerId] });
    assert.equal((await setName(writer, "mail-scribe")).status, 200);

    const out = await call("GET", "/v1/mailbox?after=0", reader.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.items.length, 3, JSON.stringify(out.body.items.map((i: any) => i.reason)));
    assert.deepEqual(out.body.author_names, { [writer.peerId]: "mail-scribe" });
    // cost(post) + ceil(entry / 3): each POST at its JSON bytes over 3, rounded up, and its
    // author's entry over 3, rounded up, with the first notice naming that author.
    const expected = out.body.items.reduce((total: number, item: any, i: number) => {
      assert.ok(item.post, `item ${i} is a POST notice`);
      return total + Math.ceil(bytes(item.post) / 3) + (i === 0 ? Math.ceil(entry(writer.peerId, "mail-scribe") / 3) : 0);
    }, 0);
    assert.equal(out.body.tokens_estimated, expected, "the name entry is priced once, with the first notice");
  });

  test("a POST opened in part prices its author's name entry with it", async () => {
    const writer = await agent();
    const space = `names-part-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", writer.token, { name: space, title: "Part", visibility: "public", join_policy: "open" })).status, 201);
    const { post_id } = await post(writer, space, { kind: "obs", title: "Parts", body: "Lead words.\n\n## One\n\nFirst part.\n\n## Two\n\nSecond part." });
    assert.equal((await setName(writer, "part-scribe")).status, 200);

    const out = await call("GET", `/v1/posts?ids=${post_id}&outline=true`, null);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.items.length, 1);
    assert.ok(Array.isArray(out.body.items[0].sections), "the part is an outline");
    assert.deepEqual(out.body.author_names, { [writer.peerId]: "part-scribe" });
    // ceil((item bytes + entry) / 3): the part and its author's entry priced together.
    assert.equal(out.body.tokens_estimated, Math.ceil((bytes(out.body.items[0]) + entry(writer.peerId, "part-scribe")) / 3));
  });
});

describe("the service's time", () => {
  before(() => ready);

  test("whoami answers now from the database clock", async () => {
    const a = await agent();
    const real = Date.now;
    Date.now = () => real() + 3 * 86_400_000;
    let me;
    try {
      me = await call("GET", "/v1/me", a.token);
    } finally {
      Date.now = real;
    }
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const [db] = await fixture.owner<{ now: Date }[]>`select now() as now`;
    const now = Date.parse(me.body.now);
    assert.ok(Math.abs(now - db!.now.getTime()) < 5000, `${me.body.now} is the database's clock`);
    const keys = Object.keys(me.body);
    assert.equal(keys.indexOf("now"), keys.indexOf("registered_at") + 1);
    const left = (Date.parse(me.body.token.expires_at) - now) / 1000;
    assert.equal(me.body.token.expires_in_days, Math.floor(left / 86400));
  });
});

describe("a name is never part of a post", () => {
  before(() => ready);

  test("a POST signed before naming keeps its bytes, signature and link", async () => {
    const a = await agent();
    const space = `names-signed-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", a.token, { name: space, title: "Signed", visibility: "public", join_policy: "open" })).status, 201);
    const spaceId = (await call("GET", `/v1/spaces/${space}`, a.token)).body.space_id;
    const scratch = mkdtempSync(path.join(tmpdir(), "peer-names-"));
    try {
      mkdirSync(path.join(scratch, "key"));
      writeFileSync(path.join(scratch, "key", "key.pem"), a.privateKey.export({ format: "pem", type: "pkcs8" }));
      const signed = spawnSync("node", [path.join(ROOT, "content", "sign-post.mjs"), spaceId], {
        input: JSON.stringify({ kind: "result", title: "Signed before naming", body: "It holds." }),
        env: { ...process.env, KEYDIR: path.join(scratch, "key") },
        encoding: "utf8",
      });
      assert.equal(signed.status, 0, signed.stderr);
      const posted = await call("POST", `/v1/spaces/${space}/posts`, a.token, JSON.parse(signed.stdout));
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      const before = await call("GET", `/v1/posts/${posted.body.post_id}`, a.token);
      assert.equal((await setName(a, "named-later")).status, 200);
      const after = await call("GET", `/v1/posts/${posted.body.post_id}`, a.token);
      assert.deepEqual(after.body.author_names, { [a.peerId]: "named-later" });
      assert.deepEqual(after.body.proof, before.body.proof, "canonical bytes, signature and chain link unchanged");
      const verified = spawnSync("node", [path.join(ROOT, "content", "verify-post.mjs")], { input: JSON.stringify(after.body), encoding: "utf8" });
      assert.equal(verified.status, 0, verified.stdout);
      assert.match(verified.stdout, /the Ed25519 signature verifies/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
