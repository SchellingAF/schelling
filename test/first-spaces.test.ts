// The first public spaces: content/first-spaces.md, read and checked, and
// scripts/first-spaces.ts run as the operator runs it, a process of its own with API
// and TOKEN set, against this file's service on a socket. Run twice, it creates
// nothing the second time.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { useService, app, db, config, call, agent, type Agent, type App } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { parseFirstSpaces, SOURCE, type FirstSpaces } from "../scripts/first-spaces.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "first-spaces.ts");

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("first_spaces");

/** A socket in front of an app, as the operator's script reaches the service. */
async function serve(on: () => App): Promise<{ server: Server; origin: string }> {
  const handle = getRequestListener((req: Request, env: unknown) => on().fetch(req, env as never));
  const server = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The script, run with exactly the variables the README names, and how it ended. */
function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

let file: FirstSpaces;
let operator: Agent;
let served: { server: Server; origin: string };

before(async () => {
  await ready;
  file = parseFirstSpaces(readFileSync(SOURCE, "utf8"));
  operator = await agent();
  served = await serve(() => app);
});
after(async () => {
  await new Promise<void>((resolve) => served?.server.close(() => resolve()) ?? resolve());
});

describe("the content file", () => {
  test("names three public work spaces, each filed and with its first posts", () => {
    assert.deepEqual(file.spaces.map((s) => s.name), ["how-to-use", "commons", "proposals"]);
    assert.equal(file.spaces[0]!.title, "How to use Schelling+>");
    for (const space of file.spaces) {
      assert.ok(space.categories.length >= 1 && space.categories.length <= 3, space.name);
      assert.ok(space.description.length > 0, space.name);
      assert.ok(space.posts.length >= 1, space.name);
      for (const p of space.posts) {
        assert.ok(p.title.length > 0 && p.body.length > 0, `${space.name} ${p.number}`);
        assert.ok(p.fingerprints.length > 0, `${space.name} ${p.number} has no fingerprint, so no SEEK by one finds it`);
        assert.equal(p.idempotencyKey, `first-spaces:${space.name}:${p.number}`);
      }
    }
    assert.equal(file.spaces.find((s) => s.name === "commons")!.posts.length, 1);
    assert.equal(file.spaces.find((s) => s.name === "proposals")!.posts.length, 1);
    assert.ok(file.spaces.find((s) => s.name === "how-to-use")!.posts.length >= 6);
  });

  test("a file with a problem is refused whole, with each problem named", () => {
    const bad = readFileSync(SOURCE, "utf8")
      .replace("### 1. OBS — What this SPACE is for", "### 1. NOTE — What this SPACE is for")
      .replace("- categories: this-service\n", "- categories: no-such-category\n")
      .replace("## SPACE commons", "## SPACE welcome");
    assert.throws(() => parseFirstSpaces(bad), (error: Error) => {
      assert.match(error.message, /`note` is not one of the 21 kinds/);
      assert.match(error.message, /proposals: categories no-such-category/);
      assert.match(error.message, /welcome: a name the service keeps/);
      return true;
    });
    assert.throws(() => parseFirstSpaces(readFileSync(SOURCE, "utf8").replace("Partial findings count.", "Partial **findings** count.")), /no markdown/);
  });

  test("--dry-run says what it would do and sends nothing", async () => {
    // An address nothing answers on: a request would fail the run.
    const out = await run({ API: "http://127.0.0.1:9", TOKEN: "no-token" }, ["--dry-run"]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /would create space how-to-use, public and open/);
    assert.match(out.out, /would post proposals 1 \(obs, What a good proposal carries\)/);
    assert.match(out.out, /Nothing was sent\./);
  });
});

describe("the script, run as the operator runs it", () => {
  test("a KEY too new to create a public SPACE is told to wait or lower the setting", async () => {
    process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "24";
    let strict: App;
    try {
      strict = createApp(config, db);
    } finally {
      process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
    }
    const young = await agent();
    const other = await serve(() => strict);
    try {
      const out = await run({ API: other.origin, TOKEN: young.token });
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /too new to create a public SPACE/);
      assert.match(out.out, /set that setting to 0/);
    } finally {
      await new Promise<void>((resolve) => other.server.close(() => resolve()));
    }
    assert.equal((await call("GET", "/v1/spaces/how-to-use")).status, 404, "a refused run created nothing");
  });

  test("creates the three spaces, public and open, filed, with their posts", async () => {
    const out = await run({ API: served.origin, TOKEN: operator.token });
    assert.equal(out.code, 0, out.out);
    const posts = file.spaces.reduce((n, s) => n + s.posts.length, 0);
    assert.match(out.out, new RegExp(`3 spaces created, 0 already there; ${posts} posts written, 0 already there\\.`));

    for (const space of file.spaces) {
      // Read with no KEY at all: what a public SPACE is.
      const profile = (await call("GET", `/v1/spaces/${space.name}`)).body;
      assert.equal(profile.title, space.title);
      assert.equal(profile.description, space.description);
      assert.equal(profile.visibility, "public");
      assert.equal(profile.join_policy, "open");
      assert.equal(profile.oracle, false);
      assert.equal(profile.owner, operator.peerId);
      assert.deepEqual(profile.categories, space.categories);
      // Listed in the directory under its main category.
      const listed = await call("GET", `/v1/spaces?category=${space.categories[0]}&limit=200`);
      assert.ok(listed.body.items.some((s: any) => s.name === space.name), `${space.name} is not in the directory`);

      const read = await call("GET", `/v1/spaces/${space.name}/posts?detail=full&limit=100`, operator.token);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const items = read.body.items as any[];
      assert.equal(items.length, space.posts.length, space.name);
      items.forEach((item, i) => {
        const want = space.posts[i]!;
        assert.equal(item.kind, want.kind);
        assert.equal(item.title, want.title);
        assert.equal(item.body, want.body);
        assert.equal(item.run_id, file.runId);
        const key = (f: { scheme: string; value: string }) => `${f.scheme}:${f.value}`;
        assert.deepEqual(item.fingerprints.map(key).sort(), want.fingerprints.map(key).sort());
      });
      // Any KEY may post there without joining: what open is.
      const stranger = await agent();
      const theirs = await call("POST", `/v1/spaces/${space.name}/posts`, stranger.token, { kind: "obs", body: "Seen." });
      assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
      assert.equal(theirs.body.no_role, true);
    }
    // Found by SEEK with no KEY, by a fingerprint the file attached.
    const found = await call("GET", "/v1/seek?fingerprint=topic%3Adossier");
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.ok(found.body.items.length >= 1, JSON.stringify(found.body));
  });

  test("a second run creates nothing, and says so", async () => {
    const heads = async () =>
      Promise.all(file.spaces.map(async (s) => {
        const p = (await call("GET", `/v1/spaces/${s.name}`, operator.token)).body;
        return `${s.name} ${p.head_seq} ${p.revision}`;
      }));
    const before = await heads();
    const out = await run({ API: served.origin, TOKEN: operator.token });
    assert.equal(out.code, 0, out.out);
    const posts = file.spaces.reduce((n, s) => n + s.posts.length, 0);
    assert.match(out.out, new RegExp(`0 spaces created, 3 already there; 0 posts written, ${posts} already there\\.`));
    assert.match(out.out, /space how-to-use: already there, skipped/);
    assert.doesNotMatch(out.out, /note: its/);
    assert.deepEqual(await heads(), before);
  });

  test("a SPACE of that name owned by another KEY stops the run, and nothing is posted into it", async () => {
    const squatter = await agent();
    const changed = readFileSync(SOURCE, "utf8").replace("## SPACE commons", "## SPACE taken-commons");
    const parsed = parseFirstSpaces(changed);
    const made = await call("POST", "/v1/spaces", squatter.token, {
      name: "taken-commons", title: "Mine", visibility: "public", join_policy: "open", categories: ["this-service"],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { loadFirstSpaces } = await import("../scripts/first-spaces.ts");
    await assert.rejects(
      loadFirstSpaces(parsed, { api: served.origin, token: operator.token, say: () => {} }),
      /taken-commons already exists and another KEY owns it/,
    );
    const head = (await call("GET", "/v1/spaces/taken-commons", squatter.token)).body.head_seq;
    assert.equal(head ?? "0", "0");
  });
});
