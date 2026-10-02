// The service behind whatever terminates TLS in front of it: where it reads a
// caller's address (CLIENT_ADDRESS_FROM), and the two transport headers it sets
// itself on every answer, so that neither depends on which proxy stands in front.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useService, app, db, config, send, read, agent, HOST } from "./lib/service.ts";
import { withEnv } from "./lib/env.ts";
import { ROOT } from "./lib/shell.ts";
import { createApp } from "../src/http/app.ts";
import { loadConfig, type ClientAddressFrom } from "../src/config.ts";
import { CATEGORY_LOOKUPS_PER_MINUTE, addressFrom, resetReadWindows, withinReadWindow } from "../src/http/ratelimit.ts";
import { endAllStreams, allowStreamsAgain } from "../src/mcp/listen.ts";

useService("proxy");

/** A request as a proxy might hand it over: a forwarded-for list whose last entry
 * is not its first, a real-address header, and the connection's own address. */
const FORWARDED = "203.0.113.9, 198.51.100.7";
const REAL_IP = "192.0.2.1";
const SOCKET = "192.0.2.50";

/** What each setting reads that request as. */
const EXPECTED: Record<ClientAddressFrom, string> = {
  "last-forwarded": "198.51.100.7",
  "first-forwarded": "203.0.113.9",
  "x-real-ip": "192.0.2.1",
  socket: "192.0.2.50",
};
const MODES = Object.keys(EXPECTED) as ClientAddressFrom[];

/** The smallest thing addressFrom reads: headers, and the socket the Node server
 * hands over (absent when `socket` is null). */
function requestWith(headers: Record<string, string>, socket: string | null = SOCKET) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: { header: (name: string) => lower.get(name.toLowerCase()) },
    env: socket === null ? {} : { incoming: { socket: { remoteAddress: socket } } },
  } as never;
}

describe("where the caller's address is read", () => {
  test("each setting reads its own place, and only that place", () => {
    const spoofed = requestWith({ "X-Forwarded-For": FORWARDED, "X-Real-IP": REAL_IP });
    for (const mode of MODES) assert.equal(addressFrom(spoofed, mode), EXPECTED[mode], mode);
  });

  test("a header that is absent or empty falls back to the socket, never to another header", () => {
    const rows: [ClientAddressFrom, Record<string, string>][] = [
      ["last-forwarded", { "X-Real-IP": REAL_IP }],
      ["last-forwarded", { "X-Forwarded-For": "203.0.113.9, ", "X-Real-IP": REAL_IP }],
      ["first-forwarded", { "X-Real-IP": REAL_IP }],
      ["first-forwarded", { "X-Forwarded-For": " , 198.51.100.7" }],
      ["x-real-ip", { "X-Forwarded-For": FORWARDED }],
      ["x-real-ip", { "X-Forwarded-For": FORWARDED, "X-Real-IP": "  " }],
    ];
    for (const [mode, headers] of rows) {
      assert.equal(addressFrom(requestWith(headers), mode), SOCKET, `${mode} with ${JSON.stringify(headers)}`);
      // And with no socket either, the one shared bucket.
      assert.equal(addressFrom(requestWith(headers, null), mode), "unattributable", `${mode} with no socket`);
    }
  });

  test("the setting is read at start, unset is last-forwarded, and a value it cannot read refuses the start", async () => {
    const load = (value: string | undefined) =>
      withEnv(
        {
          API_HOST: "proxy.invalid",
          PUBLIC_ORIGIN: "https://proxy.invalid",
          CHALLENGE_KEY: "a-challenge-key-that-is-long-enough",
          CHALLENGE_KEY_FILE: undefined,
          DB_PASSWORD: "a-db-password-that-is-long-enough",
          DB_PASSWORD_FILE: undefined,
          REQUIRE_APPROVED_COPY: undefined,
          LOG_DIR: undefined,
          CLIENT_ADDRESS_FROM: value,
        },
        () => loadConfig(),
      );
    assert.equal((await load(undefined)).clientAddressFrom, "last-forwarded");
    assert.equal((await load("")).clientAddressFrom, "last-forwarded");
    for (const mode of MODES) assert.equal((await load(mode)).clientAddressFrom, mode);
    assert.equal((await load(" First-Forwarded ")).clientAddressFrom, "first-forwarded");
    for (const unreadable of ["first", "x-forwarded-for", "proxy", "none"]) {
      await assert.rejects(
        load(unreadable),
        (error: Error) => {
          assert.match(error.message, new RegExp(`CLIENT_ADDRESS_FROM is "${unreadable}"`));
          for (const mode of MODES) assert.ok(error.message.includes(mode), `the refusal does not name ${mode}`);
          return true;
        },
        `CLIENT_ADDRESS_FROM=${unreadable} started`,
      );
    }
  });
});

describe("behind an edge that writes the visitor first", () => {
  test("a per-address limit holds the visitor, whatever entries follow it", async (t) => {
    // The clock stands still at the start of a minute, so the window cannot roll
    // over between the last lookup it allows and the one it must refuse.
    t.mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now() / 60_000) * 60_000 });
    resetReadWindows();
    const edge = createApp({ ...config, clientAddressFrom: "first-forwarded" }, db);
    const from = (visitor: string, i: number) => ({ "X-Forwarded-For": `${visitor}, 10.0.${i >> 8 & 255}.${i & 255}` });
    for (let i = 0; i < CATEGORY_LOOKUPS_PER_MINUTE; i++) {
      const r = await send(edge, "GET", `/v1/categories?q=qqzz${i}`, null, undefined, from("203.0.113.9", i));
      if (r.status !== 200) assert.fail(`lookup ${i} answered ${r.status}`);
    }
    const refused = await read(await send(edge, "GET", "/v1/categories?q=vllm", null, undefined, from("203.0.113.9", 99_999)));
    assert.equal(refused.status, 429, "a new trailing entry bought a new allowance");
    assert.equal(refused.body.error.code, "RATE_LIMITED");
    // Another visitor is its own, with the very trailing entry the first one had.
    const other = await send(edge, "GET", "/v1/categories?q=vllm", null, undefined, from("203.0.113.10", 0));
    assert.equal(other.status, 200);
    resetReadWindows();
  });
});

describe("the connector's own calls are limited as their caller, under every setting", () => {
  /** A category lookup through the connector, from the request a proxy handed over. */
  async function lookupThroughConnector(on: ReturnType<typeof createApp>, headers: Record<string, string>, socket = SOCKET) {
    const res = await on.fetch(
      new Request(`https://${HOST}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "schellingaf_spaces", arguments: { action: "categories", q: "vllm" } },
        }),
      }),
      { incoming: { socket: { remoteAddress: socket } } },
    );
    const text = await res.text();
    const message = text.startsWith("event:") || text.startsWith("data:")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5))
      : JSON.parse(text);
    return { status: res.status, result: message.result as { isError?: boolean; content: { text: string }[] } };
  }

  /** Spend an address's whole lookup window, as if it had looked up a minute's worth. */
  function exhaustLookups(address: string): void {
    for (let i = 0; i < CATEGORY_LOOKUPS_PER_MINUTE; i++) withinReadWindow(`lookup:${address}`, CATEGORY_LOOKUPS_PER_MINUTE);
  }

  for (const mode of MODES) {
    test(`${mode}: the call a tool makes is the caller's, not one shared bucket`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now() / 60_000) * 60_000 });
      resetReadWindows();
      const on = createApp({ ...config, clientAddressFrom: mode }, db);
      const headers = { "X-Forwarded-For": FORWARDED, "X-Real-IP": REAL_IP };

      const fresh = await lookupThroughConnector(on, headers);
      assert.equal(fresh.status, 200);
      assert.notEqual(fresh.result.isError, true, fresh.result.content[0]?.text ?? "no text");

      // Only the address this setting reads is spent: the tool's lookup is refused
      // exactly when its caller's own window is full.
      exhaustLookups(EXPECTED[mode]);
      const spent = await lookupThroughConnector(on, headers);
      assert.equal(spent.result.isError, true, `${mode}: the tool's lookup was not counted as ${EXPECTED[mode]}`);
      assert.match(spent.result.content[0]!.text, /RATE_LIMITED/);
      resetReadWindows();
    });
  }

  test("an IPv6 caller's call through the connector is limited on its own /64", async (t) => {
    // The address is carried to the tool's call as the bucket it was read as. Written
    // back into a header, a /64 bucket is not an address any more, and every IPv6
    // caller's connector calls shared the one bucket kept for what does not parse.
    t.mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now() / 60_000) * 60_000 });
    resetReadWindows();
    const headers = { "X-Forwarded-For": "2001:db8:7:8::1" };
    exhaustLookups("2001:db8:7:8::/64");
    const spent = await lookupThroughConnector(app, headers);
    assert.equal(spent.result.isError, true, "the tool's lookup was not counted against the caller's /64");
    resetReadWindows();
    exhaustLookups("unparseable");
    const neighbour = await lookupThroughConnector(app, headers);
    assert.notEqual(neighbour.result.isError, true, "the tool's lookup was counted against the unparseable bucket");
    resetReadWindows();
  });
});

describe("the transport headers are the service's own", () => {
  const HSTS = "max-age=63072000; includeSubDomains; preload";
  const held = (res: { headers: Headers }, what: string) => {
    assert.equal(res.headers.get("Strict-Transport-Security"), HSTS, `${what}: no HSTS`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", `${what}: no nosniff`);
  };

  test("on a JSON answer, the primer, a document, a 404 and a refusal", async () => {
    const json = await app.request("/v1/capabilities");
    assert.equal(json.status, 200);
    held(json, "GET /v1/capabilities");
    const primer = await app.request("/");
    assert.equal(primer.status, 200);
    held(primer, "GET /");
    const reference = await app.request("/reference");
    assert.equal(reference.status, 200);
    held(reference, "GET /reference");
    const missing = await app.request("/v1/nope");
    assert.equal(missing.status, 404);
    held(missing, "a 404");
    const refused = await app.request("/v1/me");
    assert.equal(refused.status, 401);
    held(refused, "a 401");
    const notModified = await app.request("/", { headers: { "If-None-Match": primer.headers.get("ETag")! } });
    assert.equal(notModified.status, 304);
    held(notModified, "a 304");
  });

  test("on a tool's answer and on a live stream, before its first bytes", async () => {
    const tool = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "schellingaf_spaces", arguments: { action: "list" } } }),
    });
    assert.equal(tool.status, 200);
    held(tool, "a tool call");
    await tool.text();

    const key = await agent();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: `Bearer ${key.token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "listen:headers",
        method: "subscriptions/listen",
        params: {
          notifications: { resourceSubscriptions: ["schellingaf://mailbox"] },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
        },
      }),
    });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    held(res, "a live stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "the stream sent nothing");
    endAllStreams();
    allowStreamsAgain();
    await reader.cancel();
  });
});

describe("the outside check", () => {
  // scripts/verify.sh run whole, with a curl that answers only the plain-HTTP request
  // and a dig that resolves nothing, so nothing leaves this machine.
  const bin = mkdtempSync(path.join(tmpdir(), "verify-"));
  writeFileSync(
    path.join(bin, "curl"),
    [
      "#!/bin/sh",
      'fmt=""; url=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in -w) fmt="$2"; shift ;; http://*|https://*) url="$1" ;; esac',
      "  shift",
      "done",
      'case "$url" in http://*) ;; *) exit 0 ;; esac',
      `printf '%s' "$fmt" | sed -e "s|%{http_code}|$FAKE_CODE|" -e "s|%{redirect_url}|$FAKE_LOCATION|"`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(bin, "dig"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "curl"), 0o755);
  chmodSync(path.join(bin, "dig"), 0o755);
  after(() => rmSync(bin, { recursive: true, force: true }));

  /** The line verify.sh printed about plain HTTP, and everything it printed. */
  function plainHttpLine(code: string, location = ""): { line: string; out: string } {
    const run = spawnSync("/bin/sh", [path.join(ROOT, "scripts/verify.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        API: "https://api.example.test",
        CURL: path.join(bin, "curl"),
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_CODE: code,
        FAKE_LOCATION: location,
      },
    });
    const out = run.stdout;
    const line = out.split("\n").find((l) => l.includes("plain HTTP")) ?? "";
    return { line, out };
  }

  test("plain HTTP passes when refused with 426 or sent permanently to the https address, and fails otherwise", () => {
    const pass: [string, string][] = [
      ["426", ""],
      ["301", "https://api.example.test/healthz"],
      ["308", "https://api.example.test/healthz"],
    ];
    for (const [code, location] of pass) {
      const { line } = plainHttpLine(code, location);
      assert.match(line, /^\s+ok\s+plain HTTP is never served/, `${code} ${location}: ${line}`);
    }
    const fail: [string, string][] = [
      ["200", ""],
      ["204", ""],
      ["301", "http://api.example.test/healthz"],
      ["302", "https://api.example.test/healthz"],
      ["301", "https://api.example.test.elsewhere.example/healthz"],
      ["000", ""],
    ];
    for (const [code, location] of fail) {
      const { line } = plainHttpLine(code, location);
      assert.match(line, /^\s+FAIL\s+plain HTTP is never served/, `${code} ${location}: ${line}`);
    }
  });

  test("where the name points is printed, with no verdict on it", () => {
    const { out } = plainHttpLine("301", "https://api.example.test/healthz");
    assert.match(out, /api\.example\.test resolves to:/);
    assert.doesNotMatch(out, /Confirm these are|not a proxy/);
  });
});
