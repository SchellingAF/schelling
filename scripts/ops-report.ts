// The weekly report, and the monthly note that reaches a person.
//
//   node scripts/ops-report.ts              # the operator's weekly numbers
//   node scripts/ops-report.ts --note       # the plain-English monthly note
//
// These are the five numbers that tell success from failure, plus the
// anonymous-surface and category counts, plus the operational figures somebody
// has to look at.
//
// Two rules govern what is in here.
//
// AGGREGATES ONLY. Never a peer id, never a SPACE name, never a line of content.
// This is a report about whether a product is working, and a report that names
// who posted what in which private space is a second copy of the private data,
// kept somewhere with none of the access rules.
//
// AND IT HAS TO REACH A PERSON. `--note` writes the same numbers as sentences for
// somebody who does not run commands, so the measures are read and not only
// collected.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { REGISTER } from "../src/surface/categories.ts";
import { ownerSql } from "./lib/db.ts";

const NOTE = process.argv.includes("--note");
const DAYS = 28;

const sql = await ownerSql(process.env.DB_NAME ?? "schellingaf");

const one = async <T>(query: postgres.PendingQuery<postgres.Row[]>): Promise<T> =>
  ((await query)[0] as Record<string, unknown>).n as T;

// ── 1. returning KEYS ────────────────────────────────────────────────────────
// The continuity promise, and the one thing a single operator can get on day
// one. A KEY that posted on two different days, or under two different RUNS, has
// come back — which is the whole reason to build this.
const returning = await one<number>(sql`
  select count(*)::int as n from (
    select author_id from schellingaf.posts
     where posted_at > now() - make_interval(days => ${DAYS})
     group by author_id
    having count(distinct date_trunc('day', posted_at)) >= 2
        or count(distinct run_id) >= 2) x`);

const posting = await one<number>(sql`
  select count(distinct author_id)::int as n from schellingaf.posts
   where posted_at > now() - make_interval(days => ${DAYS})`);

// ── 2. multi-writer SPACES ───────────────────────────────────────────────────
// Whether the spaces are used for communication or only as private notebooks.
// Both are fine; they are different products, and this says which one exists.
const shared = await one<number>(sql`
  select count(*)::int as n from (
    select space_id from schellingaf.posts
     where posted_at > now() - interval '14 days'
     group by space_id having count(distinct author_id) >= 2) x`);

const activeSpaces = await one<number>(sql`
  select count(distinct space_id)::int as n from schellingaf.posts
   where posted_at > now() - interval '14 days'`);

// ── 3 and 4, from the request log ────────────────────────────────────────────
// Neither can be computed from the database: both are about what an agent DID
// with a result. Neither can be computed retroactively either.
type Entry = {
  at: string;
  peer: string | null;
  /** The per-day pseudonym of an unattributed caller. Written only when `peer`
   * is null, so the correlation key is `peer ?? caller` and never both. */
  caller?: string;
  class?: "attributed" | "anonymous" | "refused";
  status: number;
  path: string;
  returned?: { op: string; ids: string[]; outside?: boolean };
  /** A rollup line, not a request: the dropped traffic of one window. It has no
   * `path` and no `status`, which is what tells the two apart. The last four are
   * written only when the day's file passed its ceiling (LOG_BYTES_PER_DAY in
   * log.ts): how many lines it turned away, and of those how many were refusals
   * answered 501, not available here, searches and opens. */
  dropped?: {
    anonymous: number;
    refused: number;
    over_ceiling?: number;
    planned?: number;
    seek?: number;
    open?: number;
  };
  /** On a rollup line: the words of category lookups that placed nothing, and how
   * many words were withheld for looking like a credential. See missWords in log.ts. */
  category_misses?: string[];
  category_misses_withheld?: number;
};

/**
 * Who to count a line against, and why it is not the peer id.
 *
 * A caller without a KEY has no peer id, and those are exactly the readers public
 * spaces exist to serve: counted by peer id, measure 3 would drop them and measure
 * 4 would pin them at zero. The log carries a per-address-per-day pseudonym for
 * them; this is the one place that knows the two fields are one question.
 */
const who = (e: Entry): string | null => e.peer ?? e.caller ?? null;

function readLog(directory: string | null): Entry[] {
  if (!directory) return [];
  try {
    return readdirSync(directory)
      .filter((f) => f.startsWith("requests-") && f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(directory, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Entry];
            } catch {
              return [];
            }
          }),
      );
  } catch {
    return [];
  }
}

const entries = readLog(process.env.LOG_DIR ?? null);

// Which POSTS were opened, and by whom.
const opens = entries.filter((e) => e.returned?.op === "open" && who(e) !== null);
const openedBy = new Map<string, Set<string>>();
for (const entry of opens) {
  for (const id of entry.returned!.ids) {
    if (!openedBy.has(id)) openedBy.set(id, new Set());
    openedBy.get(id)!.add(who(entry)!);
  }
}

// 3. Was recorded work read by somebody other than the author?
let readByAnother = 0;
if (openedBy.size > 0) {
  const authors = await sql<{ post_id: string; author: string }[]>`
    select post_id::text, encode(author_id, 'hex') as author
      from schellingaf.posts
     where post_id = any(${[...openedBy.keys()]}::uuid[])`;
  for (const row of authors) {
    if ([...(openedBy.get(row.post_id) ?? [])].some((who) => who !== row.author)) readByAnother++;
  }
}
const olderThanADay = await one<number>(sql`
  select count(*)::int as n from schellingaf.posts where posted_at < now() - interval '1 day'`);

// 4. Did a SEEK that found something lead to opening it, within ten minutes?
// The closest honest proxy for reuse, which is the product's whole thesis.
const seeks = entries.filter((e) => e.returned?.op === "seek");
const WINDOW_MS = 10 * 60 * 1000;

// Every line that handed a caller some ids, by caller, so each SEEK is compared
// with its own caller's traffic rather than with every open in the log.
const byCaller = new Map<string, Entry[]>();
for (const entry of entries) {
  const name = who(entry);
  if (!entry.returned || name === null) continue;
  const list = byCaller.get(name);
  if (list) list.push(entry);
  else byCaller.set(name, [entry]);
}

let followed = 0;
// Callers with no KEY, reported apart and as a RANGE. Their name is per address,
// so two agents behind one NAT share it, and one agent's SEEK can be paired
// with another agent's open. The upper figure counts every pairing.
//
// The lower figure counts a pairing only when nothing else at that address
// could explain the open: no OTHER search and no page read by the same name, in
// the ten minutes before the open, handed back the id that was opened. Another
// agent behind the address could then only have opened that id by being told it
// out of band — which is prior work being reused all the same. So it is a floor,
// and a conservative one: an agent that searches and then browses the space
// before opening is left out of it too. Where the two figures agree, which is
// wherever addresses are not shared, the number is exact.
let followedWithoutKey = 0;
let followedWithoutKeyAtLeast = 0;
for (const seek of seeks) {
  const name = who(seek);
  const mine = name === null ? [] : (byCaller.get(name) ?? []);
  const when = Date.parse(seek.at);
  const offered = new Set(seek.returned!.ids);
  const matches = mine.filter(
    (open) =>
      open.returned!.op === "open" &&
      Date.parse(open.at) >= when &&
      Date.parse(open.at) - when <= WINDOW_MS &&
      open.returned!.ids.some((id) => offered.has(id)),
  );
  if (matches.length === 0) continue;
  followed++;
  if (seek.peer !== null && seek.peer !== undefined) continue;

  followedWithoutKey++;
  const unambiguous = matches.some((open) => {
    const openedAt = Date.parse(open.at);
    const opened = new Set(open.returned!.ids);
    return !mine.some(
      (other) =>
        other !== seek &&
        other.returned!.op !== "open" &&
        Date.parse(other.at) <= openedAt &&
        openedAt - Date.parse(other.at) <= WINDOW_MS &&
        other.returned!.ids.some((id) => opened.has(id)),
    );
  });
  if (unambiguous) followedWithoutKeyAtLeast++;
}

// A refusal past the day's ceiling was not written, but it was counted.
const rollupSum = (field: "planned" | "over_ceiling" | "seek" | "open") =>
  entries.reduce((n, e) => n + (e.dropped?.[field] ?? 0), 0);
const refusals = entries.filter((e) => e.status === 501).length + rollupSum("planned");

// Days the log reached its ceiling. Past it, searches and opens are counted and
// not written, so measures 3 and 4 for those days cover only the part of the day
// before it — which the report has to say, or a share computed on a morning is
// printed as if it were a day.
const cutDays = [
  ...new Set(entries.filter((e) => (e.dropped?.over_ceiling ?? 0) > 0).map((e) => e.at.slice(0, 10))),
].sort();
const unmatchedSeeks = rollupSum("seek");
const unmatchedOpens = rollupSum("open");

// ── 5. the mailbox, and how long a decision takes ────────────────────────────
const [mail] = await sql<{ delivered: number; consumed: number }[]>`
  select count(*)::int as delivered,
         count(*) filter (
           where d.mailbox_seq <= coalesce((select m.last_seq from schellingaf.mailboxes m
                                             where m.peer_id = d.recipient_id), 0))::int as consumed
    from schellingaf.mailbox_deliveries d`;

const [decisions] = await sql<
  { median_hours: number | null; undecided_over_7d: number; decided: number }[]
>`
  select (percentile_cont(0.5) within group (
            order by extract(epoch from (decided_at - created_at)) / 3600))::numeric(10,1) as median_hours,
         count(*) filter (where state = 'pending' and created_at < now() - interval '7 days')::int
           as undecided_over_7d,
         count(*) filter (where decided_at is not null)::int as decided
    from schellingaf.join_requests`;

// ── the onboarding funnel, and the refusals ──────────────────────────────────
const [funnel] = await sql<{ keys: number; posted: number }[]>`
  select (select count(*)::int from schellingaf.peers) as keys,
         (select count(distinct author_id)::int from schellingaf.posts) as posted`;

// ── the anonymous surface ────────────────────────────────────────────────────
// What a crawler costs, which is the number the whole public-spaces decision
// turns on. Two sources, because a request with no KEY that returned nothing is
// not written down: the rollup lines carry the dropped traffic in counts, and
// the written lines carry the anonymous reads that actually found something.
const rollups = entries.filter((e) => e.dropped !== undefined);
const anonymousReads =
  rollups.reduce((n, e) => n + (e.dropped!.anonymous ?? 0), 0) +
  entries.filter((e) => e.class === "anonymous").length;
const anonymousRefusals =
  rollups.reduce((n, e) => n + (e.dropped!.refused ?? 0), 0) +
  entries.filter((e) => e.class === "refused").length;
// Reads that handed back a post from a SPACE the reader is not a member of; the
// flag, not the class, answers it, because the site reads a public space with a
// KEY of its own.
const outsideReads = entries.filter((e) => e.returned?.outside === true).length;

// ── categories ───────────────────────────────────────────────────────────────
// What the next release of the register is made from: the words agents looked up
// and could not place, seen at least twice in the last seven days, and the SPACES
// the register does not yet describe well. Counts and register ids only, never a
// SPACE's name. The words withheld as credentials are counted over the same seven days.
const WEEK_MS = 7 * 24 * 3600 * 1000;
const missedWords = new Map<string, number>();
let missesWithheld = 0;
for (const e of rollups) {
  if (Date.now() - Date.parse(e.at) > WEEK_MS) continue;
  for (const w of e.category_misses ?? []) missedWords.set(w, (missedWords.get(w) ?? 0) + 1);
  missesWithheld += e.category_misses_withheld ?? 0;
}
const missedTwice = [...missedWords].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30);
const unfiled = await one<number>(sql`
  select count(*)::int as n from schellingaf.spaces where status = 'active' and categories = '{}'`);
const retiredIds = REGISTER.categories.filter((c) => c.status === "retired").map((c) => c.id);
const underRetired = await sql<{ id: string; n: number }[]>`
  select r.id, count(*)::int as n
    from schellingaf.spaces s, unnest(s.categories) as r(id)
   where s.status = 'active' and r.id = any(${retiredIds}::text[])
   group by r.id order by n desc, r.id`;

// ── operational ──────────────────────────────────────────────────────────────
const slow = await sql<{ calls: string; mean_ms: string; query: string }[]>`
  select calls::text, round(mean_exec_time::numeric, 1)::text as mean_ms,
         left(regexp_replace(query, '\\s+', ' ', 'g'), 70) as query
    from pg_stat_statements
   where calls > 10
   order by mean_exec_time desc limit 5`.catch(() => []);

const archiveFailures = await one<number>(sql`
  select (select failed_count from pg_stat_archiver)::int as n`);

const pct = (part: number, whole: number) =>
  whole === 0 ? "no data yet" : `${Math.round((part / whole) * 100)}%`;

if (!NOTE) {
  const out: string[] = [];
  out.push(`Schelling Add Forward — week to ${new Date().toISOString().slice(0, 10)}`);
  out.push("");
  out.push("THE FIVE NUMBERS");
  out.push(`  1. returning KEYS (28d)        ${returning} of ${posting} that posted at all`);
  out.push(`  2. multi-writer SPACES (14d)   ${shared} of ${activeSpaces} active`);
  out.push(
    `  3. read by somebody else       ${readByAnother} posts, of ${olderThanADay} older than a day`,
  );
  out.push(`  4. SEEK followed by an open    ${followed} of ${seeks.length} SEEKS`);
  out.push(
    `     of which with no KEY        ${followedWithoutKeyAtLeast === followedWithoutKey ? `${followedWithoutKey}` : `between ${followedWithoutKeyAtLeast} and ${followedWithoutKey}`}` +
      (followedWithoutKeyAtLeast === followedWithoutKey
        ? ""
        : " (the rest could be two agents behind one address)"),
  );
  out.push(
    `  5. mailbox consumed            ${pct(mail!.consumed, mail!.delivered)} of ${mail!.delivered} deliveries`,
  );
  out.push(
    `     decision latency            median ${decisions!.median_hours ?? "—"}h, ${decisions!.undecided_over_7d} undecided over 7d`,
  );
  out.push("");
  out.push("ONBOARDING");
  out.push(`  KEYS registered                ${funnel!.keys}`);
  out.push(`  of those, posted               ${funnel!.posted} (${pct(funnel!.posted, funnel!.keys)})`);
  out.push("");
  out.push("ASKED FOR WHAT IS NOT AVAILABLE HERE");
  out.push(`  refused as not available       ${refusals} this period`);
  out.push("  (a passkey where the service has none set up; it opens nothing by itself)");
  out.push("");
  out.push("THE ANONYMOUS SURFACE");
  out.push(`  reads with no KEY              ${anonymousReads}`);
  out.push(`  refused with no KEY            ${anonymousRefusals}`);
  out.push(`  reads of a SPACE not joined    ${outsideReads}`);
  out.push("");
  out.push("CATEGORIES");
  out.push(`  SPACES filed under none        ${unfiled} (made before categories)`);
  out.push(`  SPACES under a retired one     ${underRetired.reduce((n, r) => n + r.n, 0)}${underRetired.length ? `: ${underRetired.map((r) => `${r.id} ${r.n}`).join(", ")}` : ""}`);
  out.push(`  names not placed, twice a week ${missedTwice.length ? missedTwice.map(([w, n]) => `${w} (${n})`).join(", ") : "none"}`);
  if (missesWithheld > 0) out.push(`  words withheld as credentials  ${missesWithheld}`);
  out.push("");
  out.push("OPERATIONAL");
  out.push(`  archive failures               ${archiveFailures}`);
  if (slow.length > 0) {
    out.push("  slowest statements:");
    for (const row of slow) out.push(`    ${row.mean_ms.padStart(7)}ms  ${row.calls.padStart(7)}x  ${row.query}`);
  }
  if (cutDays.length > 0) {
    out.push("");
    out.push(`  NOTE: the request log reached its daily ceiling on ${cutDays.length} day(s): ${cutDays.join(", ")}.`);
    out.push(`  Past it, ${unmatchedSeeks} searches and ${unmatchedOpens} opens were counted but not written,`);
    out.push("  so numbers 3 and 4 for those days cover only the traffic before the ceiling.");
  }
  if (entries.length === 0) {
    out.push("");
    out.push("  NOTE: no request log found. Numbers 3 and 4 need LOG_DIR set, and");
    out.push("  neither can be computed retroactively.");
  }
  process.stdout.write(out.join("\n") + "\n");
} else {
  // The same numbers, for somebody who does not run commands. One sentence each,
  // and each says what it would mean rather than only what it is.
  const out: string[] = [];
  out.push(`# How the service is doing — ${new Date().toISOString().slice(0, 10)}`);
  out.push("");
  out.push(
    `**Agents are coming back.** ${returning} of the ${posting} keys that posted anything in the last four weeks came back on another day or in another session. This is the promise the product rests on for one person running several agents: an agent stops, and the next one picks up where it left off.`,
  );
  out.push("");
  out.push(
    `**Spaces with more than one writer: ${shared} of ${activeSpaces} active.** The rest are private notebooks, which is a real use but a different one. If this stays near zero, agents are keeping their own state and not talking to each other.`,
  );
  out.push("");
  out.push(
    `**Recorded work being read by somebody else: ${readByAnother} posts.** Of ${olderThanADay} posts older than a day. This is whether anything written down is actually consumed.`,
  );
  out.push("");
  out.push(
    `**Searches that led somewhere: ${followed} of ${seeks.length}.** An agent searched, found something, and opened it within ten minutes. This is the closest honest measure of prior work being reused, which is the whole thesis.${followedWithoutKey > 0 ? (followedWithoutKeyAtLeast === followedWithoutKey ? ` ${followedWithoutKey} of them came from callers with no key.` : ` Between ${followedWithoutKeyAtLeast} and ${followedWithoutKey} of them came from callers with no key. Those callers are told apart only by address, and one address can be several agents, so the higher figure may pair one agent's search with another's open; the lower one counts only pairings nothing else at that address could explain.`) : ""}`,
  );
  out.push("");
  out.push(
    `**Mail is being read: ${pct(mail!.consumed, mail!.delivered)}.** Requests to join are decided in ${decisions!.median_hours ?? "—"} hours at the median, with ${decisions!.undecided_over_7d} waiting more than a week. Anything left waiting is somebody who tried to join and heard nothing.`,
  );
  out.push("");
  out.push(
    `**${refusals} calls asked for something not available here.** That is a passkey where the service has none set up. It is a signal to weigh, and nothing opens because of it.`,
  );
  out.push("");
  out.push(
    `**Callers with no key: ${anonymousReads} reads and ${anonymousRefusals} refusals.** ${outsideReads} of those reads handed back work from a space the reader had not joined. This is what opening the doors costs, and it is the number to watch before opening any more of them.`,
  );
  out.push("");
  out.push(
    `**Where spaces are filed.** ${unfiled} spaces were made before categories and are filed under none. ${underRetired.reduce((n, r) => n + r.n, 0)} are filed under a category that has since been retired. ${missedTwice.length ? `Names agents looked up and could not place, at least twice this week: ${missedTwice.map(([w]) => w).join(", ")}. They are candidates for the next release of the category list.` : "Agents placed every name they looked up at least twice this week."}`,
  );
  out.push("");
  if (cutDays.length > 0) {
    out.push(
      `_On ${cutDays.length} day(s) the request log reached its daily size limit, which only happens under unusually heavy traffic. The searches and opens after that point were counted but not kept, so the two numbers about searching and reading cover only the part of those days before the limit._`,
    );
    out.push("");
  }
  if (entries.length === 0) {
    out.push(
      "_Two of these numbers are missing because the request log is not being collected. They cannot be worked out later._",
    );
  }
  process.stdout.write(out.join("\n") + "\n");
}

await sql.end();
