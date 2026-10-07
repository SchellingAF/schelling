// examples/two-runs.sh signs a challenge only for the host it was pointed at.
//
// A token challenge is signed over its host, so that a challenge relayed through a
// look-alike service cannot be redeemed anywhere but where it was fetched. That holds
// only while the signer names the host it is talking to: a script that took the host to
// sign for from the service's own answer would let a look-alike name the real service,
// relay its challenge, and redeem the signature there as this KEY. The bridge refuses
// such a challenge; so must the example.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../examples/two-runs.sh", import.meta.url).pathname;

/** A service that answers the script's first calls, naming `audience` as the host to sign
 *  for, and records every path asked. */
async function lookAlike(audience: (own: string) => string) {
  const asked: string[] = [];
  let own = "";
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/capabilities") return res.end(JSON.stringify({ protocol: { challenge_audience: audience(own) } }));
      if (req.url === "/v1/keys/challenge") return res.end(JSON.stringify({ challenge: "ab".repeat(32), audience: audience(own) }));
      // Anything after the challenge: refused, so the script stops there either way.
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: "INVALID_REQUEST" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  own = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin: `http://${own}`, asked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function runScript(api: string, keydir: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", [SCRIPT], { env: { PATH: process.env.PATH ?? "", HOME: keydir, API: api, KEYDIR: keydir } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

describe("the example script", () => {
  test("refuses to sign a challenge for a host other than the one it was pointed at", async () => {
    const keydir = mkdtempSync(join(tmpdir(), "schellingaf-two-runs-"));
    const service = await lookAlike(() => "api.schellingaf.com");
    try {
      const run = await runScript(service.origin, keydir);
      assert.notEqual(run.code, 0, `the script went on:\n${run.out}\n${run.err}`);
      assert.equal(service.asked.some((line) => line.startsWith("POST /v1/keys/verify")), false, `a signature was sent for another host:\n${service.asked.join("\n")}`);
      assert.equal(service.asked.some((line) => line.startsWith("POST /v1/keys/challenge")), false, "a challenge was fetched before the host was checked");
      assert.match(run.err, /api\.schellingaf\.com/);
    } finally {
      await service.close();
      rmSync(keydir, { recursive: true, force: true });
    }
  });

  test("and signs for the host it was pointed at, as before", async () => {
    const keydir = mkdtempSync(join(tmpdir(), "schellingaf-two-runs-"));
    const service = await lookAlike((own) => own);
    try {
      await runScript(service.origin, keydir);
      // The look-alike refuses the verify, so the script stops there; it got that far.
      assert.ok(service.asked.some((line) => line.startsWith("POST /v1/keys/verify")), service.asked.join("\n"));
    } finally {
      await service.close();
      rmSync(keydir, { recursive: true, force: true });
    }
  });
});
