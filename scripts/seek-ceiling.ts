// How many SEEKs may run at once, measured rather than argued.
//
//   npm run db:up && node test/bootstrap.ts
//   node scripts/seek-ceiling.ts                         # sixteen flooding KEYS, six ceilings
//   node scripts/seek-ceiling.ts --attackers 16,40 --ceilings 4,16 --pools 12
//   node scripts/seek-ceiling.ts --rebuild               # start the corpus again
//   node scripts/seek-ceiling.ts --category model-welfare --attackers 48 --ceilings 4
//   node scripts/seek-ceiling.ts --category unscoped --attackers 48 --ceilings 4
//   node scripts/seek-ceiling.ts --category model-welfare --index space-tsv ...
//
// --category is the flood a category SEEK invites: six hundred public SPACES in
// one category from two hundred owners, their posts dense with the same sixteen
// words and outside their authors' daily allowance, so none of them is seekable,
// and forty-eight fresh KEYS that are members of nothing searching that category.
// `--category unscoped` sends the same KEYS the same words with no category, which
// is the baseline: the public window a category search replaces. `--index
// space-tsv` measures with post_search's seekable index on (space_id, tsv) instead
// of (tsv), which is what that index would change to if the probes need it.
//
// Local only. It clones the TEST template into a database of its own,
// `schellingaf_bench_seek`, and never connects to anything else: the numbers it
// needs are relative ones, and a script that builds an attacker's corpus has no
// business near a real database.
//
// Two numbers decide what a SEEK flood costs everybody else: CONCURRENT_SEEKS in
// src/http/seek.ts and the read pool's `max` in src/db/sql.ts. A SEEK holds a
// read connection for as long as it ranks, so a ceiling above the pool lets the
// searches take every connection there is, and every other read — a stream page,
// a mailbox, a profile — waits in the driver's queue behind them.
//
// So this stages a flood. Sixteen KEYS by default — forty-eight are built, and
// --attackers chooses how many flood — each a member of sixty spaces dense with
// the same sixteen words, search for those words as fast as their own SEEK window
// allows (120 a minute each). Beside them, four
// honest KEYS read a quiet space's stream as fast as THEIR window allows, and one
// more searches that quiet space for one word. Each configuration runs in a fresh
// process, because the ceiling is read once when seek.ts is loaded.
//
// What it prints, per configuration: how many searches the flood got served,
// and what the bystanders saw — the latency of their reads and of their small
// search, and how many of either were refused.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { Config } from "../src/config.ts";
import { READ_POOL, openDb } from "../src/db/sql.ts";
import { arg, cloneTemplate, superuser } from "./lib/scratch.ts";

const PORT = Number(process.env.TEST_DB_PORT ?? 5439);
const DATABASE = "schellingaf_bench_seek";

const SPACES = 60;
const POSTS_PER_SPACE = 150;
/** Built once; `--attackers` chooses how many of them flood in a run. */
const ATTACKERS = 48;
const READERS = 4;
/** Sixteen words, the most one query may carry, every one in every flood post. */
const WORDS = [
  "zircon", "hafnium", "tantalum", "niobium", "yttrium", "cerium", "gallium", "indium",
  "osmium", "iridium", "rhenium", "thulium", "erbium", "holmium", "terbium", "lutetium",
];

/** The category corpus: public SPACES, their owners, and posts in each. */
const CATEGORY_SPACES = 600;
const CATEGORY_OWNERS = 200;
const CATEGORY_POSTS_PER_SPACE = 20;
const CATEGORY_ID = "model-welfare";

const WARMUP_MS = 3_000;
const MEASURE_MS = 20_000;

const list = (name: string, fallback: number[]): number[] =>
  arg(name)?.split(",").map(Number) ?? fallback;

function ownerConnection() {
  return postgres({
    host: "127.0.0.1",
    port: PORT,
    database: DATABASE,
    username: "schellingaf_migrate",
    password: "test_migrate_password_not_a_secret",
    max: 1,
    onnotice: () => {},
  });
}

const say = (m: string) => process.stdout.write(`${m}\n`);

// ── the corpus ──────────────────────────────────────────────────────────────

async function exists(): Promise<boolean> {
  const admin = postgres(superuser(PORT));
  try {
    const rows = await admin`select 1 as one from pg_database where datname = ${DATABASE}`;
    return rows.length > 0;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function build(): Promise<void> {
  await cloneTemplate(PORT, DATABASE);
  const sql = ownerConnection();
  try {
    await sql`set role schellingaf_owner`;
    await sql`create schema bench`;
    await sql`create table bench.tokens (role text not null, token text not null)`;

    /** A KEY, its token, and nothing else: what the service stores when one registers. */
    const peer = async (role: string): Promise<Buffer> => {
      const [row] = await sql<{ id: Buffer }[]>`
        select schellingaf.register_peer(${randomBytes(32)}) as id`;
      const token = `schellingaf_${randomBytes(32).toString("hex")}`;
      await sql`
        insert into schellingaf.tokens (token_hash, peer_id, challenge_nonce, expires_at)
        values (${createHash("sha256").update(token).digest()}, ${row!.id}, ${randomBytes(16)},
                now() + interval '30 days')`;
      await sql`insert into bench.tokens (role, token) values (${role}, ${token})`;
      return row!.id;
    };

    const flooder = await peer("owner");
    say(`  ${SPACES} spaces of ${POSTS_PER_SPACE} posts, every one carrying all ${WORDS.length} words`);
    for (let r = 0; r < SPACES; r++) {
      await sql`select schellingaf.create_space(${flooder}, ${`flood-space-${r}`}, 'dense', '', 'invite', 'private')`;
    }
    // Straight in rather than through append_post, as scripts/seed.ts does: what
    // is measured here is reading. About seven kilobytes a body.
    const phrase = `${WORDS.join(" ")} `;
    await sql`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 1, ${flooder}, 'obs', 'dense ' || g,
             repeat(${phrase} || g || ' ', 55), sha256((s.name || ':' || g)::bytea)
        from schellingaf.spaces s, generate_series(1, ${POSTS_PER_SPACE}) g
       where s.name like 'flood-space-%'`;
    await sql`update schellingaf.spaces set last_seq = ${POSTS_PER_SPACE} where name like 'flood-space-%'`;

    const quietOwner = await peer("quiet-owner");
    await sql`select schellingaf.create_space(${quietOwner}, 'quiet-space', 'quiet', '', 'invite', 'private')`;
    await sql`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 1, ${quietOwner}, 'obs', 'quiet ' || g,
             'alpha finding number ' || g, sha256(('quiet:' || g)::bytea)
        from schellingaf.spaces s, generate_series(1, 50) g
       where s.name = 'quiet-space'`;
    await sql`update schellingaf.spaces set last_seq = 50 where name = 'quiet-space'`;
    await sql`
      insert into schellingaf.post_search (post_id, space_id, tsv)
      select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body) from schellingaf.posts p`;

    say(`  ${ATTACKERS} flooding KEYS, each a member of every dense space`);
    for (let i = 0; i < ATTACKERS; i++) {
      const id = await peer("attacker");
      await sql`
        insert into schellingaf.memberships (space_id, peer_id, role, tags, via, granted_by, revision)
        select s.space_id, ${id}, 'reader', '{}', 'grant', ${flooder}, 1
          from schellingaf.spaces s where s.name like 'flood-space-%'`;
    }
    say(`  ${READERS} honest KEYS and one searcher, members of the quiet space`);
    for (let i = 0; i < READERS + 1; i++) {
      const id = await peer(i < READERS ? "reader" : "searcher");
      await sql`
        insert into schellingaf.memberships (space_id, peer_id, role, tags, via, granted_by, revision)
        select s.space_id, ${id}, 'reader', '{}', 'grant', ${quietOwner}, 1
          from schellingaf.spaces s where s.name = 'quiet-space'`;
    }
    await buildCategory(sql, peer);
    await sql`analyze`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The corpus a category SEEK flood meets: CATEGORY_SPACES public SPACES under one
 * category from CATEGORY_OWNERS owners, every post dense with the words and none of
 * them seekable, as a flood past its authors' allowance would be; and forty-eight
 * fresh KEYS in nothing, to search it.
 */
async function buildCategory(sql: postgres.Sql, peer: (role: string) => Promise<Buffer>): Promise<void> {
  const { refileAll } = await import("../src/db/refile.ts");
  say(`  ${CATEGORY_SPACES} public SPACES under ${CATEGORY_ID} from ${CATEGORY_OWNERS} owners, ${CATEGORY_POSTS_PER_SPACE} unseekable posts each`);
  const owners: string[] = [];
  for (let i = 0; i < CATEGORY_OWNERS; i++) owners.push((await peer("category-owner")).toString("hex"));
  // Space i belongs to owner i modulo the owners, in one statement.
  await sql`
    insert into schellingaf.spaces (name, owner_id, title, description, visibility, categories)
    select 'cat-space-' || g, decode((${owners}::text[])[1 + g % ${CATEGORY_OWNERS}], 'hex'),
           'public', '', 'public', ${[CATEGORY_ID]}::text[]
      from generate_series(0, ${CATEGORY_SPACES - 1}) g`;
  const phrase = `${WORDS.join(" ")} `;
  await sql`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, g, 1, s.owner_id, 'obs', 'category flood ' || g,
           repeat(${phrase} || g || ' ', 10), sha256((s.name || ':' || g)::bytea)
      from schellingaf.spaces s, generate_series(1, ${CATEGORY_POSTS_PER_SPACE}) g
     where s.name like 'cat-space-%'`;
  await sql`update schellingaf.spaces set last_seq = ${CATEGORY_POSTS_PER_SPACE} where name like 'cat-space-%'`;
  await sql`
    insert into schellingaf.post_search (post_id, space_id, tsv, is_public, seekable)
    select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body), true, false
      from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where s.name like 'cat-space-%'`;
  await refileAll(sql);
  say(`  48 fresh KEYS in nothing, to search it`);
  for (let i = 0; i < 48; i++) await peer("category-searcher");
}

// ── one configuration, in a process of its own ─────────────────────────────

type Sample = { status: number; ms: number };

function summary(samples: Sample[]) {
  const served = samples.filter((s) => s.status === 200);
  const sorted = served.map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : null);
  return {
    served: served.length,
    busy: samples.filter((s) => s.status === 503).length,
    limited: samples.filter((s) => s.status === 429).length,
    other: samples.filter((s) => ![200, 429, 503].includes(s.status)).length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length ? Math.round(sorted.at(-1)!) : null,
  };
}

async function child(): Promise<void> {
  const { createApp } = await import("../src/http/app.ts");
  // The read pool's size comes from the environment, so it can be measured
  // without editing the service.
  const pool = Number(process.env.READ_POOL ?? READ_POOL);
  const config: Config = {
    apiHost: "api.schellingaf.test",
    publicOrigin: "https://api.schellingaf.test",
    challengeKey: Buffer.from("a-bench-challenge-key-not-a-secret"),
    readOnly: false,
    logDir: null,
    welcomeSpace: null,
    db: { host: "127.0.0.1", port: PORT, database: DATABASE, username: "schellingaf_api", password: "test_api_password_not_a_secret" },
  };
  const db = openDb(config, { readPool: pool });
  const app = createApp(config, db);

  const owner = ownerConnection();
  const tokens = await owner<{ role: string; token: string }[]>`select role, token from bench.tokens`;
  await owner.end({ timeout: 5 });
  const of = (role: string) => tokens.filter((t) => t.role === role).map((t) => t.token);

  const start = performance.now();
  const measureFrom = start + WARMUP_MS;
  const stopAt = measureFrom + MEASURE_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  /** One caller in a closed loop, never sending faster than `everyMs`. */
  async function loop(token: string, path: string, everyMs: number, into: Sample[]) {
    await sleep(Math.random() * everyMs);
    while (performance.now() < stopAt) {
      const sent = performance.now();
      const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
      await res.arrayBuffer();
      const done = performance.now();
      if (sent >= measureFrom && sent < stopAt) into.push({ status: res.status, ms: done - sent });
      const wait = res.status === 429 ? Number(res.headers.get("Retry-After") ?? 1) * 1000 : everyMs - (done - sent);
      await sleep(wait);
    }
  }

  const flood: Sample[] = [];
  const reads: Sample[] = [];
  const small: Sample[] = [];
  const q = encodeURIComponent(WORDS.join(" "));
  // A category flood: fresh KEYS searching the category corpus, kept to the category
  // or, for the baseline, not.
  const category = process.env.SEEK_CATEGORY;
  const kept = category && category !== "unscoped" ? `&category=${category}` : "";
  const flooding = of(category ? "category-searcher" : "attacker")
    .slice(0, Number(process.env.FLOODERS ?? 16))
    .map((t) => loop(t, `/v1/seek?q=${q}&limit=50&detail=ids${kept}`, 510, flood));
  await Promise.all([
    ...flooding,
    ...of("reader").map((t) => loop(t, "/v1/spaces/quiet-space/posts?limit=20", 110, reads)),
    ...of("searcher").map((t) => loop(t, "/v1/seek?q=alpha&space=quiet-space&limit=10", 600, small)),
  ]);
  await db.end();

  process.stdout.write(
    `${JSON.stringify({
      ceiling: Number(process.env.CONCURRENT_SEEKS),
      pool,
      seconds: MEASURE_MS / 1000,
      flood: summary(flood),
      reads: summary(reads),
      small: summary(small),
    })}\n`,
  );
}

// ── the driver ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes("--rebuild") || !(await exists())) {
    say(`building ${DATABASE} from schellingaf_tmpl`);
    await build();
  }
  const ceilings = list("ceilings", [2, 4, 6, 8, 12, 16]);
  const pools = list("pools", [READ_POOL]);
  const flooders = list("attackers", [16]);
  const script = fileURLToPath(import.meta.url);
  const category = arg("category");
  if (category) say(`flood: ${category === "unscoped" ? "the category corpus searched with no category" : `SEEK kept to ${category}`}`);

  // Which seekable index post_search has for this run: (tsv), as the schema makes
  // it, or (space_id, tsv), which the category window's per-SPACE probes could use.
  const index = arg("index") ?? "tsv";
  {
    const sql = ownerConnection();
    try {
      await sql`set role schellingaf_owner`;
      await sql`drop index if exists schellingaf.post_search_seekable_gin`;
      await sql.unsafe(
        index === "space-tsv"
          ? "create index post_search_seekable_gin on schellingaf.post_search using gin (space_id, tsv) with (fastupdate = on, gin_pending_list_limit = 1024) where seekable"
          : "create index post_search_seekable_gin on schellingaf.post_search using gin (tsv) with (fastupdate = on, gin_pending_list_limit = 1024) where seekable",
      );
      await sql`analyze schellingaf.post_search`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    say(`index: post_search_seekable_gin on ${index === "space-tsv" ? "(space_id, tsv)" : "(tsv)"}`);
  }

  say("");
  say("keys pool ceiling | flood served/s  busy | reads p50  p95  p99  max  refused | small seek p50  p95  max  refused");
  for (const keys of flooders) for (const pool of pools) {
    for (const ceiling of ceilings) {
      const out = await new Promise<string>((resolve, reject) => {
        const proc = spawn(process.execPath, [script, "--child"], {
          env: {
            ...process.env,
            CONCURRENT_SEEKS: String(ceiling),
            READ_POOL: String(pool),
            FLOODERS: String(keys),
            ...(category ? { SEEK_CATEGORY: category } : {}),
          },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let text = "";
        proc.stdout.on("data", (chunk) => (text += chunk));
        proc.on("exit", (code) => (code === 0 ? resolve(text) : reject(new Error(`child exited ${code}`))));
      });
      const r = JSON.parse(out.trim().split("\n").at(-1)!) as {
        seconds: number;
        flood: ReturnType<typeof summary>;
        reads: ReturnType<typeof summary>;
        small: ReturnType<typeof summary>;
      };
      const cell = (v: number | null, width: number) => String(v ?? "-").padStart(width);
      say(
        `${cell(keys, 4)} ${cell(pool, 4)} ${cell(ceiling, 7)} | ${cell(Math.round((r.flood.served / r.seconds) * 10) / 10, 14)} ${cell(r.flood.busy, 5)} |` +
          ` ${cell(r.reads.p50, 9)} ${cell(r.reads.p95, 4)} ${cell(r.reads.p99, 4)} ${cell(r.reads.max, 4)} ${cell(r.reads.busy + r.reads.limited + r.reads.other, 8)} |` +
          ` ${cell(r.small.p50, 14)} ${cell(r.small.p95, 4)} ${cell(r.small.max, 4)} ${cell(r.small.busy + r.small.limited + r.small.other, 8)}`,
      );
    }
  }
}

if (process.argv.includes("--child")) await child();
else await main();
