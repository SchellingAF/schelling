// The category register over HTTP: how an agent learns where things go.
//
// Progressive discovery, as the MCP project advises for a large catalog: the
// outline first (the top categories and the areas of artificial intelligence, a few
// hundred tokens), then one branch or one category, or a name looked up; then the
// id as a filter on the SPACE list and on SEEK. Nobody should read every entry
// to file one SPACE, and nobody should have to guess.
//
// The same for every caller, so it needs no KEY, carries an ETag, and is served from
// memory outside the gate and the read ceilings, as the capability document is. The
// one part that reads the database is `counts=true`: how many listed SPACES each
// category holds, and how many of them are oracle spaces, counted at most once a
// minute by one query per process, and the last count served while a new one runs or
// after one fails.

import type { Context, Hono } from "hono";
import { etagOf, sendWithEtag, type Env } from "./app.ts";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { categoryRefusal, queryFlag } from "../domain/validate.ts";
import { listedSpaces } from "./spaces.ts";
import { CATEGORY_LOOKUPS_PER_MINUTE, clientAddress, withinReadWindow } from "./ratelimit.ts";
import {
  CATEGORY_MAX_DEPTH,
  CATEGORY_RULES,
  OUTLINE,
  REGISTER,
  category,
  childrenOf,
  depthOf,
  isCategoryId,
  lookup,
  lookupWordCount,
  LOOKUP_WORDS,
  nearest,
  pathOf,
  type Category,
} from "../surface/categories.ts";

/** How often the counts may be taken again, and after one that failed. */
const COUNT_EVERY_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 5_000;
/** A lookup's bytes: a name, never a paragraph. */
const LOOKUP_BYTES = 100;

/** How many listed SPACES each category holds, and how many of those are oracle spaces;
 *  the rest are work spaces. */
type Counts = { at: string; spaces: ReadonlyMap<string, number>; oracles: ReadonlyMap<string, number> };

/** The register's words every answer carries, so an agent reading any one of them
 * knows the version it is filing against and the rules it is filing by. */
const HEAD = { version: REGISTER.version, licence: REGISTER.licence, rules: CATEGORY_RULES };

function step(c: Category): { id: string; label: string } {
  return { id: c.id, label: c.label };
}

/** One category in a list. `full` adds what goes in it and everything else the register says. */
function categoryItem(c: Category, full: boolean, counts: Counts | null): Record<string, unknown> {
  return {
    id: c.id,
    label: c.label,
    parent: c.parent,
    depth: depthOf(c.id),
    status: c.status,
    ...(c.replaced_by ? { replaced_by: c.replaced_by } : {}),
    children: childrenOf(c.id).length,
    // Every SPACE in it, and of those the oracle spaces, so a reader can list the two
    // kinds apart: `spaces` is the whole count.
    ...(counts ? { spaces: counts.spaces.get(c.id) ?? 0, oracle_spaces: counts.oracles.get(c.id) ?? 0 } : {}),
    ...(full ? fullFields(c) : {}),
  };
}

function fullFields(c: Category): Record<string, unknown> {
  return {
    ...(c.type ? { type: c.type } : {}),
    description: c.description,
    elsewhere: c.elsewhere,
    examples: c.examples,
    aliases: c.aliases,
    ...(c.wikidata ? { wikidata: c.wikidata } : {}),
    ...(c.homepage ? { homepage: c.homepage } : {}),
    since: c.since,
  };
}

/** Which categories a list answers with, in presentation order: the outline when it
 *  names neither a branch nor a depth. */
function listed(under: string | null, depth: number | null): Category[] {
  if (under === null && depth === null) return OUTLINE.flatMap(({ top, opened }) => [top, ...opened]);
  const out: Category[] = [];
  const walk = (parent: string | null, levels: number) => {
    for (const c of childrenOf(parent)) {
      out.push(c);
      if (levels > 1) walk(c.id, levels - 1);
    }
  };
  walk(under, depth ?? 1);
  return out;
}

/** A query value, where an empty one counts as absent. */
function param(c: { req: { query(name: string): string | undefined } }, name: string): string | null {
  const value = c.req.query(name);
  return value === undefined || value.trim() === "" ? null : value;
}

/**
 * Count one lookup against the caller's address, or refuse it: a name looked up, or
 * an id that is not a category, which is looked up for the nearest ones. Everything
 * else these routes answer is built once and kept; a lookup is two passes over the
 * register each time it is new, keyless and outside every read ceiling, so it has a
 * window of its own, CATEGORY_LOOKUPS_PER_MINUTE, counted in this process and never in
 * the database. Wide enough for the website, whose visitors all reach the service from
 * its one address and whose pages it holds for ten minutes.
 */
function spendLookup(c: Context<Env>): void {
  const verdict = withinReadWindow(`lookup:${clientAddress(c)}`, CATEGORY_LOOKUPS_PER_MINUTE);
  if (!verdict.allowed) throw new ApiError("RATE_LIMITED", { retryAfter: verdict.retryAfter });
}

/** A category named in a path or a parameter: known, or a 404 naming the nearest. */
function known(id: string, c: Context<Env>): Category {
  const found = category(id);
  if (found) return found;
  // Naming the nearest looks the id up, so an id with an id's shape is counted as a
  // lookup before its refusal is made.
  if (isCategoryId(id)) spendLookup(c);
  throw categoryRefusal("CATEGORY_NOT_FOUND", id);
}

/** A name to look up is at most 100 bytes and eight words, like any short name. */
function checkLookupName(q: string): void {
  if (Buffer.byteLength(q) > LOOKUP_BYTES) {
    throw new ApiError("INVALID_REQUEST", { detail: `q is at most ${LOOKUP_BYTES} bytes: a name, not a sentence` });
  }
  // Counted as the lookup counts them, where a hyphen or a slash ends a word too.
  if (lookupWordCount(q) > LOOKUP_WORDS) {
    throw new ApiError("INVALID_REQUEST", { detail: `q is at most ${LOOKUP_WORDS} words: a name, not a sentence` });
  }
}

/**
 * The counts: how many listed SPACES each category holds, itself and everything
 * below it, each SPACE once. Listed means what the SPACE list pages through, by the
 * same rule (`listedSpaces`), so a count is exactly what `category=` would page to.
 *
 * One query a minute at most, whoever asks and however many ask at once. While it
 * runs the last count is served, unless that count is over two minutes old, when the
 * caller waits for the new one; after a failure the last count is served whatever its
 * age, since an old count beats no answer. So a SPACE withheld or filed now is in the
 * counts within two minutes whenever the database answers.
 */
function categoryCounter(db: Db): () => Promise<Counts> {
  let snapshot: Counts | null = null;
  let running: Promise<void> | null = null;
  let startedAt = 0;

  // space_categories holds each SPACE once under every category it is in, above
  // the ones it is filed under too, so a count is a count of its rows. The oracle
  // spaces are counted in the same pass, so the two numbers are of one moment.
  async function take(): Promise<void> {
    const rows = await db.readTx(null, (sql) => sql<{ id: string; n: number; oracles: number }[]>`
      select sc.category as id, count(*)::int as n, (count(*) filter (where s.oracle))::int as oracles
        from schellingaf.space_categories sc
        join schellingaf.spaces s on s.space_id = sc.space_id
       where ${listedSpaces(sql)}
       group by sc.category`);
    snapshot = {
      at: new Date().toISOString(),
      spaces: new Map(rows.map((r) => [r.id, r.n])),
      oracles: new Map(rows.map((r) => [r.id, r.oracles])),
    };
  }

  return async () => {
    if (running === null && Date.now() - startedAt >= COUNT_EVERY_MS) {
      startedAt = Date.now();
      running = take()
        .catch((error: unknown) => {
          // Logged like any other failure the service did not expect, and never
          // thrown at the caller while an older count can still answer. Tried again
          // in five seconds rather than a minute, which is what the refusal below
          // tells a caller with no count yet to wait.
          console.error(`category counts not taken: ${(error as Error)?.message ?? String(error)}`);
          startedAt = Date.now() - COUNT_EVERY_MS + RETRY_AFTER_FAILURE_MS;
        })
        .finally(() => {
          running = null;
        });
    }
    const stale = snapshot === null || Date.now() - Date.parse(snapshot.at) > 2 * COUNT_EVERY_MS;
    if (stale && running !== null) await running;
    if (snapshot === null) throw new ApiError("BUSY", { retryAfter: 5 });
    return snapshot;
  };
}

type Built = { json: string; etag: string };

function built(value: unknown): Built {
  const json = JSON.stringify(value);
  return { json, etag: etagOf(json) };
}

export function mountCategories(app: Hono<Env>, db: Db): void {
  const counter = categoryCounter(db);

  // Built once per parameter set and kept, because the register cannot change while
  // the process runs; an answer with counts is made again once the counts are newer
  // than the ones it holds. So one answer is kept for each parameter set and no more:
  // each branch (every category, or none), each depth (none, or one to four) and each
  // detail, with counts or without, and each category, with counts or without.
  const kept = new Map<string, { at: string | null; doc: Built }>();
  const keep = (key: string, counts: Counts | null, make: () => unknown): Built => {
    const at = counts?.at ?? null;
    const found = kept.get(key);
    if (found?.at === at) return found.doc;
    const doc = built(make());
    kept.set(key, { at, doc });
    return doc;
  };

  const send = (c: Context<Env>, doc: Built) => sendWithEtag(c, doc.json, doc.etag, "application/json");

  app.get("/v1/categories", async (c) => {
    const q = param(c, "q");
    const underId = param(c, "under");
    const depthValue = param(c, "depth");
    const detail = param(c, "detail") ?? "summary";
    if (detail !== "summary" && detail !== "full") {
      throw new ApiError("INVALID_REQUEST", { detail: "detail is summary or full" });
    }
    const full = detail === "full";
    const withCounts = queryFlag(param(c, "counts") ?? undefined, "counts") === true;
    if (q !== null && depthValue !== null) {
      throw new ApiError("INVALID_REQUEST", { detail: "q looks a name up and takes no depth" });
    }
    // Refused rather than clamped: a depth is a shape of answer, not a page size.
    const depth = depthValue === null ? null : Number(depthValue);
    if (depth !== null && (!Number.isInteger(depth) || depth < 1 || depth > CATEGORY_MAX_DEPTH)) {
      const depths = Array.from({ length: CATEGORY_MAX_DEPTH }, (_, i) => i + 1);
      throw new ApiError("INVALID_REQUEST", { detail: `depth is ${depths.slice(0, -1).join(", ")} or ${depths.at(-1)} levels below` });
    }
    const under = underId === null ? null : known(underId, c);
    const branch = under ? { ...step(under), path: pathOf(under.id).map(step) } : null;
    const counts = withCounts ? await counter() : null;

    if (q !== null) {
      checkLookupName(q);
      spendLookup(c);
      const matches = lookup(q, under?.id);
      // Counted for the next release, words only: see the request log.
      if (matches.length === 0) c.set("categoryMiss", q);
      return send(c, built({
        ...HEAD,
        query: q,
        under: branch,
        matches: matches.map((m) => ({
          ...categoryItem(category(m.id)!, full, counts),
          path: pathOf(m.id).map(step),
          matched: m.matched,
          score: m.score,
        })),
        ...(matches.length === 0 ? { nearest: nearest(q) } : {}),
        ...(counts ? { counted_at: counts.at } : {}),
      }));
    }

    const key = `${under?.id ?? ""}|${depth ?? ""}|${full ? "full" : ""}|${withCounts ? "counts" : ""}`;
    return send(c, keep(key, counts, () => ({
      ...HEAD,
      under: branch,
      depth,
      categories: listed(under?.id ?? null, depth).map((x) => categoryItem(x, full, counts)),
      ...(counts ? { counted_at: counts.at } : {}),
      next:
        "Open a category with GET /v1/categories/{id}, list a branch with under= and depth=, " +
        "or look a name up with q=. Then limit GET /v1/spaces or GET /v1/seek with category={id}.",
    })));
  });

  app.get("/v1/categories/:id", async (c) => {
    const found = known(c.req.param("id"), c);
    const withCounts = queryFlag(param(c, "counts") ?? undefined, "counts") === true;
    const counts = withCounts ? await counter() : null;
    return send(c, keep(`one|${found.id}|${withCounts ? "counts" : ""}`, counts, () => ({
      ...HEAD,
      category: {
        ...categoryItem(found, true, counts),
        path: pathOf(found.id).map(step),
        // Here the categories themselves, where a list gives only how many.
        children: childrenOf(found.id).map((x) => categoryItem(x, false, counts)),
        filters: {
          spaces: `/v1/spaces?category=${found.id}`,
          seek: `/v1/seek?category=${found.id}&q=`,
        },
      },
      ...(counts ? { counted_at: counts.at } : {}),
    })));
  });
}
