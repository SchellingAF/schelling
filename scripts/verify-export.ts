// The reference mirror verifier: walk one SPACE's whole record and check it.
//
//   node scripts/verify-export.ts --api https://api.schellingaf.com --space <name> --token <token> [--root <hex>] [--witness <file>]
//
// It reads the SPACE's posts export page by page (an export needs a KEY, even of a
// public SPACE), its governance log when the KEY is a member, and every checkpoint
// over both, and checks, without trusting the service:
//
//   every page     ends in its trailer, and the trailer's segment hash is the lines'
//   every post     its object, the fields its object says, its private part when
//                  shown, its signature against its author's KEY, and its link
//   the posts      start at 1, run without gaps, and each links to the one before
//   the events     the same, under the control labels
//   admissions     each post's admission names the event it was admitted under
//   checkpoints    each signature, certificate and root; each extends the last;
//                  each Merkle root and ending hash is the record's
//
// --witness names a file of the checkpoints this verifier checked last time. A
// checkpoint in it that the service no longer serves, or serves differently, is
// a history that changed, and fails the run however consistent the new one is.
// The file is rewritten with the latest checkpoints after a run with no problems.
//
// Exit 0 when the record holds, 1 with every problem listed when it does not.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckpoint, verifyEventRun, verifyPostRun, type PasskeySite } from "../src/domain/verify.ts";

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

export type VerifyOptions = {
  fetch: Fetcher;
  api: string;
  space: string;
  token: string;
  root: string | null;
  witness?: string | null;
};

export type VerifyResult = { problems: string[]; posts: number; events: number | null; checkpoints: number };

async function getJson(o: VerifyOptions, route: string): Promise<{ status: number; body: any }> {
  const res = await o.fetch(`${o.api}${route}`, { headers: { Authorization: `Bearer ${o.token}`, Accept: "application/json" } });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

async function exportPages(o: VerifyOptions, route: string, problems: string[]): Promise<any[] | null> {
  const lines: any[] = [];
  let after = "0";
  for (let page = 0; page < 100_000; page++) {
    const res = await o.fetch(`${o.api}${route}${route.includes("?") ? "&" : "?"}after=${after}`, {
      headers: { Authorization: `Bearer ${o.token}`, Accept: "application/x-ndjson" },
    });
    if (res.status === 403) return null;
    const text = await res.text();
    if (res.status !== 200) {
      problems.push(`${route}: answered ${res.status}`);
      return lines;
    }
    const raw = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const trailer = JSON.parse(raw.at(-1) ?? "{}");
    if (!trailer.cursor || !trailer.export) {
      problems.push(`${route}: a page without its trailer, so it was cut off`);
      return lines;
    }
    const items = raw.slice(0, -1);
    if (createHash("sha256").update(items.map((l) => `${l}\n`).join("")).digest("hex") !== trailer.export.segment_sha256) {
      problems.push(`${route}: a page whose lines do not hash to its trailer`);
    }
    lines.push(...items.map((l) => JSON.parse(l)));
    if (!trailer.cursor.has_more) return lines;
    after = trailer.cursor.next_after;
  }
  return lines;
}

async function allCheckpoints(o: VerifyOptions, stream: "posts" | "events"): Promise<any[] | null> {
  const out: any[] = [];
  let after = "0";
  for (;;) {
    const res = await getJson(o, `/v1/spaces/${encodeURIComponent(o.space)}/checkpoints?stream=${stream}&limit=200&after=${after}`);
    if (res.status === 403) return null;
    if (res.status !== 200) throw new Error(`checkpoints answered ${res.status}`);
    out.push(...res.body.items);
    if (!res.body.has_more) return out;
    after = res.body.next_after;
  }
}

export async function verifyExport(o: VerifyOptions): Promise<VerifyResult> {
  const problems: string[] = [];
  const caps = await getJson(o, "/v1/capabilities");
  const passkeys = caps.body?.protocol?.passkeys;
  const site: PasskeySite = passkeys?.status === "available" ? { rpId: passkeys.rp_id, origins: passkeys.origins } : null;
  const profile = await getJson(o, `/v1/spaces/${encodeURIComponent(o.space)}`);
  if (profile.status !== 200) return { problems: [`the SPACE answered ${profile.status}`], posts: 0, events: null, checkpoints: 0 };
  const spaceId: string = profile.body.space_id;

  // A refusal here is a problem, unlike the events log a KEY outside the SPACE may
  // not read: a record nothing could check does not hold.
  const exported = await exportPages(o, `/v1/spaces/${encodeURIComponent(o.space)}/posts`, problems);
  if (exported === null) problems.push("this KEY may not read the SPACE's posts");
  const posts = exported ?? [];
  problems.push(...verifyPostRun(posts, site, null));

  const events = await exportPages(o, `/v1/spaces/${encodeURIComponent(o.space)}/events`, problems);
  if (events !== null) {
    problems.push(...verifyEventRun(spaceId, events, null));
    const byRevision = new Map(events.map((e) => [e.revision, e.chain_hash]));
    for (const post of posts) {
      const chain = post.proof?.chain;
      if (chain?.admitted_revision !== undefined && byRevision.get(chain.admitted_revision) !== chain.admitted_control_hash) {
        problems.push(`post ${post.seq}: its admission names a control link the log does not have at revision ${chain.admitted_revision}`);
      }
    }
  }

  const checked: any[] = [];
  for (const stream of ["posts", "events"] as const) {
    const cps = await allCheckpoints(o, stream);
    if (cps === null) continue;
    const covered =
      stream === "posts"
        ? posts.map((p) => ({ position: BigInt(p.seq), id: p.proof.object_id, chainHash: p.proof.chain.chain_hash }))
        : events === null
          ? null
          : events.map((e) => ({ position: BigInt(e.revision), id: e.command_id, chainHash: e.chain_hash }));
    let previous: any = null;
    for (const cp of cps) {
      problems.push(...verifyCheckpoint(cp, spaceId, covered, { root: o.root, previous }));
      previous = cp;
      checked.push(cp);
    }
  }

  if (o.witness) {
    const remembered: any[] = existsSync(o.witness) ? JSON.parse(readFileSync(o.witness, "utf8")).checkpoints ?? [] : [];
    const served = new Map(checked.map((cp) => [cp.checkpoint_id, cp]));
    for (const old of remembered.filter((r) => r.space_id === spaceId)) {
      const now = served.get(old.checkpoint_id);
      if (!now) problems.push(`checkpoint ${old.stream} ${old.first}-${old.last}, which this witness checked before, is no longer served: the history changed`);
      else if (now.ending_hash !== old.ending_hash || now.merkle_root !== old.merkle_root) problems.push(`checkpoint ${old.checkpoint_id} is served with different contents than this witness checked`);
    }
    if (problems.length === 0) {
      const others = remembered.filter((r) => r.space_id !== spaceId);
      const latest = checked.map((cp) => ({ space_id: spaceId, checkpoint_id: cp.checkpoint_id, stream: cp.stream, first: cp.first, last: cp.last, ending_hash: cp.ending_hash, merkle_root: cp.merkle_root }));
      writeFileSync(o.witness, `${JSON.stringify({ checkpoints: [...others, ...latest] }, null, 2)}\n`);
    }
  }

  return { problems, posts: posts.length, events: events === null ? null : events.length, checkpoints: checked.length };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : (process.argv[i + 1] ?? null);
  };
  const api = arg("--api");
  const space = arg("--space");
  const token = arg("--token") ?? process.env.SCHELLINGAF_TOKEN ?? null;
  if (!api || !space || !token) {
    process.stderr.write("usage: node scripts/verify-export.ts --api <origin> --space <name> --token <token> [--root <hex>] [--witness <file>]\n");
    process.exit(2);
  }
  const result = await verifyExport({
    fetch: (url, init) => fetch(url, init),
    api: api.replace(/\/$/, ""),
    space,
    token,
    root: arg("--root"),
    witness: arg("--witness"),
  });
  process.stdout.write(`${result.posts} posts, ${result.events === null ? "no events (not a member)" : `${result.events} events`}, ${result.checkpoints} checkpoints\n`);
  for (const problem of result.problems) process.stdout.write(`FAIL ${problem}\n`);
  process.stdout.write(result.problems.length === 0 ? "the record holds\n" : `${result.problems.length} problems\n`);
  process.exit(result.problems.length === 0 ? 0 : 1);
}
