// One clone of the migrated template per test file, plus the two connections
// every test needs: the owner (which bypasses nothing because it owns
// everything) and the api role (which is the one the service actually uses).
// A file that talks to the service builds it on this with lib/service.ts.

import postgres from "postgres";
import { before } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { API_PASSWORD, PORT, SUPERUSER, TEMPLATE_DB } from "./bootstrap.ts";
import { KIND_GROUPS, KINDS } from "../src/surface/vocabulary.ts";

export type Fixture = {
  name: string;
  owner: postgres.Sql;
  api: postgres.Sql;
  /** Run a read as the api role with a caller bound for the transaction, which
   * is exactly how the service reads. Pass null for an anonymous caller. */
  asCaller<T>(peerIdHex: string | null, fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
  /** Set a rate bucket's balance as of now, for a test that needs an allowance
   * spent (0, or far below it) or restored. The key is the bucket's own,
   * such as `rcpt:<peer id>`. */
  setBucket(key: string, tokens: number): Promise<void>;
  end(): Promise<void>;
};

let counter = 0;

export async function cloneDatabase(label: string): Promise<Fixture> {
  const name = `schellingaf_t_${label}_${process.pid}_${counter++}`;
  const admin = postgres(SUPERUSER);
  try {
    await admin.unsafe(`create database ${name} template ${TEMPLATE_DB} owner schellingaf_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const common = { host: "127.0.0.1", port: PORT, database: name, max: 4, onnotice: () => {} };
  const owner = postgres({
    ...common,
    username: "schellingaf_migrate",
    password: "test_migrate_password_not_a_secret",
  });
  // The migrate role is a member of the owner role, so it can call the internal
  // functions a test needs to set a scene. The api connection below is the one
  // under test.
  await owner`set role schellingaf_owner`;

  const api = postgres({ ...common, username: "schellingaf_api", password: API_PASSWORD });

  return {
    name,
    owner,
    api,
    async asCaller(peerIdHex, fn) {
      return api.begin(async (tx) => {
        await tx`select set_config('schellingaf.peer_id', ${peerIdHex ?? ""}, true)`;
        return fn(tx as unknown as postgres.Sql);
      }) as Promise<Awaited<ReturnType<typeof fn>>>;
    },
    async setBucket(key, tokens) {
      await owner`
        insert into schellingaf.rate_buckets (key, tokens, updated_at)
        values (${key}, ${tokens}, now())
        on conflict (key) do update set tokens = ${tokens}, updated_at = now()`;
    },
    async end() {
      await owner.end({ timeout: 5 });
      await api.end({ timeout: 5 });
      const cleanup = postgres(SUPERUSER);
      try {
        await cleanup.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

/**
 * A file's own top-level before hook, for a file not on lib/service.ts, and a promise
 * that settles once the hook has finished, whether it passed or failed. The file's
 * after hook awaits it first: with no test selected (a --test-name-pattern matching
 * none of the file's) node:test runs the after hook without waiting for the before
 * hook, and what the before hook then opened kept the file running until it was killed.
 */
export function setUp(open: () => Promise<void>): Promise<void> {
  const finished = Promise.withResolvers<void>();
  before(async () => {
    try {
      await open();
    } finally {
      finished.resolve();
    }
  });
  return finished.promise;
}

/**
 * The category a test SPACE is filed under when its test names none. No SPACE is
 * created without one to three categories; a test about something else should not
 * have to say which.
 */
export const TEST_CATEGORY = "general";

/**
 * The title a test POST carries when its test names none. Every kind but the coordination
 * group's needs one (TITLE_REQUIRED); a test about something else should not have to say it.
 */
export const TEST_TITLE = "A POST in a test";

const UNTITLED_KINDS: readonly string[] = KIND_GROUPS.coordination;

/**
 * An unsigned, unsealed POST of a kind that needs a title, given TEST_TITLE when it names
 * no title at all. A body that names one, null included, a signed or sealed one, and one
 * whose kind is no kind are left as they are, so a test of the refusal still meets it.
 */
export function titled(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if ("title" in b || "canonical" in b || "sealed" in b) return body;
  if (typeof b.kind !== "string" || !KINDS.includes(b.kind) || UNTITLED_KINDS.includes(b.kind)) return body;
  return { ...b, title: TEST_TITLE };
}

/**
 * A request body as tests send it: TEST_CATEGORY added when the request creates a SPACE
 * and names no categories of its own, a create's version and a POST given TEST_TITLE as
 * titled() says. Every file's request helper passes its body through here, so a test
 * that means to send none (test/categories.test.ts, the title refusals) sends it some
 * other way.
 */
export function filed(method: string, path: string, body: unknown): unknown {
  if (method !== "POST" || typeof body !== "object" || body === null || Array.isArray(body)) return body;
  if (/^\/v1\/spaces\/[^/?]+\/posts(\?.*)?$/.test(path)) return titled(body);
  if (path !== "/v1/spaces") return body;
  let out = body as Record<string, unknown>;
  if (!("categories" in out)) out = { ...out, categories: [TEST_CATEGORY] };
  if (typeof out.version === "object" && out.version !== null && !Array.isArray(out.version) && !("title" in out.version)) {
    out = { ...out, version: { ...out.version, title: TEST_TITLE } };
  }
  return out;
}

/**
 * A connector call's parameters as tests send them: schellingaf_post's arguments
 * titled() as a POST's body is, and schellingaf_oracle's propose given TEST_TITLE as its
 * summary when it names none.
 */
export function filedTool(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params;
  const p = params as { name?: unknown; arguments?: unknown };
  if (p.name === "schellingaf_post") return { ...p, arguments: titled(p.arguments) };
  if (p.name === "schellingaf_oracle" && typeof p.arguments === "object" && p.arguments !== null) {
    const args = p.arguments as Record<string, unknown>;
    if (args.action === "propose" && !("summary" in args)) return { ...p, arguments: { ...args, summary: TEST_TITLE } };
  }
  return params;
}

/** A public key is any 32 bytes as far as the database is concerned; verifying
 * that it is a real curve point is the API's job, not the schema's. */
export function publicKey(seed?: string): Buffer {
  if (seed === undefined) return randomBytes(32);
  return createHash("sha256").update(seed).digest();
}

export function peerIdOf(publicKeyBytes: Buffer): string {
  const label = Buffer.concat([Buffer.from("agent-state:agent:v1", "utf8"), Buffer.from([0])]);
  return createHash("sha256").update(Buffer.concat([label, publicKeyBytes])).digest("hex");
}
