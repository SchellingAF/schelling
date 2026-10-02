// A software authenticator: a passkey, and the answer a browser's prompt hands
// back for a challenge, built exactly as navigator.credentials.get() builds it.
// Needs no service, so a file that has none imports it from here; ./service.ts
// re-exports it.
//
//   const pk = passkey();                          // ES256; passkey(-8) EdDSA, passkey(-257) RS256
//   const answer = passkeyAssertion(pk, challenge, { rpId: "passkeys.test", origin: "https://passkeys.test" });
//   // { credential_id, client_data_json, authenticator_data, signature }, all base64url

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/** The COSE numbers of the three algorithms a passkey signs with: ES256, EdDSA, RS256. */
export type PasskeyAlgorithm = -7 | -8 | -257;

export type Passkey = { credentialId: Buffer; spki: Buffer; algorithm: PasskeyAlgorithm; privateKey: KeyObject };

/**
 * What a prompt says and does. rpId and origin are the site's; the rest bend an
 * answer out of shape, and undefined leaves each as a browser writes it.
 */
export type Prompt = {
  rpId: string;
  origin: string;
  type?: string | undefined;
  flags?: number | undefined;
  signCount?: number | undefined;
  /** Fields added to the client data after the four a browser always writes. */
  clientExtra?: Record<string, unknown> | undefined;
  /** A key to sign with other than the passkey's own. */
  signWith?: KeyObject | undefined;
};

export function passkey(algorithm: PasskeyAlgorithm = -7): Passkey {
  const pair =
    algorithm === -7
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : algorithm === -8
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentialId: randomBytes(32),
    spki: pair.publicKey.export({ type: "spki", format: "der" }),
    algorithm,
    privateKey: pair.privateKey,
  };
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

/** The passkey's answer to `challenge`, as the website hands it on. */
export function passkeyAssertion(
  pk: { credentialId: Buffer; privateKey: KeyObject; algorithm?: PasskeyAlgorithm },
  challenge: Uint8Array,
  prompt: Prompt,
) {
  const clientData = Buffer.from(JSON.stringify({
    type: prompt.type ?? "webauthn.get",
    challenge: Buffer.from(challenge).toString("base64url"),
    origin: prompt.origin,
    crossOrigin: false,
    ...prompt.clientExtra,
  }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(prompt.signCount ?? 0);
  const authData = Buffer.concat([sha256(prompt.rpId), Buffer.from([prompt.flags ?? 0x05]), counter]);
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const key = prompt.signWith ?? pk.privateKey;
  const algorithm = pk.algorithm ?? -7;
  const signature =
    algorithm === -7
      ? sign("sha256", signed, { key, dsaEncoding: "der" })
      : algorithm === -8
        ? sign(null, signed, key)
        : sign("sha256", signed, key);
  return {
    credential_id: pk.credentialId.toString("base64url"),
    client_data_json: clientData.toString("base64url"),
    authenticator_data: authData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}
