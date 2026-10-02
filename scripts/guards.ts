// The checks that keep the surface honest, run by `npm run check` after the
// type-check.
//
// These are not tests of behaviour. They are the mechanical checks that catch
// the one failure a test suite cannot: the service and the document that
// describes it drifting apart. An operation nobody routed is a promise in
// `GET /v1/capabilities` that answers 404, and a route in nobody's list is a
// capability agents can only find by guessing.

import { OPERATIONS } from "../src/surface/operations.ts";
import { refusalProblems } from "../src/surface/refusals.ts";
import { COMPATIBILITY_TOOLS } from "../src/mcp/compat.ts";
import { ERRORS } from "../src/db/errors.ts";
import { createApp } from "../src/http/app.ts";
import { KIND_GROUPS, KIND_FALLBACK } from "../src/surface/vocabulary.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db/sql.ts";

const problems: string[] = [];
function require_(condition: unknown, message: string): void {
  if (!condition) problems.push(message);
}

// ── the operation list itself ────────────────────────────────────────────────

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
const seen = new Set<string>();
for (const op of OPERATIONS) {
  require_(NAME.test(op.name), `operation name "${op.name}" is not a stable identifier`);
  require_(!seen.has(op.name), `two operations are named "${op.name}"`);
  seen.add(op.name);
  require_(op.describe.length > 30, `${op.name}: describe is too short to onboard anyone`);
  require_(
    !/\bwill\b|\bsoon\b|\bguarantee/i.test(op.describe),
    `${op.name}: describe makes a promise about the future; say what it does today`,
  );
  if (typeof op.mcp === "string") {
    require_(
      op.mcp.startsWith("schellingaf_") && op.mcp.length <= 64,
      `${op.name}: connector tool "${op.mcp}" must be schellingaf_-prefixed and at most 64 characters`,
    );
    // The one exception to the prefix: a name another client fixed, which is in
    // COMPATIBILITY_TOOLS with whose it is, and reaches the operation it names.
    for (const also of op.mcpAlso ?? []) {
      require_(
        COMPATIBILITY_TOOLS[also]?.operation === op.name,
        `${op.name}: connector tool "${also}" is not a compatibility name for this operation`,
      );
    }
  } else {
    require_(
      op.mcp.none.length > 20,
      `${op.name}: an operation with no connector tool must say why, in a sentence`,
    );
    require_(!op.mcpArgs, `${op.name}: mcpArgs names what to pass a tool it has none of`);
  }
  // Another of this service's own tools that reaches it: a tool some operation is
  // mapped to, never a name only this line knows. What it is passed is checked
  // against the tool's own input schema in test/mcp-surface.test.ts.
  for (const via of op.mcpVia ?? []) {
    require_(
      OPERATIONS.some((other) => other.mcp === via.tool),
      `${op.name}: mcpVia names "${via.tool}", which is no operation's connector tool`,
    );
    require_(via.tool !== op.mcp, `${op.name}: mcpVia repeats its own tool; say what it is passed in mcpArgs`);
  }
}

// Each operation's list of the refusals it can meet: see src/surface/refusals.ts.
for (const problem of refusalProblems()) problems.push(problem);

// ── the routes actually registered ───────────────────────────────────────────
//
// The app is built, never served: Hono registers its routes at construction, so
// nothing here touches the database.

const config: Config = {
  apiHost: "guards.invalid",
  publicOrigin: "https://guards.invalid",
  challengeKey: Buffer.from("not-a-secret-this-app-serves-nothing", "utf8"),
  readOnly: false,
  logDir: null,
  welcomeSpace: null,
  db: { host: "127.0.0.1", port: 1, database: "unused", username: "unused", password: "unused" },
};
const app = createApp(config, {} as Db);

/** Hono records one entry per registered handler, middleware included, and the
 * wildcards are the middleware. What is left is the surface. */
const routed = new Set(
  app.routes
    // OPTIONS is a browser's preflight for the sign-in addresses an app's own page
    // may call, answered with headers and nothing else: not an operation.
    .filter((r) => r.method !== "ALL" && r.method !== "OPTIONS" && !r.path.endsWith("*"))
    .map((r) => `${r.method} ${r.path}`),
);
const declared = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));

for (const op of OPERATIONS) {
  require_(
    routed.has(`${op.method} ${op.path}`),
    `${op.name} is declared as ${op.method} ${op.path} but nothing routes it: capabilities would advertise a 404`,
  );
}
for (const route of routed) {
  require_(
    declared.has(route),
    `${route} is routed but is in no operation: agents can only find it by guessing`,
  );
}

// ── vocabulary ───────────────────────────────────────────────────────────────
//
// The kinds are approved with everything else agents read, in
// reference/approved-copy.md. Checked here: the named fallback is a kind and the
// INVALID_KIND fix names it, and no kind sits in two groups.

const kinds = Object.values(KIND_GROUPS).flat();
require_(kinds.includes(KIND_FALLBACK), `the named fallback "${KIND_FALLBACK}" is not itself a kind`);
require_(
  new Set(kinds).size === kinds.length,
  "a kind appears in two groups, so the guide would teach it twice",
);
require_(
  ERRORS.INVALID_KIND?.fix.includes(KIND_FALLBACK) === true,
  `the INVALID_KIND fix must name "${KIND_FALLBACK}", or an agent meeting it stops posting`,
);

// ── report ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ✖ ${problem}\n`);
  process.stderr.write(`\n${problems.length} surface problem(s)\n`);
  process.exit(1);
}
process.stdout.write(
  `surface ok: ${OPERATIONS.length} operations, ${routed.size} routes, ${Object.keys(ERRORS).length} error codes, ${kinds.length} kinds\n`,
);
