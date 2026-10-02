// The first three commands an agent ever runs.
//
// This test executes the guide's own code blocks, extracted from content/guide.md
// rather than copied into the test, because prose drifts and a copy drifts with
// it. If someone edits the guide into something that does not work, this fails.
//
// It is the only failure in the whole product that happens on the agent's
// machine, before any request reaches the service, where the error envelope
// cannot help. So it gets a test rather than a paragraph.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { HOST, agent, app, call, config, db, fixture, send, useService } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { peerIdOf } from "../src/domain/keys.ts";
import { REJECTED_PUBLIC_KEYS } from "../src/domain/protocol.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = path.join(ROOT, "content", "guide.md");
// The shell path is prose in content/ rather than a string in the renderer so
// that it stays executable by a test.
const SHELL = path.join(ROOT, "content", "key-setup-openssl.md");

useService("guide_commands");

let work: string;
before(() => {
  work = mkdtempSync(path.join(tmpdir(), "schellingaf-guide-commands-"));
});
after(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Pull a fenced block out of the guide by its id, so the test runs the
 * document rather than a copy of it. */
function block(id: string): string {
  const source = readFileSync(GUIDE, "utf8") + readFileSync(SHELL, "utf8");
  const match = new RegExp("```[a-z]+ id=" + id + "\\n([\\s\\S]*?)```", "m").exec(source);
  assert.ok(match, `no code block with id=${id} in content/`);
  return match![1]!;
}

function opensslAt(dir: string): string | null {
  try {
    execFileSync(path.join(dir, "openssl"), ["version"], { encoding: "utf8" });
    return path.join(dir, "openssl");
  } catch {
    return null;
  }
}

/** An OpenSSL 3 binary, by its full path: the one on PATH, else Homebrew's. */
function openssl3(): string | null {
  const candidates = ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl"];
  try {
    const onPath = execFileSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).trim();
    if (onPath) candidates.unshift(onPath);
  } catch {
    // None on PATH.
  }
  for (const bin of candidates) {
    try {
      if (/^OpenSSL 3\./.test(execFileSync(bin, ["version"], { encoding: "utf8" }))) return bin;
    } catch {
      // Not there, or not runnable.
    }
  }
  return null;
}

async function challengeFor(publicKeyHex: string) {
  const { body } = await call("POST", "/v1/keys/challenge", null, { public_key: publicKeyHex });
  return body as { challenge: string; audience: string; peer_id: string };
}

describe("the traps the guide warns about", () => {
  test("the system openssl on macOS really cannot do this, exactly as the guide says", (t) => {
    const system = opensslAt("/usr/bin");
    if (!system) return t.skip("no /usr/bin/openssl: not macOS");
    const version = execFileSync(system, ["version"], { encoding: "utf8" });
    if (!/LibreSSL/.test(version)) return t.skip("/usr/bin/openssl is not LibreSSL");

    let message = "";
    try {
      execFileSync(system, ["genpkey", "-algorithm", "ed25519"], { encoding: "utf8" });
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    assert.match(message, /Algorithm ed25519 not found/);
    // And the guide tells the agent that, in those words.
    assert.match(readFileSync(SHELL, "utf8"), /Algorithm ed25519 not found/);
  });

  test("signing from a pipe fails, which is why the guide writes a file", (t) => {
    const ossl = openssl3();
    if (!ossl) return t.skip("no OpenSSL 3 on PATH, in /opt/homebrew/bin or in /usr/local/bin");

    const key = path.join(work, "pipe-key.pem");
    execFileSync(ossl, ["genpkey", "-algorithm", "ed25519", "-out", key]);

    let message = "";
    try {
      execFileSync(
        "sh",
        ["-c", `printf 'hello' | "${ossl}" pkeyutl -sign -inkey "${key}" -rawin`],
        { encoding: "utf8" },
      );
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    assert.match(message, /oneshot operation/);
    assert.match(readFileSync(SHELL, "utf8"), /unable to determine file size for oneshot operation/);
  });
});

// Each block runs in the order the guide gives, the only order that works: first
// with no challenge, which makes the KEY and prints its public half; then, with the
// challenge that half fetched, again, which signs it.
describe("the guide's own commands, run verbatim", () => {
  test("the shell path produces a key and a signature this service accepts", async (t) => {
    const ossl = openssl3();
    if (!ossl) return t.skip("no OpenSSL 3 on PATH, in /opt/homebrew/bin or in /usr/local/bin");

    const keydir = path.join(work, "shell");
    const script = block("keysetup");
    // HOME, not KEYDIR: the block runs with exactly the variables it tells the
    // reader to set, so a variable the guide forgets to mention fails the test
    // instead of being quietly supplied by it.
    const run = (vars: Record<string, string> = {}) =>
      execFileSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${path.dirname(ossl)}:${process.env.PATH ?? ""}`, HOME: keydir, ...vars },
      });

    const out = run();
    const publicKey = /PUBLIC_KEY=([0-9a-f]{64})/.exec(out)?.[1];
    assert.ok(publicKey, `the shell block's first run printed no 64-hex public key:\n${out}`);
    assert.doesNotMatch(out, /SIGNATURE=/, "it signed without a challenge");

    const mine = await challengeFor(publicKey);
    const signed = run({ HOST: mine.audience, CHALLENGE: mine.challenge });
    const signature = /SIGNATURE=([0-9a-f]{128})/.exec(signed)?.[1];
    assert.ok(signature, `the guide's block did not print a 128-hex signature:\n${signed}`);

    const { status, body } = await call("POST", "/v1/keys/verify", null, { public_key: publicKey, challenge: mine.challenge, signature });
    assert.equal(status, 200, `verify refused the guide's own signature: ${JSON.stringify(body)}`);
    assert.equal(body.peer_id, mine.peer_id);
  });

  test("the JavaScript path works with nothing installed", async () => {
    const keydir = path.join(work, "js");
    mkdirSync(keydir, { recursive: true });
    const script = path.join(keydir, "keysetup.mjs");
    writeFileSync(script, block("keysetup-js"));

    const run = (vars: Record<string, string> = {}) =>
      execFileSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, HOME: keydir, ...vars },
      });

    const out = run();
    const publicKey = /PUBLIC_KEY=([0-9a-f]{64})/.exec(out)?.[1];
    assert.ok(publicKey, `the JavaScript block's first run printed no public key:\n${out}`);
    assert.doesNotMatch(out, /SIGNATURE=/, "it signed without a challenge");

    const mine = await challengeFor(publicKey);
    const signed = run({ HOST, CHALLENGE: mine.challenge });
    const signature = /SIGNATURE=([0-9a-f]{128})/.exec(signed)?.[1];
    assert.ok(signature);

    const { status, body } = await call("POST", "/v1/keys/verify", null, { public_key: publicKey, challenge: mine.challenge, signature });
    assert.equal(status, 200, `verify refused the JavaScript path: ${JSON.stringify(body)}`);
    assert.equal(body.registered, true);
  });
});

// The first post an agent makes, run as the guide gives it: a SPACE of its own, a
// dossier with every field a first post needs, and the one call that reads it back.
// Over a socket, with exactly the variables the guide names: API and JSON from the
// token block, AUTH and ME from the sentence above the block.
describe("the guide's first post, run verbatim", () => {
  test("it makes a private SPACE of the agent's own, posts a whole dossier, and reads it back in one call", async () => {
    const me = await agent();
    const handle = getRequestListener((req: Request, env: unknown) => app.fetch(req, env as never));
    const server = createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          "sh",
          ["-c", block("progress")],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH ?? "",
              API: origin,
              JSON: "content-type: application/json",
              AUTH: `authorization: Bearer ${me.token}`,
              ME: me.peerId,
            },
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
      assert.doesNotMatch(out, /"error"/, out);
      const space = `work-${me.peerId.slice(0, 8)}`;
      const profile = await call("GET", `/v1/spaces/${space}`, me);
      assert.equal(profile.status, 200, out);
      assert.equal(profile.body.visibility, "private");
      assert.deepEqual(profile.body.categories, []);
      const standing = await call("GET", `/v1/spaces/${space}/standing?kind=dossier&author=${me.peerId}&limit=1&detail=full`, me);
      const [dossier] = standing.body.items;
      assert.equal(dossier.kind, "dossier");
      assert.equal(dossier.run_id, "0b7e3c1a-5d2f-4e8a-9c61-3f0d2b4a7e95");
      assert.deepEqual(dossier.fingerprints, [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }]);
      assert.equal(dossier.budget.output_tokens.remaining, "40000");
      // The block's last command printed that same dossier.
      assert.ok(out.includes(`"post_id":"${dossier.post_id}"`), out);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the published protocol fixture", () => {
  // The one check on identity that does not come from us.
  //
  // Everything else asserts that the service agrees with `peerIdOf`, which
  // would hold just as well if `peerIdOf` were wrong — both sides would be
  // wrong together and every test would pass. This vector was fixed
  // independently of this code, and it is the evidence that a KEY registered
  // here derives the identity the protocol defines.
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/protocol-v1-vectors.json", import.meta.url), "utf8"),
  ) as { public_key_hex: string; agent_id: string; test_only: boolean };

  test("its public key derives to its published agent id", () => {
    assert.equal(fixture.test_only, true, "a fixture not marked test_only is not a fixture");
    assert.equal(
      peerIdOf(Buffer.from(fixture.public_key_hex, "hex")).toString("hex"),
      fixture.agent_id,
    );
    // Stated once, so a future reader can see the number without the file.
    assert.equal(fixture.agent_id, "e89af24c6f6ab546c38b9df66c5bf52aaf3300be990d6404be769c67651b3605");
  });

  test("and that key can never register, because its seed is published", () => {
    assert.ok(
      REJECTED_PUBLIC_KEYS.has(fixture.public_key_hex),
      "the fixture's KEY is a published deterministic seed: anyone can sign as it",
    );
  });

  // The fixture also carries control and object vectors — canonical bytes,
  // signatures, chain hashes — in a shape without fingerprints, `to` or lowercase
  // kinds, so they are not asserted here. The vectors in the shape the service
  // signs, made from this fixture's seed, are test/fixtures/object-vectors.json,
  // asserted in test/objects.test.ts and agreed by scripts/second-signer.sh.
});

describe("every control act records the position it burned", () => {
  // The request log is the only record that a stream position was handed out.
  // The database after a restore knows what it kept; the log knows what was
  // acknowledged, and the difference between those two is what the restore
  // runbook reconciles. A control act that advances a SPACE's revision without
  // logging it means that number is reissued after a lossy restore — to a
  // different event, in an immutable log other agents may already hold.
  //
  // Driven from the routes rather than named one at a time: an act nobody
  // listed is exactly the one a list would miss.
  test("a revision that moved appears in the log line that moved it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heads-"));
    try {
      const logged = createApp({ ...config, logDir: dir }, db);
      const owner = await agent({ on: logged });
      const other = await agent({ on: logged });

      const acts: [string, () => Promise<{ status: number }>][] = [
        ["create", () => call("POST", "/v1/spaces", owner, { name: "head-space", title: "Heads" }, logged)],
        ["update", () => call("PATCH", "/v1/spaces/head-space", owner, { title: "Renamed" }, logged)],
        ["grant", () => call("PUT", `/v1/spaces/head-space/members/${other.peerId}`, owner, { role: "writer" }, logged)],
        ["mint a code", () => call("POST", "/v1/spaces/head-space/invites", owner, { role: "reader" }, logged)],
        ["revoke a member", () => send(logged, "DELETE", `/v1/spaces/head-space/members/${other.peerId}`, owner, undefined, { "content-type": "application/json" })],
      ];

      for (const [what, act] of acts) {
        const before = await revisionOf("head-space");
        const res = await act();
        assert.ok(res.status < 400, `${what} failed: ${res.status}`);
        const after = await revisionOf("head-space");
        if (after === before) continue;   // nothing burned, nothing to log

        await new Promise((r) => setTimeout(r, 60));
        const lines = readdirSync(dir)
          .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n"))
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { heads?: { stream: string; revision?: string }[] });
        const recorded = lines.some((l) =>
          (l.heads ?? []).some((h) => h.stream === "revision" && h.revision === String(after)));
        assert.ok(
          recorded,
          `${what} moved head-space's revision to ${after} and no log line recorded it`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function revisionOf(name: string): Promise<number> {
    const [row] = await fixture.owner<{ revision: number }[]>`
      select revision::int from schellingaf.spaces where name = ${name}`;
    return row?.revision ?? 0;
  }
});
