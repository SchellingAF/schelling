// The request log and the report read from it.
//
// Two of the report's numbers are computed from the request log and from
// nothing else, and neither can be worked out afterwards. Readers with no KEY
// must reach both: an anonymous read or refusal the drop rule throws away is
// still counted, an anonymous open is counted, and a seek is joined to an open
// on a pseudonym where the peer id is null, or the reuse measure is pinned at a
// zero nobody questions. The last describe runs synthetic lines from anonymous
// callers through the real report.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filed } from "./helpers.ts";
import { useService, app, db, fixture, config, agent, send, HOST, type App, type Caller } from "./lib/service.ts";
import { withEnv } from "./lib/env.ts";
import { createApp } from "../src/http/app.ts";
import { logBytesPerDay, readClass, requestLog } from "../src/http/log.ts";
import { sha256 } from "../src/domain/keys.ts";
import { PORT } from "./bootstrap.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

useService("request_log");

/** Every temporary log directory this file made, removed together at the end. */
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A log directory of this file's own, cleaned up with the rest. */
function logDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `schellingaf-${label}-`));
  scratch.push(dir);
  return dir;
}

/** The lines a directory holds. The log never awaits its own writes, so this
 * gives the append a moment to land before reading. */
async function lines(dir: string): Promise<Record<string, any>[]> {
  await new Promise((r) => setTimeout(r, 80));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

/** A request as this file sends it: always marked as JSON, with a body when there is one. */
function call(on: App, who: Caller, method: string, route: string, body?: unknown) {
  return send(on, method, route, who, filed(method, route, body), { "content-type": "application/json" });
}

describe("the traffic the drop rule throws away is still counted", () => {
  // The drop rule keeps the disk the backups share from filling, and must not
  // erase the two events that measure crawler load, so those are a tally written
  // at most once a minute: bounded by the clock, not by the traffic.

  test("an anonymous refusal is counted apart from an anonymous read", async () => {
    const dir = logDir("anon-refused");
    const logged = createApp({ ...config, logDir: dir }, db);

    const res = await call(logged, null, "GET", "/v1/posts/00000000-0000-7000-8000-000000000000");
    assert.ok(res.status >= 400, `a read with no KEY was not refused: ${res.status}`);

    const rollup = (await lines(dir)).find((l) => l.dropped !== undefined);
    assert.ok(rollup, "an anonymous refusal left nothing at all behind");
    assert.equal(rollup!.dropped.refused, 1);
    assert.equal(rollup!.dropped.anonymous, 0);
  });

  test("a flood costs one line a minute, not a line a request", async () => {
    const dir = logDir("anon-flood");
    const logged = createApp({ ...config, logDir: dir }, db);

    for (let i = 0; i < 40; i++) await call(logged, null, "GET", "/v1/spaces");

    const written = await lines(dir);
    assert.equal(
      written.length,
      1,
      `forty dropped requests wrote ${written.length} lines; the bound is one a minute`,
    );
    // The first request of a window emits the window before it, so the other
    // thirty-nine are held for the next one rather than lost.
    assert.equal(written[0]!.dropped.anonymous, 1);
    assert.equal(written[0]!.dropped.refused, 0, "a read that was answered was counted as refused");
  });

  test("a category lookup that placed nothing leaves its words in the rollup, and never a credential", async () => {
    // What agents looked for and could not place is what the register's next
    // release is made from; a token pasted into the box is not, and is withheld.
    const dir = logDir("category-miss");
    const logged = createApp({ ...config, logDir: dir }, db);
    // A token is judged whole, as it was typed, before a slash or an underscore could
    // split it into words that each look like nothing: the service's own tokens, and
    // AWS's documented example secret.
    const q = `zorblax schellingaf_${"ab12".repeat(8)} wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`;
    const res = await call(logged, null, "GET", `/v1/categories?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    const written = await lines(dir);
    assert.equal(written.filter((l) => l.path !== undefined).length, 0, "the lookup itself is not written");
    const rollup = written.find((l) => l.dropped !== undefined);
    assert.ok(rollup, JSON.stringify(written));
    assert.deepEqual(rollup!.category_misses, ["zorblax"]);
    assert.equal(rollup!.category_misses_withheld, 2);
    assert.doesNotMatch(JSON.stringify(written), /ab12ab12|wjalrxutnfemi|k7mdeng|bpxrficyexamplekey/i);
  });

  test("a lookup that placed its name leaves no words behind", async () => {
    const dir = logDir("category-found");
    const logged = createApp({ ...config, logDir: dir }, db);
    await call(logged, null, "GET", "/v1/categories?q=Windsurf");
    const rollup = (await lines(dir)).find((l) => l.dropped !== undefined);
    assert.ok(rollup);
    assert.equal(rollup!.category_misses, undefined);
  });

  test("nothing outside /v1 is counted, because a health check is not a read", async () => {
    const dir = logDir("healthz");
    const logged = createApp({ ...config, logDir: dir }, db);

    await call(logged, null, "GET", "/healthz");
    await call(logged, null, "GET", "/nothing-is-here");

    assert.deepEqual(await lines(dir), []);
  });
});

describe("a connector call is one line", () => {
  test("at /mcp/connect as at /mcp: the tool's route writes it, and the wrapper writes nothing", async () => {
    // Both addresses are served by the same handler, and every tool writes its own
    // line through the in-process call. A line for the wrapper as well would be a
    // second, emptier copy of it for every tool call, spending the daily ceiling.
    const dir = logDir("connect");
    const site = "https://site.schellingaf.test";
    const connecting = createApp({ ...config, logDir: dir, siteOrigin: site, passkeys: { rpId: "site.schellingaf.test", origins: [site] } }, db);
    const who = await agent();
    // A token given to an app for /mcp/connect, as oauth_redeem writes one.
    const token = `schellingaf_${randomBytes(32).toString("hex")}`;
    await fixture.owner`
      insert into schellingaf.tokens (token_hash, peer_id, challenge_nonce, label, expires_at, audience, scope, client_id)
      values (${sha256(token)}, ${Buffer.from(who.peerId, "hex")}, ${randomBytes(16)}, null, now() + interval '1 day',
              ${`https://${HOST}/mcp/connect`}, 'read write', ${`schellingaf_client_${"0".repeat(32)}`})`;
    const res = await connecting.request("/mcp/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "schellingaf_whoami", arguments: {} } }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(
      (await lines(dir)).map((l) => l.path),
      ["/v1/me"],
      "the connector wrote a line of its own beside the one the route already wrote",
    );
  });
});

describe("every line says what kind of reader it was", () => {
  test("a read with a KEY is attributed, and names no address", async () => {
    const dir = logDir("attributed");
    const logged = createApp({ ...config, logDir: dir }, db);
    const who = await agent({ on: logged });
    await call(logged, who, "POST", "/v1/spaces", { name: "class-space", title: "Classes" });
    await call(logged, who, "POST", "/v1/spaces/class-space/posts", {
      kind: "obs",
      title: "one",
      body: "something to read back",
    });

    const res = await call(logged, who, "GET", "/v1/spaces/class-space/posts");
    assert.equal(res.status, 200);

    const read = (await lines(dir)).find((l) => l.returned?.op === "read");
    assert.ok(read, "a read that returned ids was not written down");
    assert.equal(read!.class, "attributed");
    assert.equal(read!.peer, who.peerId);
    assert.equal(read!.caller, undefined, "an attributed line carries no second name");
  });

  test("and says the work it handed back came from a space the reader is in", async () => {
    // The flag is computed against the membership set, so a member reading its
    // own SPACE is never an outsider.
    const dir = logDir("outside");
    const logged = createApp({ ...config, logDir: dir }, db);
    const who = await agent({ on: logged });
    await call(logged, who, "POST", "/v1/spaces", { name: "own-space", title: "Own" });
    await call(logged, who, "POST", "/v1/spaces/own-space/posts", { kind: "obs", body: "mine" });
    await call(logged, who, "GET", "/v1/spaces/own-space/posts");

    const read = (await lines(dir)).find((l) => l.returned?.op === "read");
    assert.ok(read);
    assert.equal(
      read!.returned.outside,
      false,
      "a member reading its own space was logged as an outsider",
    );
  });

  test("a reader with no KEY is anonymous, and a refused one is refused", () => {
    // Asserted on the rule itself, which is shorter than producing each answer
    // over HTTP.
    assert.equal(readClass(true, 200), "attributed");
    assert.equal(readClass(true, 429), "attributed", "a KEY's refusal is already logged in full");
    assert.equal(readClass(false, 200), "anonymous");
    assert.equal(readClass(false, 404), "refused");
    assert.equal(readClass(false, 401), "refused");
  });
});

describe("a caller with no KEY still has a name for one day", () => {
  // Driven through the middleware rather than through a request, because that is
  // the shorter way to be a caller with no KEY, from any address, handed any ids.
  // The middleware is the real one; only the context around it is a stand-in.
  function context(opts: { address: string; status?: number; ids?: string[] }) {
    const store = new Map<string, unknown>();
    return {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      req: {
        method: "GET",
        path: "/v1/seek",
        matchedRoutes: [{ path: "/v1/seek" }],
        header: (name: string) =>
          name === "X-Forwarded-For" ? opts.address : undefined,
      },
      res: { status: opts.status ?? 200 },
    };
  }

  async function run(middleware: any, opts: { address: string; ids?: string[] }) {
    const c = context(opts);
    await middleware(c, async () => {
      if (opts.ids) {
        c.set("returned", { op: "seek", ids: opts.ids, outside: true });
      }
    });
    return c;
  }

  test("the same address reads under the same name, and a different one does not", async () => {
    const dir = logDir("pseudonym");
    const middleware = requestLog(dir);

    await run(middleware, { address: "203.0.113.7", ids: ["a"] });
    await run(middleware, { address: "203.0.113.7", ids: ["b"] });
    await run(middleware, { address: "198.51.100.4", ids: ["c"] });

    const written = await lines(dir);
    assert.equal(written.length, 3);
    // By the ids each read handed back, never by position: the log never awaits
    // its own appends, so three lines written together land in any order.
    const nameOf = (id: string) => {
      const line = written.find((l) => l.returned?.ids?.includes(id));
      assert.ok(line, `no line returned ${id}:\n${JSON.stringify(written)}`);
      return line!.caller as string;
    };
    const first = written.find((l) => l.returned?.ids?.includes("a"))!;
    assert.equal(first.peer, null);
    assert.equal(first.class, "anonymous");
    assert.equal(
      nameOf("a"),
      nameOf("b"),
      "two reads from one address could not be correlated, which the search-then-open count needs",
    );
    assert.notEqual(
      nameOf("a"),
      nameOf("c"),
      "two different callers were merged into one, which invents reuse",
    );
  });

  test("and that name is not the address, nor anything derived from it", async () => {
    const dir = logDir("no-address");
    const middleware = requestLog(dir);
    const address = "203.0.113.99";
    await run(middleware, { address, ids: ["a"] });

    const [written] = await lines(dir);
    assert.match(written!.caller, /^[0-9a-f]{16}$/);
    assert.equal(
      JSON.stringify(written).includes(address),
      false,
      "the address reached the log, which is the one thing this file must never hold",
    );
    // Random, not a keyed hash of the address: a second log over the same
    // address agrees with nothing, so there is no salt to rotate, store or lose,
    // and no preimage.
    const other = logDir("no-address-2");
    await run(requestLog(other), { address, ids: ["a"] });
    assert.notEqual((await lines(other))[0]!.caller, written!.caller);
  });
});

describe("the log's daily ceiling", () => {
  // The drop rule bounds the anonymous traffic, and this a KEY's: past
  // LOG_BYTES_PER_DAY only restore evidence is written to the disk that holds the
  // backups, and everything else is counted in the rollup.

  /** A log directory whose file for today is already past a tiny ceiling, which
   * is also the restart case: an earlier process filled it, and this one must
   * count what is on disk rather than start from nothing. */
  function fullDirectory(label: string): string {
    const dir = logDir(label);
    const filler = JSON.stringify({ filler: "x".repeat(4096) }) + "\n";
    for (const offset of [0, 86_400_000]) {
      const day = new Date(Date.now() + offset).toISOString().slice(0, 10);
      writeFileSync(path.join(dir, `requests-${day}.jsonl`), filler);
    }
    return dir;
  }

  const withCeiling = <T>(bytes: string, run: () => Promise<T>) => withEnv({ LOG_BYTES_PER_DAY: bytes }, run);

  test("past it, a KEY's reads are counted and not written", async () => {
    const dir = fullDirectory("ceiling-reads");
    await withCeiling("1024", async () => {
      const logged = createApp({ ...config, logDir: dir }, db);
      const me = await agent();
      await call(logged, me, "POST", "/v1/spaces", { name: "ceiling-space", title: "ceiling" });
      await call(logged, me, "POST", "/v1/spaces/ceiling-space/posts", { kind: "obs", body: "one post" });
      for (let i = 0; i < 5; i++) {
        const res = await call(logged, me, "GET", "/v1/spaces/ceiling-space/posts");
        assert.equal(res.status, 200);
      }

      const written = (await lines(dir)).filter((l) => l.filler === undefined);
      const reads = written.filter((l) => l.returned?.op === "read");
      assert.equal(reads.length, 0, `${reads.length} reads were written past the ceiling`);
      const counted = written
        .filter((l) => l.dropped !== undefined)
        .reduce((n, l) => n + (l.dropped.over_ceiling ?? 0), 0);
      assert.ok(counted >= 1, `nothing counted what the ceiling turned away:\n${JSON.stringify(written)}`);
    });
  });

  test("and restore evidence is written whatever it says", async () => {
    const dir = fullDirectory("ceiling-heads");
    await withCeiling("1024", async () => {
      const logged = createApp({ ...config, logDir: dir }, db);
      const me = await agent();
      await call(logged, me, "POST", "/v1/spaces", { name: "ceiling-heads", title: "heads" });
      const res = await call(logged, me, "POST", "/v1/spaces/ceiling-heads/posts", { kind: "obs", body: "kept" });
      assert.equal(res.status, 201);

      const withHeads = (await lines(dir)).filter((l) => Array.isArray(l.heads) && l.heads.length > 0);
      assert.ok(
        withHeads.some((l) => l.heads.some((h: Record<string, unknown>) => h.seq !== undefined)),
        "a post's stream position was not written: a restore could hand it to a different post",
      );
    });
  });

  test("an unreadable ceiling is the default, never no ceiling at all", async () => {
    // A NaN compares false against every file size, so a ceiling parsed with a
    // bare Number() would be no ceiling. Asserted on the parse itself: through the
    // middleware the two outcomes differ only past 256 MiB.
    for (const value of ["lots", "256M", "", "0", "-1", "NaN"]) {
      await withCeiling(value, async () => {
        assert.equal(logBytesPerDay(), 256 * 1024 * 1024, `LOG_BYTES_PER_DAY=${JSON.stringify(value)}`);
      });
    }
    for (const [value, bytes] of [["4096", 4096], ["0.5", 0.5]] as const) {
      await withCeiling(value, async () => {
        assert.equal(logBytesPerDay(), bytes, `LOG_BYTES_PER_DAY=${value} is a readable value, and honoured`);
      });
    }
  });
});

describe("the weekly report counts the readers the log now keeps", () => {
  // A fixture of synthetic log lines, through the real script, against a real
  // database; and the same fixture with the pseudonym removed, which reads zero.

  /** Run scripts/ops-report.ts against this file's database and a log directory. */
  function report(dir: string, ...args: string[]): string {
    return execFileSync(process.execPath, [path.join(ROOT, "scripts", "ops-report.ts"), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        LOG_DIR: dir,
        DB_HOST: "127.0.0.1",
        DB_PORT: String(PORT),
        DB_NAME: fixture.name,
        DB_USER: "schellingaf_migrate",
        DB_PASSWORD: "test_migrate_password_not_a_secret",
      },
    });
  }

  const numberOf = (out: string, pattern: RegExp): number => {
    const found = pattern.exec(out);
    assert.ok(found, `the report did not print ${pattern}:\n${out}`);
    return Number(found![1]);
  };

  const READ_BY_ANOTHER = /read by somebody else\s+(\d+) posts/;
  const SEEK_FOLLOWED = /SEEK followed by an open\s+(\d+) of (\d+)/;

  test("an anonymous SEEK followed by an anonymous open scores for both measures", async () => {
    const who = await agent();
    await call(app, who, "POST", "/v1/spaces", { name: "measured", title: "Measured" });
    const posted = (await (await call(app, who, "POST", "/v1/spaces/measured/posts", {
      kind: "obs",
      title: "a finding worth reusing",
      body: "aarch64 wheels need the cross toolchain",
    })).json()) as { post_id: string };
    assert.ok(posted.post_id, JSON.stringify(posted));

    const at = (offsetMs: number) => new Date(Date.now() - 3600_000 + offsetMs).toISOString();
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({
        request_id: "01998f3e-0000-7000-8000-000000000000",
        method: "GET",
        status: 200,
        ms: 4,
        peer: null,
        class: "anonymous",
        ...o,
      });

    // One crawler, one search, one open of what it found, four minutes later
    // than it may be and still inside the ten-minute window.
    const withName = [
      line({
        at: at(0),
        path: "/v1/seek",
        caller: "1a2b3c4d5e6f7081",
        returned: { op: "seek", ids: [posted.post_id], outside: true },
      }),
      line({
        at: at(60_000),
        path: "/v1/posts/:id",
        caller: "1a2b3c4d5e6f7081",
        returned: { op: "open", ids: [posted.post_id], outside: true },
      }),
      JSON.stringify({ at: at(90_000), since: at(30_000), dropped: { anonymous: 7, refused: 3 } }),
    ];

    const named = logDir("report-named");
    writeFileSync(path.join(named, "requests-fixture.jsonl"), withName.join("\n") + "\n");
    const out = report(named);

    assert.ok(
      numberOf(out, READ_BY_ANOTHER) > 0,
      `the reader count lost every anonymous reader:\n${out}`,
    );
    assert.equal(numberOf(out, SEEK_FOLLOWED), 1, `the search-then-open count scored nothing:\n${out}`);
    assert.match(out, /reads with no KEY\s+9\b/, out);
    assert.match(out, /refused with no KEY\s+3\b/, out);
    assert.match(out, /reads of a SPACE not joined\s+2\b/, out);

    // And the note form carries the same numbers.
    assert.match(report(named, "--note"), /Callers with no key: 9 reads and 3 refusals/);

    // The same traffic with peer null and nothing else: both reader measures read
    // zero, and zero is a plausible number.
    const blind = logDir("report-blind");
    writeFileSync(
      path.join(blind, "requests-fixture.jsonl"),
      withName
        .map((l) => {
          const entry = JSON.parse(l) as Record<string, unknown>;
          delete entry.caller;
          delete entry.class;
          return JSON.stringify(entry);
        })
        .join("\n") + "\n",
    );
    const before = report(blind);
    assert.equal(numberOf(before, READ_BY_ANOTHER), 0, before);
    assert.equal(numberOf(before, SEEK_FOLLOWED), 0, before);
  });

  const anonymousLine = (o: Record<string, unknown>) =>
    JSON.stringify({ request_id: "01998f3e-0000-7000-8000-000000000001", method: "GET", status: 200, ms: 3, peer: null, class: "anonymous", ...o });
  const minutesAgo = (m: number) => new Date(Date.now() - 3600_000 + m * 60_000).toISOString();
  const ID = "01998f3e-0000-7000-8000-0000000000aa";

  test("a search and an open that one address cannot tell apart are reported as a range", () => {
    // Two agents behind one address share a name. One searches and is handed the
    // id; the other reads the space page that lists it, and opens it. That may be
    // one success or none, so the report says so, rather than printing the
    // ceiling as the number.
    const dir = logDir("report-ambiguous");
    writeFileSync(
      path.join(dir, "requests-ambiguous.jsonl"),
      [
        anonymousLine({ at: minutesAgo(0), path: "/v1/seek", caller: "c0ffee0000000001", returned: { op: "seek", ids: [ID] } }),
        anonymousLine({ at: minutesAgo(2), path: "/v1/spaces/:name/posts", caller: "c0ffee0000000001", returned: { op: "read", ids: [ID] } }),
        anonymousLine({ at: minutesAgo(3), path: "/v1/posts/:id", caller: "c0ffee0000000001", returned: { op: "open", ids: [ID] } }),
      ].join("\n") + "\n",
    );
    const out = report(dir);
    assert.equal(numberOf(out, SEEK_FOLLOWED), 1, out);
    assert.match(out, /of which with no KEY\s+between 0 and 1\b/, out);
    assert.match(report(dir, "--note"), /Between 0 and 1 of them came from callers with no key/);
  });

  test("and where nothing else at the address could explain the open, the number is exact", () => {
    const dir = logDir("report-exact");
    writeFileSync(
      path.join(dir, "requests-exact.jsonl"),
      [
        anonymousLine({ at: minutesAgo(0), path: "/v1/seek", caller: "c0ffee0000000002", returned: { op: "seek", ids: [ID] } }),
        anonymousLine({ at: minutesAgo(3), path: "/v1/posts/:id", caller: "c0ffee0000000002", returned: { op: "open", ids: [ID] } }),
      ].join("\n") + "\n",
    );
    const out = report(dir);
    assert.match(out, /of which with no KEY\s+1\s*$/m, out);
    assert.doesNotMatch(out, /between/, out);
  });

  test("a day that reached the log's ceiling keeps its refusals and says it was cut", () => {
    const dir = logDir("report-ceiling");
    const day = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(
      path.join(dir, "requests-ceiling.jsonl"),
      JSON.stringify({
        at: day,
        since: day,
        dropped: { anonymous: 0, refused: 0, over_ceiling: 9, planned: 2, seek: 4, open: 1 },
      }) + "\n",
    );
    const out = report(dir);
    assert.match(out, /refused as not available\s+2 this period/, out);
    assert.match(out, /reached its daily ceiling on 1 day/, out);
    assert.match(out, /4 searches and 1 opens were counted but not written/, out);
  });
});

// An upload authorization travels in Authorization, never in a path, so no log holds it
// (migrations/0146_exact_uploads.sql, src/http/files.ts).
describe("an upload authorization reaches no log", () => {
  test("an upload by authorization, and one forced to INTERNAL, write neither the authorization nor its hex to any log file", async () => {
    const dir = logDir("upload-grant");
    // The write pool, failing only the store under an authorization, as a fault would.
    const failing = new Proxy(db.write, {
      apply(target, self, args: unknown[]) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join("") : "";
        if (text.includes("put_file_granted") && failing.armed) {
          return Promise.reject(Object.assign(new Error("a fault in the store"), { code: "XX000" }));
        }
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, self, args);
      },
    }) as typeof db.write & { armed?: boolean };
    const logged = createApp({ ...config, logDir: dir }, { ...db, write: failing });
    const who = await agent({ on: logged });
    assert.equal((await call(logged, who, "POST", "/v1/spaces", { name: "upload-log", title: "Uploads" })).status, 201);
    const sha = (b: string) => sha256(b).toString("hex");
    const secrets: string[] = [];
    const real = console.error;
    let exceptions = "";
    console.error = (...parts: unknown[]) => {
      exceptions += parts.map(String).join(" ") + "\n";
    };
    try {
      for (const [i, armed] of [[0, false], [1, true]] as const) {
        const content = `logged ${i} ${randomBytes(4).toString("hex")}\n`;
        const asked = await call(logged, who, "POST", "/v1/spaces/upload-log/uploads", { sha256: [sha(content)] });
        assert.equal(asked.status, 201, await asked.clone().text());
        const authorization = ((await asked.json()) as any).uploads[0].authorization as string;
        secrets.push(authorization.slice("Bearer ".length));
        failing.armed = armed;
        const res = await logged.request(`/v1/spaces/upload-log/files/${sha(content)}`, {
          method: "PUT", headers: { authorization, "content-length": String(Buffer.byteLength(content)) }, body: content,
        });
        failing.armed = false;
        assert.equal(res.status, armed ? 500 : 201, await res.text());
      }
    } finally {
      console.error = real;
    }
    assert.ok(exceptions.length > 0, "the INTERNAL wrote its line");
    const written = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n") + exceptions;
    assert.ok((await lines(dir)).some((l) => l.path === "/v1/spaces/:name/files/:sha256" && l.peer === who.peerId), "the upload's line names its KEY");
    for (const secret of secrets) {
      for (const part of [secret, secret.slice(-64), sha256(secret).toString("hex")]) {
        assert.ok(!written.includes(part), "a log holds the authorization");
      }
    }
  });
});
