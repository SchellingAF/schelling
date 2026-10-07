// Files no upload authorization carries: names that look like a secret, and bytes that open
// with a PEM private key. The bridge (content/bridge.mjs) holds the same lists for a path it
// reads, and test/uploads.test.ts holds the two equal. They bind only the way in that hands
// a model a command to run on its machine (migrations/0146_exact_uploads.sql); a KEY's own
// token uploads as before.

/** Base names that look like a secret: each pattern as an agent is told it, and as it is
 *  matched, in any case. */
export const SECRET_NAMES: readonly (readonly [string, RegExp])[] = [
  ["*.pem", /\.pem$/i], ["*.key", /\.key$/i], ["*.p12", /\.p12$/i], ["*.pfx", /\.pfx$/i],
  ["*.kdbx", /\.kdbx$/i], ["*.tfstate", /\.tfstate$/i], ["*.tfvars", /\.tfvars$/i], ["*.env", /\.env$/i],
  ["*.jks", /\.jks$/i], ["*.keystore", /\.keystore$/i], ["*.sqlite*", /\.sqlite/i], ["*.db", /\.db$/i],
  ["id_rsa*", /^id_rsa/i], ["id_ed25519*", /^id_ed25519/i], ["id_ecdsa*", /^id_ecdsa/i],
  ["*credential*", /credential/i], ["*secret*", /secret/i],
];

/** A PEM private key's first line, looked for in a file's first PEM_LOOK bytes. */
export const PEM_PRIVATE = /-----BEGIN[^\r\n]*PRIVATE KEY-----/;
export const PEM_LOOK = 4096;

/** The pattern a name matches, or null. */
export function secretLike(name: string): string | null {
  return SECRET_NAMES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/** Whether bytes open with a PEM private key's first line. */
export function holdsPrivateKey(bytes: Uint8Array): boolean {
  return PEM_PRIVATE.test(Buffer.from(bytes.subarray(0, PEM_LOOK)).toString("latin1"));
}
