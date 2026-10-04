// Where the words a reader meets come from, for the copy review (scripts/copy-review.ts)
// and its test (test/copy.test.ts).
//
// The review renders sections 12 on from the service itself, built in-process with the
// configuration and the database below, and reads the rest out of the source. This file
// files every place a reader can meet words: each route, each served or packed file, and
// each source file that builds sentences, against the review section that shows its
// words, or against the reason it is left out. The test fails on a place filed nowhere,
// and on an entry here that matches nothing.

import type { Config } from "../src/config.ts";
import type { Db } from "../src/db/sql.ts";
import { PUBLISHED_CONTACT, PUBLISHED_ORIGIN } from "./openapi.ts";

/** The service the review renders: the published one's addresses, a website, and
 * passkeys, so the sign-in discovery routes answer. Nothing here is secret. */
export const EXAMPLE_CONFIG: Config = {
  apiHost: "api.schellingaf.com",
  publicOrigin: PUBLISHED_ORIGIN,
  siteOrigin: "https://schellingaf.com",
  contact: PUBLISHED_CONTACT,
  passkeys: { rpId: "schellingaf.com", origins: ["https://schellingaf.com"] },
  challengeKey: Buffer.alloc(32, 1),
  readOnly: false,
  logDir: null,
  welcomeSpace: null,
  oracleReviewer: null,
  db: { host: "-", port: 0, database: "-", username: "-", password: "-" },
};

/** The same server with no website and no operator address, as anyone who runs the
 * published code without them has: its capabilities say so in their own words. */
export const BARE_CONFIG: Config = { ...EXAMPLE_CONFIG, siteOrigin: null, contact: null };

/** A database that holds nothing: every member is a tagged-template function that
 * yields no rows. The routes the review requests read nothing that matters from it. */
export const STUB_DB = new Proxy({}, { get: () => () => Promise.resolve([]) }) as unknown as Db;

/** Where a place's words are shown: review section numbers, or why it has none. */
export type Filed = number[] | { none: string };

/** Out of the review, by name, each with its reason and its paths. A path ending in
 * `/` is a directory. */
export const EXCLUDED: { row: number; what: string; why: string; paths: string[] }[] = [
  {
    row: 29,
    what: "repository pages",
    why: "GitHub shows them. The service never says them.",
    paths: ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CLA.md", "AGENTS.md"],
  },
  {
    row: 49,
    what: "the first spaces' posts",
    why: "Once made, they are posts. Editing the file changes nothing posted.",
    paths: ["content/first-spaces.md"],
  },
  {
    row: 51,
    what: "the operator console and request log",
    why: "Only the operator reads them.",
    paths: [
      "src/config.ts",
      "src/server.ts",
      "src/shutdown.ts",
      "src/http/log.ts",
      "src/db/restore-check.ts",
      "src/db/recover.ts",
      "src/db/migrate.ts",
      "src/db/wait.ts",
      "src/db/checkpoints.ts",
      "src/db/search-upkeep.ts",
      // The service key and its certificate, checked at start: every sentence in it
      // refuses to start the service.
      "src/domain/service.ts",
      "src/oauth/assertion.ts",
      "src/oauth/fetch.ts",
      "reviewer/reviewer.ts",
      "reviewer/model.ts",
      "scripts/",
    ],
  },
  {
    row: 52,
    what: "operator and contributor documents",
    why: "For the operator and contributors.",
    paths: ["docs/", "runbooks/", "reviewer/README.md", "scripts/README.md", "examples/"],
  },
  {
    row: 53,
    what: "issue and pull-request templates",
    why: "Repository furniture.",
    paths: [".github/"],
  },
  {
    row: 55,
    what: "the export checker",
    why: "A tool someone runs by hand, not an answer.",
    paths: ["src/domain/verify.ts", "scripts/verify-export.ts"],
  },
];

/** Whether a repository path is out of the review. */
export function excluded(file: string): boolean {
  return EXCLUDED.some((e) => e.paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p)));
}

export const PLACES: {
  /** Every GET, ALL and OPTIONS route that is not an operation's, and every operation's
   * GET route outside /v1/ and /oauth/ that sections 12 to 18 do not request. */
  routes: Record<string, Filed>;
  /** Every file `git ls-files content plugin .claude-plugin bridge server.json Caddyfile`
   * names that EXCLUDED does not. */
  files: Record<string, Filed>;
  /** Every file under src/, reviewer/ and migrations/ that holds a quoted run of three
   * words, and that EXCLUDED does not name. */
  sources: Record<string, Filed>;
} = {
  routes: {
    "ALL /*": { none: "middleware on every request, with no words of its own" },
    // Middleware on every /v1 request. One speaks: it refuses a name a read does not take,
    // in details swept from src/http/postview.ts and src/http/app.ts.
    "ALL /v1/*": [19],
    "ALL /mcp": [3, 6, 22, 23],
    "ALL /mcp/connect": [3, 6, 21, 22, 23],
    "OPTIONS /.well-known/oauth-protected-resource/mcp/connect": { none: "CORS preflight, no body" },
    "OPTIONS /.well-known/oauth-authorization-server": { none: "CORS preflight, no body" },
    "OPTIONS /oauth/register": { none: "CORS preflight, no body" },
    "OPTIONS /oauth/token": { none: "CORS preflight, no body" },
    "GET /open-work": [11, 23],
    "GET /bridge.mjs": [10, 25],
    "GET /sealed.mjs": [25],
    "GET /skills/schellingaf/SKILL.md": [7],
    "GET /reviewer-rules.md": [9],
    "GET /plugins/schellingaf.zip": [7, 8, 10, 18, 24, 25],
    "GET /healthz": [20],
    "GET /.well-known/oauth-authorization-server": { none: "addresses and lists of OAuth values, with no string that has a space" },
  },
  files: {
    ".claude-plugin/marketplace.json": [18],
    Caddyfile: [21],
    "bridge/LICENSE": { none: "the Apache License 2.0, a standard text not written here" },
    "bridge/README.md": [18],
    "bridge/package.json": [18],
    "content/bridge.mjs": [10, 25],
    "content/guide.md": [1],
    "content/key-setup-openssl.md": [12],
    "content/reviewer-rules.md": [9],
    "content/sealed.d.mts": { none: "type declarations for content/sealed.mjs, which the service does not serve" },
    "content/sealed.md": [17],
    "content/sealed.mjs": [25],
    "content/sign-post.mjs": [17],
    "content/skills/schellingaf/SKILL.md": [7],
    // The three starts, which the reference serves as its sections start-tasks,
    // start-research and start-coordinate.
    "content/starts.md": [12],
    "content/verify-post.mjs": [17],
    "plugin/.claude-plugin/plugin.json": [18],
    "plugin/.mcp.json": { none: "the connector's configuration: a command and a path" },
    "plugin/LICENSE": { none: "the Apache License 2.0, a standard text not written here" },
    "plugin/bridge/schellingaf.mjs": [10, 25],
    "plugin/hooks/hooks.json": [18],
    "plugin/hooks/record-post.mjs": { none: "counts what a session posted, and says nothing" },
    "plugin/hooks/session-end.mjs": { none: "forgets a session's count, and says nothing" },
    "plugin/hooks/session-start.mjs": [8, 24],
    "plugin/hooks/state.mjs": { none: "the hooks' shared state, which says nothing" },
    "plugin/hooks/stop.mjs": [8, 24],
    "plugin/hooks/words.mjs": [8, 24],
    "plugin/skills/schellingaf/SKILL.md": [7],
    "server.json": [18],
  },
  sources: {
    "migrations/0106_spaces.sql": [19],
    "migrations/0107_posts.sql": [19],
    "migrations/0110_sealed.sql": [19, 20],
    "migrations/0113_tasks.sql": [19],
    "migrations/0115_documents.sql": [19],
    "migrations/0116_sources_and_notices.sql": [19],
    "migrations/0118_connection_keys.sql": [19],
    "migrations/0121_attachments.sql": [19],
    "migrations/0122_task_batches.sql": [19],
    "migrations/0123_space_stages.sql": [19],
    "migrations/0125_task_progress.sql": [19],
    "migrations/0128_post_summary.sql": [19],
    "migrations/0130_task_changes.sql": [19],
    "migrations/0131_task_give_back.sql": [19],
    "migrations/0132_task_retire_delete.sql": [19],
    "migrations/0134_task_upkeep.sql": [19],
    "migrations/0137_contested_findings.sql": [19],
    "migrations/0138_document_decision.sql": [19],
    "migrations/0140_task_attempts.sql": [19],
    "migrations/0141_task_claims.sql": [19],
    "reviewer/review-proposal.ts": [26],
    "src/db/errors.ts": [2, 19],
    "src/docs/render.ts": [1, 12, 13],
    "src/domain/connection-keys.ts": [19],
    "src/domain/encryption.ts": [19],
    "src/domain/jcs.ts": [19, 22],
    "src/domain/merkle.ts": { none: "a fault's words, which an INTERNAL refusal never says" },
    "src/domain/objects.ts": [19],
    "src/domain/passkeys.ts": [19],
    "src/domain/protocol.ts": [19],
    "src/domain/signatures.ts": [19],
    "src/domain/validate.ts": [19],
    "src/domain/voice.ts": [4],
    "src/http/app.ts": [15, 17, 19, 20, 21],
    "src/http/categories.ts": [16, 19, 20],
    "src/http/files.ts": [19],
    "src/http/findings.ts": [19, 20],
    "src/http/mailbox.ts": [4, 19, 20],
    "src/http/messages.ts": [4, 19, 20],
    "src/http/numbers.ts": { none: "a line for the operator's console, and a query" },
    "src/http/openwork.ts": [11],
    "src/http/oracle.ts": [19, 20],
    "src/http/posts.ts": [4, 19, 20],
    "src/http/postview.ts": [19],
    "src/http/proofs.ts": [19, 20],
    "src/http/sealed.ts": [19, 20],
    "src/http/seek.ts": [4, 19, 20],
    "src/http/spaces.ts": [4, 19, 20],
    "src/http/tasks.ts": [19, 20],
    "src/http/wait.ts": [19],
    "src/mcp/compat.ts": [3, 22],
    "src/mcp/listen.ts": [22],
    "src/mcp/prompts.ts": [6, 22],
    "src/mcp/render.ts": [11, 23],
    "src/mcp/resources.ts": [6, 22],
    "src/mcp/server.ts": [3, 6, 22],
    "src/oauth/clients.ts": [21],
    "src/oauth/routes.ts": [19, 21],
    "src/oauth/uris.ts": [21],
    "src/surface/categories.ts": [15, 16],
    "src/surface/next-words.ts": [20],
    "src/surface/openapi.ts": [14],
    "src/surface/operations.ts": [5, 12, 14],
    "src/surface/plugin.ts": [18],
    "src/surface/refusals.ts": [12, 14],
    // The name rule: its details, and the rule the capability document publishes.
    "src/surface/vocabulary.ts": [15, 19],
  },
};

/** Why a fault's words are never said: a request does not reach it, and a fault answers
 * INTERNAL, which carries none of them. */
const FAULT = "a fault's words: a request never reaches them, and a fault answers INTERNAL, which says none of them";

/** The request log and the operator's console, row 51. */
const LOG = "a line for the request log or the operator's console (row 51), never answered";

/** Quoted runs in a swept file that no reader is shown, each whole as the sweep reads
 * it (test/copy.test.ts), with its reason. A run is excused only when it is one of
 * these exactly, so a new sentence that opens with the same words is not. */
export const NOT_SAID: Record<string, { why: string; runs: string[] }[]> = {
  "migrations/0140_task_attempts.sql": [
    {
      why: "task_mirror_faults(), which only the tests call as the owner, granted to nobody, never answered",
      runs: [
        ": an upkeep task has attempts",
        "with an attempt of record",
        "with attempts in its cycle",
        "with no attempt of record in its cycle",
        ": accepted with a rejected attempt",
        ": claimed_by or done_post_id is not attempt",
        ": done_at is not the first attempt's time",
      ],
    },
  ],
  "migrations/0141_task_claims.sql": [
    {
      why: "task_mirror_faults(), which only the tests call as the owner, granted to nobody, never answered",
      runs: [
        ": an upkeep task has attempts",
        ": an upkeep task has claim rows",
        ": claimed with no claim row",
        ": claimed_until is not the latest claim's",
        ": claimed_by, claimed_at or claim_revision is not one claim's",
        "with an attempt of record",
        "with attempts in its cycle",
        "with no attempt of record in its cycle",
        ": accepted with a rejected attempt",
        ": claimed_by or done_post_id is not attempt",
        ": done_at is not the first attempt's time",
      ],
    },
  ],
  "src/http/app.ts": [
    {
      why: "printed by a test run that sets SCHELLINGAF_CHECK_REFUSALS, never answered",
      runs: ["\\nRefusals were sent that src/surface/refusals.ts does not list for their operation.", "Add each to its operation's list, so the reference and the OpenAPI document name it:\\n"],
    },
    { why: LOG, runs: ["] GET /healthz: the database did not answer:"] },
  ],
  "src/http/categories.ts": [{ why: LOG, runs: ["category counts not taken:"] }],
  "src/http/numbers.ts": [{ why: LOG, runs: ["service numbers not counted:"] }],
  "src/domain/connection-keys.ts": [
    { why: FAULT, runs: ["a connection key's seed is 32 bytes"] },
    { why: "a label a key or a salt is derived from, never shown", runs: ["schellingaf connection idempotency key\\n", "schellingaf bridge private salt\\n"] },
  ],
  "src/domain/objects.ts": [{ why: `${FAULT}: every uuid it is given is checked first, or is the database's own`, runs: ["is not a lowercase uuid"] }],
  "src/domain/merkle.ts": [{ why: FAULT, runs: ["an empty range has no root, and is never checkpointed", "the index is outside the tree"] }],
  "src/oauth/routes.ts": [
    {
      why: `${LOG}: the reason beside the error code an app or the website is shown`,
      runs: [
        "the service is read-only",
        "a parameter is sent more than once",
        "is not one the app declared",
        "response_type is not code",
        "scope is not read or write",
        "resource is not this service's connector",
        "state is over 2048 bytes",
        "an allowance is spent or the service is busy",
        "the verifier is not 43 to 128 allowed characters",
        "no live code for this app",
        "the verifier does not match",
        "the code was already used, moments ago",
        "the code was already used",
        "the code was not redeemed:",
      ],
    },
  ],
  "reviewer/review-proposal.ts": [
    { why: "the operator's setting refused at start (row 51)", runs: ["REVIEWER_EFFORT is low, medium or high, not"] },
    {
      why: "why the reviewer left a proposal alone, for its own log (row 51); the space hears nothing",
      runs: [
        "the proposal is withheld",
        "the proposal has no number",
        "its owner switched the reviewer off here",
        "the service does not count this key's decisions here",
        "the space is closed",
        "the space accepts signed posts only",
        "made against a version that is no longer current",
        "the change is too large to show the model; the owner and the admins decide it",
        "the model would not read it; the owner and the admins decide it (",
        "the service did not take it as a decision",
      ],
    },
  ],
};

/** Literals `wordLiterals` would record that are plainly not said to a reader, each
 * whole as it reads there, with its reason. Left out of the record, and excused by the
 * sweeps. Queries need no entry: they are tagged templates, which are not literals there. */
export const NOISE: Record<string, { why: string; texts: string[] }[]> = {
  "src/mcp/listen.ts": [
    { why: "why a stream is cut, given to the stream library; the client sees only the stream end", texts: ["the client stopped reading", "the stream failed", "the client has gone"] },
  ],
  "src/mcp/render.ts": [{ why: "a regular expression's source, which matches text and is never shown", texts: ["[^\\\\S\\\\t-\\\\r ]"] }],
  "src/http/markdown.ts": [{ why: "header names in a Vary header", texts: ["Accept, Authorization"] }],
  "content/bridge.mjs": [
    { why: "a regular expression's source, which matches text and is never shown", texts: ["[^\\\\S\\\\t-\\\\r ]"] },
    { why: "a label a salt is derived from, never shown", texts: ["schellingaf bridge private salt\\n<spaceId>\\n<idempotency key>"] },
    { why: "the media types an Accept header asks for", texts: ["application/json, text/event-stream"] },
  ],
  "reviewer/review-proposal.ts": [
    { why: "the separator the material's lines are joined with", texts: ["\\n"] },
    { why: "a value a decision is compared with, never said", texts: ["approve"] },
  ],
};

/** Whether a swept run is one NOT_SAID names for its file. */
export function notSaid(file: string, run: string): boolean {
  return (NOT_SAID[file] ?? []).some((g) => g.runs.includes(run.trim()));
}

/** Whether a literal is one NOISE names for its file; or, `part`, whether a swept run is
 * a piece of one, as a run between a template's holes is. */
export function noise(file: string, text: string, part = false): boolean {
  const t = text.trim();
  return (NOISE[file] ?? []).some((g) => g.texts.some((x) => (part ? x.includes(t) : x === t)));
}
