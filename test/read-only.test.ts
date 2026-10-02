// Every write is refused while a restore is in progress.
//
// `READ_ONLY=1` is what the restore runbook sets before it touches anything, and
// the whole point of it is that nothing can be written to a database that is
// about to be replaced by an older copy. A write that slips through is a write
// the restore then loses, silently, after the service has already told an agent
// it succeeded.
//
// One gate in app.ts refuses every /v1 operation that is not a GET, the two
// challenges apart; the OAuth writes, outside /v1, refuse in oauth/routes.ts
// themselves. This test does not name routes: it walks the operations table, the
// service's own list of everything it serves, and requires that every one that
// can change the database is refused, so a route added later is covered the day
// it is added.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { useService, db, config, agent, call, send, type App } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { OPERATIONS } from "../src/surface/operations.ts";

let closed: App;
let token: string;

const ready = useService("read_only");
before(async () => {
  await ready;
  closed = createApp({ ...config, readOnly: true }, db);
  // A KEY, minted while writes are still allowed.
  token = (await agent()).token;
});

/** A path with its parameters filled in by something syntactically valid. What
 * the value names need not exist: a route that refuses for the right reason
 * refuses before it looks anything up, and one that does not is the bug. */
const PARAMETERS: Record<string, string> = {
  name: "any-space-name",
  peer: "ab".repeat(32),
  id: "01890000-0000-7000-8000-000000000000",
  generation: "2",
  seq: "1",
  number: "1",
  sha256: "a".repeat(64),
};

function fill(path: string): string {
  return path.replace(/:([a-z_][a-z0-9_]*)/g, (_, name: string) => {
    const value = PARAMETERS[name];
    if (value === undefined) throw new Error(`no value to fill :${name} with`);
    return value;
  });
}

/** The two POSTs that may still answer. A challenge mints nothing: it is an HMAC
 * over bytes the caller supplied, and it creates no PEER and no token. It does
 * debit its rate-limit buckets, so it is not strictly read-only, but a bucket that
 * reverts in a restore refills to a more generous state than it left, and refusing
 * challenges would stop an agent finding out the service is up. Minting a token
 * with either is refused. */
const CHALLENGES = new Set(["/v1/keys/challenge", "/v1/passkeys/challenge"]);

describe("while a restore is in progress", () => {
  const mutating = OPERATIONS.filter((o) => o.method !== "GET" && !CHALLENGES.has(o.path));

  test("the operations table actually contains writes to check", () => {
    // Guards the guard: a filter that silently matched nothing would make every
    // assertion below vacuous and this file would pass while testing nothing.
    assert.ok(mutating.length >= 12, `only ${mutating.length} mutating operations found`);
  });

  for (const op of mutating) {
    test(`${op.method} ${op.path} is refused`, async () => {
      const res = await send(closed, op.method, fill(op.path), token, {});
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(
        body.error?.code,
        "SERVICE_READ_ONLY",
        `${op.method} ${op.path} answered ${res.status} ${body.error?.code} during a restore`,
      );
      assert.equal(res.status, 503);
    });
  }

  test("a challenge still answers, because it mints nothing", async () => {
    const raw = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const res = await call("POST", "/v1/keys/challenge", null, { public_key: raw.toString("hex") }, closed);
    assert.equal(res.status, 200);
  });

  test("and reads still work, which is the whole point of the flag", async () => {
    const res = await call("GET", "/v1/me", token, undefined, closed);
    assert.equal(res.status, 200);
  });
});
