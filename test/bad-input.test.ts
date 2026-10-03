// Input the API would accept and PostgreSQL would refuse.
//
// Answered as INTERNAL, such a value gets a 500 whose fix tells an agent retrying
// is safe, when it fails identically forever, and writes a driver error to the
// operator's only exception log for every request. So the edge validates, and
// the refusal names the field; the SQLSTATEs this class produces are mapped as
// the floor under it; and every case here also asserts that nothing was logged.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import { useService, app, db, config, agent, call as request, type Agent } from "./lib/service.ts";
import { openDb, READ_POOL, type Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { resetReadWindows, withinReadWindow } from "../src/http/ratelimit.ts";
import { readBody } from "../src/domain/validate.ts";
import { ApiError } from "../src/db/errors.ts";

useService("bad_input");

/** Run `fn`, and hand back what it wrote to the exception log besides its result. */
async function capturingErrors<T>(fn: () => T | Promise<T>): Promise<{ result: T; logged: string }> {
  const real = console.error;
  let logged = "";
  console.error = (...parts: unknown[]) => {
    logged += parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" ");
  };
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = real;
  }
}

/**
 * A request, with whatever it wrote to the exception log.
 *
 * The byte count is what the tests check: a refusal writes nothing at all.
 */
async function call(
  method: string,
  path: string,
  who?: Agent,
  payload?: unknown,
): Promise<{ status: number; code: string; detail: string | undefined; logged: string }> {
  const { result, logged } = await capturingErrors(() => request(method, path, who, payload));
  return {
    status: result.status,
    code: result.body?.error?.code ?? "",
    detail: result.body?.error?.detail,
    logged,
  };
}

async function makeSpace(who: Agent, name: string): Promise<void> {
  const out = await call("POST", "/v1/spaces", who, { name, title: "T" });
  assert.equal(out.status, 201, out.code);
}

describe("a cursor is bounded by value, not by how many digits it has", () => {
  // 9223372036854775807 is the largest int8 there is, and it has nineteen digits,
  // as does every value up to 9999999999999999999: a length bound lets that whole
  // band through to the `::bigint` cast.
  test("a nineteen-digit cursor above int8 is refused before the cast", async () => {
    const a = await agent();
    await makeSpace(a, "cursor-space");
    const routes = [
      "/v1/spaces/cursor-space/posts",
      "/v1/mailbox",
      "/v1/spaces/cursor-space/events",
    ];
    for (const route of routes) {
      for (const above of ["9223372036854775808", "9999999999999999999"]) {
        const out = await call("GET", `${route}?after=${above}`, a);
        assert.equal(out.status, 400, `${route}?after=${above} answered ${out.status}`);
        assert.equal(out.code, "INVALID_REQUEST");
        // The refusal names the field, which a SQLSTATE mapped after the fact
        // cannot: a detail that says "after" is the proof the edge refused it.
        assert.match(out.detail ?? "", /after/, `${route} did not name the field`);
        assert.equal(out.logged, "", `${route} wrote ${out.logged.length} bytes to the exception log`);
      }
      // The boundary itself is a position, not a refusal: it is read, and
      // answered as a cursor past the end.
      const edge = await call("GET", `${route}?after=9223372036854775807`, a);
      assert.notEqual(edge.status, 500, `${route} at int8 max`);
      assert.equal(edge.logged, "");
    }
  });
});

describe("a category is held to its shape and the register, never cast", () => {
  test("a filter or a filing that is no category is refused by name, and nothing is logged", async () => {
    const a = await agent();
    for (const route of [
      `/v1/spaces?category=${"a".repeat(65)}`,
      "/v1/spaces?category=NOT-AN-ID",
      "/v1/spaces?category=a%2Cb",
      "/v1/spaces?category=-leading",
    ]) {
      const out = await call("GET", route);
      assert.equal(out.status, 400, `${route} answered ${out.status}`);
      assert.equal(out.code, "INVALID_CATEGORY", route);
      assert.equal(out.logged, "", route);
    }
    for (const categories of [[{}], [null], ["x".repeat(10_000)], "general", [["general"]], [1, 2]]) {
      const out = await call("POST", "/v1/spaces", a, { name: "never-filed", title: "T", categories });
      assert.equal(out.status, 400, JSON.stringify(categories).slice(0, 40));
      assert.equal(out.code, "INVALID_CATEGORY");
      assert.equal(out.logged, "");
    }
    for (const route of [`/v1/categories/${"a".repeat(300)}`, "/v1/categories/%E2%80%AE", "/v1/categories?under=%E2%80%AE"]) {
      const out = await call("GET", route);
      assert.equal(out.status, 404, route);
      assert.equal(out.code, "CATEGORY_NOT_FOUND");
      assert.equal(out.logged, "");
    }
    const nul = await call("GET", "/v1/spaces?category=general%00");
    assert.equal(nul.status, 400);
    assert.equal(nul.code, "INVALID_REQUEST");
  });
});

describe("the member, request and SPACE-list cursors are checked at the edge", () => {
  test("a member cursor that is not a peer id is refused, not decoded", async () => {
    const a = await agent();
    await makeSpace(a, "member-space");
    for (const bad of ["zz", "abc", "ff", "FFFF".repeat(16), `${"a".repeat(63)}g`]) {
      const out = await call("GET", `/v1/spaces/member-space/members?after=${bad}`, a);
      assert.equal(out.status, 400, `after=${bad} answered ${out.status}`);
      assert.equal(out.code, "INVALID_REQUEST");
      assert.match(out.detail ?? "", /after/);
      assert.equal(out.logged, "");
    }
    // And the value a page actually hands back still pages.
    const ok = await call("GET", `/v1/spaces/member-space/members?after=${"0".repeat(64)}`, a);
    assert.equal(ok.status, 200);
  });

  test("a request cursor that is not an id is refused, not cast", async () => {
    const a = await agent();
    await makeSpace(a, "request-space");
    for (const bad of ["notauuid", "-".repeat(36), "1", `${"a".repeat(36)}`]) {
      const out = await call("GET", `/v1/spaces/request-space/requests?after=${bad}`, a);
      assert.equal(out.status, 400, `after=${bad} answered ${out.status}`);
      assert.equal(out.code, "INVALID_REQUEST");
      assert.match(out.detail ?? "", /after/, `after=${bad} did not name the field`);
      assert.equal(out.logged, "");
    }
    const ok = await call(
      "GET",
      "/v1/spaces/request-space/requests?after=00000000-0000-0000-0000-000000000000",
      a,
    );
    assert.equal(ok.status, 200);
  });

  test("the SPACE list's cursor is held to the name grammar, with no token", async () => {
    for (const bad of ["Space-One", "a", "space one", "%00"]) {
      const out = await call("GET", `/v1/spaces?after=${encodeURIComponent(bad)}`);
      assert.equal(out.status, 400, `after=${bad} answered ${out.status}`);
      assert.equal(out.code, "INVALID_REQUEST");
      assert.match(out.detail ?? "", /after/, `after=${bad} did not name the field`);
      assert.equal(out.logged, "");
    }
    const ok = await call("GET", "/v1/spaces?after=space-one");
    assert.equal(ok.status, 200);
  });
});

describe("a NUL byte is refused once, for every route there is", () => {
  // PostgreSQL text cannot hold one, so a NUL in any query or path value is
  // SQLSTATE 22021 the moment it is bound. The guard is one rule over the whole
  // URL rather than a list somebody has to keep complete.
  test("a NUL byte in a path or query value is refused with 400", async () => {
    const a = await agent();
    await makeSpace(a, "nul-space");
    const paths = [
      "/v1/spaces?q=%00",
      "/v1/spaces?join_policy=%00",
      "/v1/spaces/%00",
      "/v1/spaces/nul-space/posts?kind=%00",
      "/v1/seek?q=hello&space=%00",
      "/v1/seek?q=%00",
      "/v1/seek?fingerprint=git.commit%3Aab%00cdef",
      "/v1/seek?fingerprint_prefix=git.commit%3Aab%00cdef",
    ];
    for (const path of paths) {
      const out = await call("GET", path, a);
      assert.equal(out.status, 400, `${path} answered ${out.status}`);
      assert.equal(out.code, "INVALID_REQUEST");
      // Refused by the guard, before any database work, not by the SQLSTATE the
      // bind would raise: only the guard's detail says a NUL byte.
      assert.equal(out.detail, "a NUL byte is not text", `${path} was refused somewhere else`);
      assert.equal(out.logged, "", `${path} wrote ${out.logged.length} bytes`);
    }
  });

  test("a doubly-encoded one is four characters a peer sent, and is not refused", async () => {
    // %2500 decodes to the literal text %00, which PostgreSQL stores without
    // complaint. A guard that refused it would refuse ordinary text.
    const out = await call("GET", "/v1/spaces?q=%2500");
    assert.equal(out.status, 200);
  });
});

describe("an id is a uuid, not thirty-six of anything", () => {
  // /^[0-9a-f-]{36}$/ admits thirty-six hyphens, which reach a ::uuid parameter
  // as 22P02.
  test("thirty-six hyphens reads exactly like an id that does not exist", async () => {
    // An id that cannot exist and an id that does not exist answer the same, or
    // the malformed one tells the two apart: the rule leaks.test.ts holds for every
    // id route. A SQLSTATE mapped after the bind would say INVALID_REQUEST where the
    // route says POST_NOT_FOUND.
    const a = await agent();
    await makeSpace(a, "id-space");
    const dashes = "-".repeat(36);
    const unknown = randomUUID();
    const cases: [string, (id: string) => string][] = [
      ["GET", (id) => `/v1/posts/${id}`],
      ["DELETE", (id) => `/v1/invites/${id}`],
      ["POST", (id) => `/v1/requests/${id}/withdraw`],
      ["POST", (id) => `/v1/requests/${id}/approve`],
    ];
    for (const [method, path] of cases) {
      const payload = method === "POST" ? {} : undefined;
      const malformed = await call(method, path(dashes), a, payload);
      const missing = await call(method, path(unknown), a, payload);
      assert.equal(
        `${malformed.status} ${malformed.code}`,
        `${missing.status} ${missing.code}`,
        `${method} ${path("<id>")} tells a malformed id from a missing one`,
      );
      assert.equal(malformed.logged, "", `${method} ${path(dashes)} wrote ${malformed.logged.length} bytes`);
    }

    // The two that take ids as a FILTER refuse instead, naming the field:
    // there is no page to return for a value that is not an id.
    const filters: [string, string][] = [
      [`/v1/spaces/id-space/posts?reply_to=${dashes}`, "reply_to is a post id"],
      [`/v1/posts?ids=${dashes}`, "ids are post ids"],
    ];
    for (const [path, detail] of filters) {
      const out = await call("GET", path, a);
      assert.equal(out.status, 400, `${path} answered ${out.status}`);
      assert.equal(out.detail, detail, `${path} was refused somewhere else`);
      assert.equal(out.logged, "");
    }
  });

  test("the four id fields on a post are shape-checked, not only length-checked", async () => {
    const a = await agent();
    await makeSpace(a, "write-space");
    for (const field of ["run_id", "reply_to", "supersedes", "retracts"]) {
      const out = await call("POST", "/v1/spaces/write-space/posts", a, {
        kind: "obs",
        body: "x",
        [field]: "z".repeat(36),
      });
      assert.equal(out.status, 400, `${field} answered ${out.status}`);
      assert.equal(out.code, "INVALID_REQUEST");
      assert.equal(out.detail, `${field} is a uuid`);
      assert.equal(out.logged, "");
    }
  });
});

describe("data the service publishes a limit for is data the column can hold", () => {
  // GET /v1/capabilities says 16,384 bytes and requireData measures compact JSON,
  // so the column must hold what passes: jsonb's rendering of an array of
  // one-character elements is up to half as long again.
  test("an object at the published limit is stored", async () => {
    const a = await agent();
    await makeSpace(a, "data-space");
    const items = Array.from({ length: 8188 }, () => 1);
    const data = { a: items };
    const compact = Buffer.byteLength(JSON.stringify(data));
    assert.ok(compact <= 16384 && compact > 16000, `the shape under test measures ${compact}`);
    const out = await call("POST", "/v1/spaces/data-space/posts", a, { kind: "obs", body: "x", data });
    assert.equal(out.status, 201, `${out.code} ${out.detail ?? ""}`);
    assert.equal(out.logged, "");
  });

  test("a shape no compact bound can bound is a refusal, never an INTERNAL", async () => {
    // jsonb renders a number through numeric, so 1e-300 is six bytes of JSON and
    // about three hundred of rendering, which no limit on the way in can predict:
    // the column's own CHECK degrades to a refusal, never a 500.
    const a = await agent();
    await makeSpace(a, "numeric-space");
    const data = { a: Array.from({ length: 200 }, () => 1e-300) };
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 2048);
    const out = await call("POST", "/v1/spaces/numeric-space/posts", a, { kind: "obs", body: "x", data });
    assert.equal(out.status, 400, `answered ${out.status}`);
    assert.equal(out.code, "INVALID_REQUEST");
    assert.equal(out.detail, "posts_data_check");
    assert.equal(out.logged, "");
  });
});

describe("a member name is held to the rule a value is", () => {
  test("a NUL or a lone surrogate in a name of data is refused, and nothing is logged", async () => {
    // parseStrictJson refuses either one in a name as in a value, where it is read;
    // at the write, a NUL (which jsonb cannot hold) would be a 500.
    const a = await agent();
    await makeSpace(a, "name-space");
    for (const name of [`a${String.fromCharCode(0)}b`, `a${String.fromCharCode(0xd83d)}`]) {
      const out = await call("POST", "/v1/spaces/name-space/posts", a, { kind: "obs", body: "x", data: { [name]: 1 } });
      assert.equal(out.status, 400, `${JSON.stringify(name)} answered ${out.status} ${out.code}`);
      assert.equal(out.code, "INVALID_REQUEST");
      assert.equal(out.detail, undefined, `${JSON.stringify(name)} was refused by the database, not where the JSON is read`);
      assert.equal(out.logged, "");
    }
  });
});

describe("a token label is measured in bytes, like every other field", () => {
  async function unusedChallenge() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const hex = raw.toString("hex");
    const ch = (await request("POST", "/v1/keys/challenge", null, { public_key: hex })).body as { challenge: string };
    const signature = signBytes(
      null,
      challengePreimage(config.apiHost, Buffer.from(ch.challenge, "hex")),
      privateKey,
    ).toString("hex");
    return { public_key: hex, challenge: ch.challenge, signature };
  }

  test("a label of 64 units and more than 64 bytes is refused, and registers nobody", async () => {
    // The column counts octets: forty accented characters are forty units and
    // eighty bytes. Refused by the column instead of the edge, it would be a 500
    // after the peer row was written, and a false `registered: false` next time.
    const keys = await unusedChallenge();
    const refused = await call("POST", "/v1/keys/verify", undefined, {
      ...keys,
      label: "é".repeat(40),
    });
    assert.equal(refused.status, 400, `answered ${refused.status}`);
    assert.equal(refused.code, "INVALID_REQUEST");
    assert.equal(refused.detail, "label");
    assert.equal(refused.logged, "");

    // The same challenge still works, and the peer is registered by the call
    // that succeeds rather than by the one that failed.
    const accepted = await call("POST", "/v1/keys/verify", undefined, { ...keys, label: "short" });
    assert.equal(accepted.status, 200);
    const body = (await request("POST", "/v1/keys/verify", null, await unusedChallenge())).body as { registered: boolean };
    assert.equal(body.registered, true);
  });

  test("a 64-byte label is still a label", async () => {
    const out = await call("POST", "/v1/keys/verify", undefined, {
      ...(await unusedChallenge()),
      label: "a".repeat(64),
    });
    assert.equal(out.status, 200);
  });
});

describe("what an INTERNAL is allowed to write down", () => {
  test("the handler logs named fields, never the driver's error object", async () => {
    // postgres.js can hang the statement and its bound values off an error: the
    // caller's peer id, SPACE names, cursors, the SEEK query. The exception log
    // holds none of it, by the same rule as the request log.
    const looksLikeTheDriver = Object.defineProperties(new Error("something failed inside"), {
      code: { value: "XX000", enumerable: true },
      query: { value: "select schellingaf.append_post($1,$2)", enumerable: true },
      parameters: { value: ["PRIVATE-PARAM-CANARY"], enumerable: true },
    });
    const broken = { ...db, readTx: async () => { throw looksLikeTheDriver; } } as unknown as Db;
    const other = createApp(config, broken);

    const { result: res, logged } = await capturingErrors(() => other.request("/v1/spaces"));

    assert.equal(res.status, 500, "the scene has to be a real INTERNAL or it proves nothing");
    assert.ok(logged.includes("XX000"), "an INTERNAL still has to be diagnosable");
    assert.ok(logged.includes("something failed inside"));
    assert.equal(logged.includes("PRIVATE-PARAM-CANARY"), false, "a bound value reached the log");
    assert.equal(logged.includes("append_post"), false, "the statement text reached the log");
  });

  test("the read pool does not publish its statements on the errors it raises", async () => {
    // The other half, in the driver: postgres.js marks `query` and `parameters`
    // enumerable exactly when `debug` is set, which the read pool sets only for a
    // test that watches it. The canary is bound but never named by the server's
    // own message, so anything that renders it came from the driver's copy.
    const raised = await db.read`
      select ${"SECRET-CANARY-PARAM"}::text as canary, 1 / ${0}::int as boom`
      .catch((e: unknown) => e);
    assert.ok(raised instanceof Error, "the scene needs a real driver error");
    assert.equal((raised as { code?: string }).code, "22012", "expected a division by zero");
    const keys = Object.keys(raised as object);
    assert.equal(keys.includes("parameters"), false, `enumerable keys: ${keys.join(",")}`);
    assert.equal(keys.includes("query"), false, `enumerable keys: ${keys.join(",")}`);
    assert.equal(inspect(raised).includes("SECRET-CANARY-PARAM"), false, "a bound value rendered");
    assert.equal(inspect(raised).includes("canary"), false, "the statement text rendered");
  });

  test("the read pool is READ_POOL connections unless a measurement asks for another number", async () => {
    assert.equal(db.read.options.max, READ_POOL);
    const measured = openDb(config, { readPool: 2 });
    try {
      assert.equal(measured.read.options.max, 2);
    } finally {
      await measured.end();
    }
  });
});

describe("what a caller holding nothing can still make the service do", () => {
  // The address is pinned so the in-process window has a key this test can ask
  // about afterwards. clientAddress reads the LAST forwarded entry.
  const FROM = { "X-Forwarded-For": "203.0.113.7" };

  test("SEEK refuses the same query instead of crashing on it, with no KEY", async () => {
    // The query the directory refuses (test/load-limits.test.ts): thirty-three or more
    // separators in a row, on which `websearch_to_tsquery` raises `tsquery stack
    // too small` inside the conversion, where counting the query's nodes cannot
    // catch it. No Authorization header, on purpose: SEEK answers anybody.
    const { result: res, logged } = await capturingErrors(() => app.request(`/v1/seek?q=${"-".repeat(40)}`));
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(res.status, 400, `an unparseable SEEK was the service's fault: ${JSON.stringify(body)}`);
    assert.equal(body.error?.code, "INVALID_REQUEST");
    assert.equal(logged, "", `a refusal wrote to the exception log:\n${logged}`);

    // And an ordinary SEEK with no KEY is still answered, so the refusal is
    // about the query and not about the caller.
    const ok = await app.request("/v1/seek?q=aarch64");
    assert.equal(ok.status, 200, "an ordinary anonymous SEEK must be untouched");
  });

  test("a HEAD pays for the read it performs", async () => {
    // Hono runs a HEAD through the GET handler and does the whole read while
    // c.req.method answers "HEAD", so a HEAD must be counted as a read.
    resetReadWindows();
    const key = "addr:203.0.113.7";
    assert.equal(withinReadWindow(key, 2).allowed, true, "the window starts empty");
    resetReadWindows();
    const res = await app.request("/v1/spaces", { method: "HEAD", headers: FROM });
    assert.equal(res.status, 200, "HEAD is served, which is the whole point");
    assert.equal(
      withinReadWindow(key, 1).allowed,
      false,
      "the HEAD was not counted, so it was free",
    );
  });

  test("a HEAD answers what the GET would, in markdown too", async () => {
    // Hono runs a HEAD through the GET handler with the method still "HEAD": a
    // rendering that asked for "GET" would leave a HEAD's answer as JSON, with the
    // ETag of bytes the GET never sends.
    for (const accept of ["application/json", "text/markdown"]) {
      const get = await app.request("/v1/seek?q=aarch64", { headers: { Accept: accept } });
      const head = await app.request("/v1/seek?q=aarch64", { method: "HEAD", headers: { Accept: accept } });
      assert.equal(get.status, 200, accept);
      assert.ok(get.headers.get("etag"), `${accept}: a public read carries a validator`);
      assert.equal(head.headers.get("content-type"), get.headers.get("content-type"), accept);
      assert.equal(head.headers.get("etag"), get.headers.get("etag"), accept);
    }
  });

  test("the two registration routes hold their bodies to the same rule as every other body", async () => {
    // Every request body is held to parseStrictJson, these two included, which
    // answer a caller with no credential at all. The value has to be one the
    // route would otherwise accept, or the test proves only that a bad public key
    // is refused: an unknown field is ignored by every route, so an integer past
    // 2^53 in one is refused by the parser and nothing else, where ordinary
    // JSON.parse silently rounds it and answers 200.
    const key = "a".repeat(64);
    const ok = await app.request("/v1/keys/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: key }),
    });
    assert.equal(ok.status, 200, "the control case must be accepted");

    for (const body of [
      `{"public_key":"${key}","x":9007199254740993}`,
      `{"public_key":"${key}","x":1e999}`,
      `{"public_key":"${key}","x":"\\ud800"}`,
    ]) {
      const res = await app.request("/v1/keys/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 400, `accepted a body the strict parser refuses: ${body}`);
    }
  });
});

describe("a body read leniently", () => {
  test("an empty body is no fields, and anything else is held to the strict rule", async () => {
    const read = (text: string) => readBody({ req: { text: async () => text } });
    assert.deepEqual(await read(""), {});
    assert.deepEqual(await read(" \n"), {});
    assert.deepEqual(await read('{"a":1}'), { a: 1 });
    for (const text of ["[]", "null", "{", '{"x":9007199254740993}', '{"x":"\\u0000"}']) {
      await assert.rejects(read(text), (e: unknown) => e instanceof ApiError && e.code === "INVALID_REQUEST", text);
    }
  });
});

describe("one section of many documents: its parameters are checked at the edge", () => {
  const refusal = async (query: string) => {
    const out = await request("GET", `/v1/documents?${query}`);
    assert.equal(out.status, 400, `${query}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    return out.body.error.detail as string;
  };

  test("the order asked is kept, and a name given twice keeps its first place", async () => {
    const out = await request("GET", "/v1/documents?spaces=zeta-space,alpha-space,zeta-space,mid-space&section=status");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.items.map((i: { space: string }) => i.space), ["zeta-space", "alpha-space", "mid-space"]);
  });

  test("0 or 21 names, a name off the grammar, no section, a capital and a version are refused, each saying why", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `space-${i}`).join(",");
    assert.equal(await refusal("section=status"), "spaces is 1 to 20 SPACE names, comma separated");
    assert.equal(await refusal("spaces=,,&section=status"), "spaces is 1 to 20 SPACE names, comma separated");
    assert.equal(await refusal(`spaces=${many}&section=status`), "spaces is 1 to 20 SPACE names, comma separated");
    assert.equal(await refusal("spaces=Bad_Name&section=status"), "spaces are SPACE names: 3 to 63 lowercase letters, digits and hyphens");
    assert.equal(await refusal("spaces=good-name"), "section is required: the section id to read in each document, such as status");
    assert.equal(await refusal("spaces=good-name&section=Status"), "section ids are lowercase, such as status");
    assert.equal(await refusal("spaces=good-name&section=a%20b"), "section is a section id the document names");
    assert.equal(await refusal("spaces=good-name&section=status&version=3"), "version reads one document: send it to GET /v1/spaces/(name)/document");
    // Twenty is the most, and counts before duplicates go, as ids do.
    const twenty = Array.from({ length: 20 }, (_, i) => `space-${i}`).join(",");
    assert.equal((await request("GET", `/v1/documents?spaces=${twenty}&section=status`)).status, 200);
  });
});
