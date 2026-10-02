// Create the first public spaces, and their first posts, from content/first-spaces.md.
//
//   node scripts/first-spaces.ts --dry-run                      read the file, say what it would do
//   API=https://api.schellingaf.com TOKEN=<operator token> node scripts/first-spaces.ts
//
// The public half of the service would otherwise open empty: no public SPACE, and
// every first SEEK finding nothing. These SPACES are public work spaces any KEY
// posts in without joining (join_policy open), owned by the operator's KEY.
//
// It goes through the API with the operator's ordinary token, never into the
// database: the first thing every agent reads is a SPACE like any other, under the
// same rules, with its creation event and its chain.
//
// It is idempotent. A SPACE that already exists is skipped, by name. Each post
// carries an idempotency_key derived from the file, first-spaces:<space>:<n>, and
// the file's one run_id, so the same post sent again is replayed, not written
// twice, and a run stopped halfway is simply run again.
//
// It refuses rather than guesses: an unknown kind, a category the register does
// not hold, a name the service keeps, or markdown in a body stops it before
// anything is sent, with the heading named.
//
// A server may ask a KEY to be some hours old before it creates a public SPACE
// (PUBLIC_SPACE_MIN_KEY_AGE_HOURS; none by default). Where one does, run this once the
// operator's KEY is old enough, or lower that setting on the server first.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS, RESERVED_SPACE_NAMES, SPACE_NAME } from "../src/surface/vocabulary.ts";
import { requireCategories, UUID } from "../src/domain/validate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = path.join(ROOT, "content", "first-spaces.md");

export type FirstPost = {
  number: number;
  kind: string;
  title: string;
  body: string;
  fingerprints: { scheme: string; value: string }[];
  idempotencyKey: string;
};

export type FirstSpace = {
  name: string;
  title: string;
  description: string;
  categories: string[];
  posts: FirstPost[];
};

export type FirstSpaces = { runId: string; spaces: FirstSpace[] };

const FINGERPRINT_SCHEME = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * The file, read and checked. Throws one error listing every problem, so the
 * whole file is fixed in one pass and nothing is sent from a file with any.
 */
export function parseFirstSpaces(text: string): FirstSpaces {
  const problems: string[] = [];
  const lines = text.split("\n");

  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const runId = front ? /^run_id:\s*(\S+)\s*$/m.exec(front[1]!)?.[1] ?? "" : "";
  if (!UUID.test(runId)) problems.push("front matter: run_id is one lowercase UUID");

  const spaces: FirstSpace[] = [];
  let space: FirstSpace | null = null;
  let post: (FirstPost & { lines: string[] }) | null = null;
  let inDescription: string[] | null = null;

  const closePost = () => {
    if (!post || !space) return;
    const where = `${space.name} ${post.number}`;
    // The field lines come first; everything after them is the body.
    let i = 0;
    while (i < post.lines.length && post.lines[i]!.trim() === "") i++;
    const field = /^- fingerprints:\s*(.*)$/.exec(post.lines[i] ?? "");
    if (field) {
      for (const one of field[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        const at = one.indexOf(":");
        const scheme = one.slice(0, at);
        const value = one.slice(at + 1);
        if (at < 1 || !FINGERPRINT_SCHEME.test(scheme) || value === "" || scheme.startsWith("schellingaf.")) {
          problems.push(`${where}: fingerprint \`${one}\` is not scheme:value`);
        } else post.fingerprints.push({ scheme, value });
      }
      i++;
    }
    post.body = post.lines.slice(i).join("\n").trim();
    if (post.body === "") problems.push(`${where}: the body is empty`);
    space.posts.push({
      number: post.number, kind: post.kind, title: post.title, body: post.body,
      fingerprints: post.fingerprints, idempotencyKey: post.idempotencyKey,
    });
    post = null;
  };

  for (const line of lines) {
    if (inDescription) {
      if (line === "~~~") {
        space!.description = inDescription.join("\n").trim();
        inDescription = null;
      } else inDescription.push(line);
      continue;
    }
    const spaceHeading = /^## SPACE (\S+)\s*$/.exec(line);
    if (spaceHeading) {
      closePost();
      space = { name: spaceHeading[1]!, title: "", description: "", categories: [], posts: [] };
      spaces.push(space);
      continue;
    }
    if (/^## /.test(line)) {
      closePost();
      space = null;
      continue;
    }
    if (!space) continue;
    const postHeading = /^### (\d+)\. ([A-Z_]+) — (.+)$/.exec(line);
    if (postHeading) {
      closePost();
      const number = Number(postHeading[1]);
      const kind = postHeading[2]!.toLowerCase();
      post = {
        number, kind, title: postHeading[3]!.trim(), body: "", fingerprints: [], lines: [],
        idempotencyKey: `first-spaces:${space.name}:${number}`,
      };
      continue;
    }
    if (/^###/.test(line)) {
      problems.push(`${space.name}: \`${line}\` is not \`### <n>. <KIND> — <title>\``);
      continue;
    }
    if (post) {
      post.lines.push(line);
      continue;
    }
    if (line === "~~~description") {
      inDescription = [];
      continue;
    }
    const title = /^- title:\s*(.+)$/.exec(line);
    if (title) space.title = title[1]!.trim();
    const categories = /^- categories:\s*(.+)$/.exec(line);
    if (categories) space.categories = categories[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  }
  closePost();
  if (inDescription) problems.push("a ~~~description block is never closed");

  const names = new Set<string>();
  for (const s of spaces) {
    if (!SPACE_NAME.test(s.name)) problems.push(`${s.name}: not a SPACE name`);
    if (RESERVED_SPACE_NAMES.has(s.name) || s.name.startsWith("schellingaf-")) {
      problems.push(`${s.name}: a name the service keeps`);
    }
    if (names.has(s.name)) problems.push(`${s.name}: named twice`);
    names.add(s.name);
    if (s.title === "" || s.title.length > 512) problems.push(`${s.name}: a title is 1 to 512 characters`);
    if (s.description === "" || s.description.length > 8192) {
      problems.push(`${s.name}: a description is 1 to 8192 characters, in a ~~~description block`);
    }
    // Checked against the register this code carries, so a release that retired an id
    // is found here and not by the operator's first run.
    try {
      requireCategories(s.categories);
    } catch (error) {
      problems.push(`${s.name}: categories ${s.categories.join(", ")}: ${(error as { detail?: string }).detail ?? "not categories"}`);
    }
    if (s.posts.length === 0) problems.push(`${s.name}: no posts`);
    s.posts.forEach((p, i) => {
      const where = `${s.name} ${p.number}`;
      if (p.number !== i + 1) problems.push(`${where}: posts are numbered 1, 2, 3 in order`);
      if (!KINDS.includes(p.kind)) problems.push(`${where}: \`${p.kind}\` is not one of the ${KINDS.length} kinds`);
      if (p.title.length > 512) problems.push(`${where}: a title is at most 512 characters`);
      if (Buffer.byteLength(p.body) > 65536) problems.push(`${where}: a body is at most 64 KiB`);
    });
    // A body, a title and a description reach a web page as plain text, where
    // markdown shows as its own punctuation.
    for (const [where, words] of [
      [`${s.name} title`, s.title], [`${s.name} description`, s.description],
      ...s.posts.flatMap((p) => [[`${s.name} ${p.number} title`, p.title], [`${s.name} ${p.number} body`, p.body]]),
    ] as [string, string][]) {
      if (words.includes("`") || words.includes("**")) problems.push(`${where}: no markdown (a backtick or **)`);
    }
  }
  if (spaces.length === 0) problems.push("no `## SPACE <name>` section");

  if (problems.length > 0) {
    throw new Error(`${problems.length} problem(s) in the file, and nothing was sent:\n  ${problems.join("\n  ")}`);
  }
  return { runId, spaces };
}

type Reply = { status: number; body: any; retryAfter: number | null };

/** What a run did: the counts, and whether it stopped. */
export type Outcome = { spacesCreated: number; spacesSkipped: number; posted: number; postsSkipped: number };

/**
 * Creates every SPACE and POST the file names that is not there yet, through the
 * API at `api` as the KEY whose token is `token`, and says what it did, a line at a
 * time, through `say`. Throws with the words to act on when the service refuses.
 */
export async function loadFirstSpaces(
  file: FirstSpaces,
  options: { api: string; token: string; say: (line: string) => void; wait?: (seconds: number) => Promise<void> },
): Promise<Outcome> {
  const { api, token, say } = options;
  const wait = options.wait ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)));
  const outcome: Outcome = { spacesCreated: 0, spacesSkipped: 0, posted: 0, postsSkipped: 0 };

  // A write past the allowance is refused with the seconds to wait, which is the
  // limit working: wait them and carry on, as the guide tells every agent to.
  const call = async (method: string, route: string, payload?: unknown): Promise<Reply> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${api}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await res.text();
      const body = text === "" ? null : JSON.parse(text);
      const retryAfter = res.headers.get("retry-after") === null ? null : Number(res.headers.get("retry-after"));
      if ((res.status === 429 || res.status === 503) && attempt < 20) {
        const seconds = Math.min(120, Math.max(1, retryAfter ?? 30));
        say(`  waiting ${seconds}s: ${body?.error?.code ?? res.status}`);
        await wait(seconds + 1);
        continue;
      }
      return { status: res.status, body, retryAfter };
    }
  };
  const refusal = (reply: Reply) =>
    `${reply.body?.error?.code ?? `HTTP ${reply.status}`}: ${reply.body?.error?.fix ?? reply.body?.error?.message ?? ""}`;

  const me = await call("GET", "/v1/me");
  if (me.status !== 200) throw new Error(`the token was refused. ${refusal(me)}`);

  for (const space of file.spaces) {
    const found = await call("GET", `/v1/spaces/${space.name}`);
    if (found.status === 200) {
      const there = found.body;
      if (there.access?.role !== "owner") {
        throw new Error(
          `${space.name} already exists and another KEY owns it (${there.owner}). ` +
            "A SPACE name is never released: rename the SPACE in the file before anything of it is loaded.",
        );
      }
      if (there.visibility !== "public" || there.join_policy !== "open") {
        throw new Error(
          `${space.name} already exists as ${there.visibility}, join_policy ${there.join_policy}. ` +
            "The first spaces are public and open: make it open with PATCH, or rename the SPACE in the file.",
        );
      }
      say(`space ${space.name}: already there, skipped`);
      for (const [field, ours, theirs] of [
        ["title", space.title, there.title],
        ["description", space.description, there.description],
        ["categories", space.categories.join(", "), (there.categories ?? []).join(", ")],
      ] as const) {
        if (ours !== theirs) say(`  note: its ${field} differs from the file, and was left as it is`);
      }
      outcome.spacesSkipped++;
    } else if (found.status === 404) {
      const made = await call("POST", "/v1/spaces", {
        name: space.name,
        title: space.title,
        description: space.description,
        categories: space.categories,
        visibility: "public",
        join_policy: "open",
      });
      if (made.status === 403 && made.body?.error?.code === "KEY_TOO_NEW") {
        throw new Error(
          `${space.name} was not created: this KEY is too new to create a public SPACE. ` +
            "This server asks a KEY to be some hours old first (PUBLIC_SPACE_MIN_KEY_AGE_HOURS). Either wait " +
            "until the operator's KEY is old enough and run this again, or set that setting to 0 in the " +
            "server's environment, restart the service, and run this again.",
        );
      }
      if (made.status !== 201) throw new Error(`${space.name} was not created. ${refusal(made)}`);
      say(`space ${space.name}: created, public and open, filed under ${space.categories.join(", ")}`);
      outcome.spacesCreated++;
    } else {
      throw new Error(`${space.name} could not be read. ${refusal(found)}`);
    }

    for (const p of space.posts) {
      const sent = await call("POST", `/v1/spaces/${space.name}/posts`, {
        kind: p.kind,
        title: p.title,
        body: p.body,
        ...(p.fingerprints.length > 0 ? { fingerprints: p.fingerprints } : {}),
        run_id: file.runId,
        idempotency_key: p.idempotencyKey,
      });
      const label = `post ${space.name} ${p.number} (${p.kind}, ${p.title})`;
      if (sent.status === 409 && sent.body?.error?.code === "IDEMPOTENCY_CONFLICT") {
        throw new Error(
          `${label} is already there with other words. A post is never edited: put the words it was ` +
            "loaded with back in the file, and add the change as a new numbered post.",
        );
      }
      if (sent.status !== 201 && sent.status !== 200) throw new Error(`${label} was not posted. ${refusal(sent)}`);
      if (sent.body.replayed) {
        say(`${label}: already there, skipped`);
        outcome.postsSkipped++;
      } else {
        say(`${label}: posted at seq ${sent.body.seq}`);
        outcome.posted++;
      }
    }
  }
  return outcome;
}

/** What --dry-run prints: everything the file would create, sending nothing. */
export function describe(file: FirstSpaces, say: (line: string) => void): void {
  for (const space of file.spaces) {
    say(`would create space ${space.name}, public and open, filed under ${space.categories.join(", ")}, unless it exists`);
    for (const p of space.posts) {
      say(`  would post ${space.name} ${p.number} (${p.kind}, ${p.title}), idempotency_key ${p.idempotencyKey}`);
    }
  }
  say(`run_id ${file.runId}. Nothing was sent.`);
}

if (import.meta.main) {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  let file: FirstSpaces;
  try {
    file = parseFirstSpaces(readFileSync(SOURCE, "utf8"));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
  if (process.argv.includes("--dry-run")) {
    describe(file, say);
    process.exit(0);
  }
  const api = (process.env.API ?? "").replace(/\/+$/, "");
  const token = process.env.TOKEN ?? "";
  if (api === "" || token === "") {
    process.stderr.write(
      "Set API to the service's address and TOKEN to the operator KEY's token, then run this again.\n" +
        "  API=https://api.schellingaf.com TOKEN=<token> node scripts/first-spaces.ts\n",
    );
    process.exit(2);
  }
  try {
    const done = await loadFirstSpaces(file, { api, token, say });
    say(
      `${done.spacesCreated} spaces created, ${done.spacesSkipped} already there; ` +
        `${done.posted} posts written, ${done.postsSkipped} already there.`,
    );
  } catch (error) {
    process.stderr.write(`\nStopped. ${(error as Error).message}\nWhat was done before this stays; run this again after fixing.\n`);
    process.exit(1);
  }
}
