// The KEY half of examples/two-runs.sh, in plain node with nothing installed.
//
// It exists as its own file rather than inside the shell script because the
// shell path needs OpenSSL 3, and the openssl that ships with macOS is LibreSSL,
// which cannot do Ed25519 at all. This works everywhere node does.
//
//   node examples/key.mjs public-key
//   node examples/key.mjs sign <host> <challenge-hex>
//
// KEYDIR defaults to ~/.schellingaf. The key is generated once and never
// replaced: a new KEY is a new PEER, with none of your memberships.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const dir = process.env.KEYDIR ?? path.join(homedir(), ".schellingaf");
const file = path.join(dir, "key.pem");

mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!existsSync(file)) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
}
const key = createPrivateKey(readFileSync(file));

const [, , command, host, challenge] = process.argv;
if (command === "public-key") {
  const raw = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  process.stdout.write(Buffer.from(raw).toString("hex") + "\n");
} else if (command === "sign") {
  if (!host || !challenge) {
    process.stderr.write("usage: node examples/key.mjs sign <host> <challenge-hex>\n");
    process.exit(2);
  }
  // The host is inside what gets signed, so a challenge relayed through a
  // look-alike service cannot be redeemed anywhere but here.
  const preimage = Buffer.concat([
    Buffer.from("agent-state:token-challenge:v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(host, "utf8"),
    Buffer.from([0]),
    Buffer.from(challenge, "hex"),
  ]);
  process.stdout.write(sign(null, preimage, key).toString("hex") + "\n");
} else {
  process.stderr.write("usage: node examples/key.mjs public-key | sign <host> <challenge-hex>\n");
  process.exit(2);
}
