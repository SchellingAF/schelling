// What the deployment files keep out of an image and out of the proxy's trust.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { read, sh, shellFunction } from "./lib/shell.ts";

test("the build context leaves out every file that holds a secret", () => {
  const ignored = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const entry of [".env", ".env.*", "secrets", "**/*.pem", ".dev.vars", "postgres/pgbackrest.conf", "incidents", ".claude"]) {
    assert.ok(ignored.includes(entry), `.dockerignore does not name ${entry}`);
  }
});

test("the passphrase reaches pgbackrest.conf exactly as it is in the secret file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cipher-"));
  try {
    const template = path.join(dir, "template");
    writeFileSync(template, "repo1-cipher-pass=__BACKUP_CIPHER__\n");
    for (const cipher of ["plainAlnum0123456789", "has__BACKUP_CIPHER__inside0123456789", "has&ampersand|pipe\\backslash/slash0123456789"]) {
      const secret = path.join(dir, "secret");
      writeFileSync(secret, cipher);
      const target = path.join(dir, "conf");
      const result = sh(`
        set -eu
        ${shellFunction(read("scripts/first-run.sh"), "write_backup_conf")}
        write_backup_conf ${JSON.stringify(secret)} ${JSON.stringify(template)} ${JSON.stringify(target)}
      `);
      assert.equal(result.code, 0, result.out);
      assert.equal(readFileSync(target, "utf8"), `repo1-cipher-pass=${cipher}\n`);
      assert.equal(statSync(target).mode & 0o077, 0, "the file was readable by others");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the database password the service role is made with is readable at initdb by the database's own user", () => {
  const firstRun = read("scripts/first-run.sh");
  const line = firstRun.split("\n").find((l) => l.startsWith("chmod 644") && l.includes("migrate_db_password"));
  assert.ok(line, "no chmod 644 line for the shared passwords");
  assert.ok(line.includes("api_db_password"), "api_db_password is read by postgres at initdb and is not made readable to it");
  assert.doesNotMatch(firstRun, /chown "\$NODE_UID:\$NODE_UID" "\$ROOT\/secrets\/api_db_password"/);
});
