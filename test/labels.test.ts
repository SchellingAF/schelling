// Every protocol label is written down once, and nothing uses one that is not.
//
// A label is what keeps one signature from being valid for two statements: the
// bytes a KEY signs for a post start with "agent-state:object-signature:v1" and a
// NUL, and no other preimage anywhere starts with that. So two labels spelled the
// same, or a label used in a migration that the registry never heard of, would be
// a signature that means two things.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "../src/domain/protocol.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = /agent-state:[a-z0-9-]+:v[0-9]+/g;

/** Every label in use, with the name of its constant: each LABEL_ export of protocol.ts. */
const IN_USE = Object.entries<unknown>(protocol).filter(
  (entry): entry is [string, string] => entry[0].startsWith("LABEL_") && typeof entry[1] === "string",
);
/** The whole registry: every label in use, then every one reserved. */
const ALL: string[] = [...IN_USE.map(([, label]) => label), ...protocol.RESERVED_LABELS];

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|sql|mjs|md|sh|json)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the protocol label registry", () => {
  test("names every label once, in use or reserved, and never both", () => {
    assert.equal(new Set(ALL).size, ALL.length, "a label is listed twice");
    for (const label of protocol.RESERVED_LABELS) {
      assert.equal(IN_USE.some(([, used]) => used === label), false, `${label} is both reserved and in use`);
    }
    for (const label of ALL) assert.match(label, /^agent-state:[a-z0-9-]+:v[0-9]+$/, label);
  });

  test("every label written in the code, the migrations, the scripts or the documents is in it", () => {
    const unknown = new Map<string, string>();
    for (const dir of ["src", "migrations", "scripts", "examples", "content", "test", "runbooks"]) {
      let found: string[];
      try {
        found = files(path.join(ROOT, dir));
      } catch {
        continue;
      }
      for (const file of found) {
        for (const match of readFileSync(file, "utf8").matchAll(LABEL)) {
          if (!ALL.includes(match[0])) unknown.set(match[0], path.relative(ROOT, file));
        }
      }
    }
    assert.deepEqual([...unknown], [], "these labels are used and never registered");
  });

  // content/ counts: the sealed labels are used by content/sealed.mjs, the code that
  // seals and opens on an agent's machine and in a person's browser, and by nothing
  // on the service, which never holds a secret.
  test("every label in use is used somewhere outside the registry", () => {
    const text = ["src", "migrations", "content"]
      .flatMap((dir) => files(path.join(ROOT, dir)))
      .filter((file) => !file.endsWith(path.join("domain", "protocol.ts")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const [constant, label] of IN_USE) {
      assert.ok(text.includes(label) || text.includes(constant), `${label} is registered as in use and nothing uses it`);
    }
  });
});
