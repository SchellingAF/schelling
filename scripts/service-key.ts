// Make the service's root key, certify an online key with it, and check the result.
//
// Run on the operator's own machine, never on the server. The root key identifies the
// service for good: every checkpoint, receipt and recovery notice is trusted because
// a certificate this key signed names the key that signed it. Keep root.pem offline
// and backed up; the server receives only the online key and its certificate.
//
//   node scripts/service-key.ts root <directory>
//       writes <directory>/root.pem (readable only by you) and prints the root's
//       public key, which goes in SERVICE_ROOT_KEY and wherever the service
//       publishes it.
//
//   node scripts/service-key.ts online <directory> --root <root.pem> [--days 365]
//       writes <directory>/service_signing_key.pem and
//       <directory>/service_certificate.json, the two files SERVICE_KEY_FILE and
//       SERVICE_CERTIFICATE_FILE name.
//
//   node scripts/service-key.ts check <service_signing_key.pem> <service_certificate.json> [--root <hex>]
//       says whether the service would start with them.

import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { certify, ed25519PublicKeyOf, loadServiceKey } from "../src/domain/service.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function option(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? fail(`${name} needs a value`));
}

function writeSecret(file: string, contents: string): void {
  if (existsSync(file)) fail(`${file} already exists. Nothing was overwritten.`);
  writeFileSync(file, contents, { mode: 0o600 });
}

const [command, first, second] = process.argv.slice(2);

switch (command) {
  case "root": {
    if (!first) fail("usage: node scripts/service-key.ts root <directory>");
    mkdirSync(first, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeSecret(path.join(first, "root.pem"), privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    process.stdout.write(`root key written to ${path.join(first, "root.pem")}\nSERVICE_ROOT_KEY=${ed25519PublicKeyOf(privateKey).toString("hex")}\n`);
    break;
  }
  case "online": {
    const rootFile = option("--root");
    if (!first || !rootFile) fail("usage: node scripts/service-key.ts online <directory> --root <root.pem> [--days 365]");
    const days = Number(option("--days") ?? 365);
    if (!Number.isInteger(days) || days < 1 || days > 3650) fail("--days is a whole number of days from 1 to 3650");
    const root = createPrivateKey(readFileSync(rootFile, "utf8"));
    if (root.asymmetricKeyType !== "ed25519") fail(`${rootFile} is not an Ed25519 key`);
    mkdirSync(first, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    const now = new Date();
    const { canonical, signature } = certify(root, ed25519PublicKeyOf(privateKey), {
      notBefore: now,
      notAfter: new Date(now.getTime() + days * 86_400_000),
    });
    writeSecret(path.join(first, "service_signing_key.pem"), privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    writeFileSync(
      path.join(first, "service_certificate.json"),
      `${JSON.stringify({ certificate: canonical.toString("base64url"), signature: signature.toString("hex") }, null, 2)}\n`,
    );
    process.stdout.write(
      `online key and certificate written to ${first}, valid for ${days} days\n` +
        `certified key ${ed25519PublicKeyOf(privateKey).toString("hex")} under root ${ed25519PublicKeyOf(root).toString("hex")}\n`,
    );
    break;
  }
  case "check": {
    if (!first || !second) fail("usage: node scripts/service-key.ts check <service_signing_key.pem> <service_certificate.json> [--root <hex>]");
    try {
      const key = loadServiceKey(readFileSync(first, "utf8"), readFileSync(second, "utf8"), option("--root"));
      process.stdout.write(
        `ok: key ${key.publicKey.toString("hex")}, root ${key.root.toString("hex")}, ` +
          `${key.notAfter ? `valid until ${key.notAfter.toISOString()}` : "no expiry"}${key.development ? ", development" : ""}\n`,
      );
    } catch (error) {
      fail(`refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    break;
  }
  default:
    fail("usage: node scripts/service-key.ts root|online|check ...");
}
