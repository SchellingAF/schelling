// A client assertion is used once, however many token requests carry it at the same
// moment. The single-use check came before the awaits that find the app's keys, so
// two requests sent together both passed it before either recorded the assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { checkAssertion } from "../src/oauth/assertion.ts";
import type { Client } from "../src/oauth/clients.ts";

const ID = "https://apps.example/sec-auth/client.json";
const TOKEN_ENDPOINT = "https://api.schellingaf.test/oauth/token";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const client: Client = {
  id: ID,
  kind: "metadata_document",
  name: "Signing app",
  redirectUris: ["https://apps.example/sec-auth/cb"],
  authMethod: "private_key_jwt",
  secretHash: null,
  jwksUri: null,
  jwks: { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", use: "sig", alg: "RS256" }] },
  signingAlg: "RS256",
};

function assertion(jti: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: ID, sub: ID, aud: TOKEN_ENDPOINT, exp: now + 120, iat: now, jti })).toString("base64url");
  return `${head}.${body}.${signBytes("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

test("one assertion sent in two token requests at once is taken by one of them", async () => {
  const one = assertion("sent-twice-at-once");
  const verdicts = await Promise.all([
    checkAssertion(client, one, [TOKEN_ENDPOINT]),
    checkAssertion(client, one, [TOKEN_ENDPOINT]),
  ]);
  assert.equal(verdicts.filter((why) => why === null).length, 1, `both requests took the assertion: ${JSON.stringify(verdicts)}`);
  assert.ok(verdicts.includes("this assertion was already used"), JSON.stringify(verdicts));
});

test("an assertion sent again after it was taken is refused, and a fresh one is taken", async () => {
  const one = assertion("sent-twice-in-turn");
  assert.equal(await checkAssertion(client, one, [TOKEN_ENDPOINT]), null);
  assert.equal(await checkAssertion(client, one, [TOKEN_ENDPOINT]), "this assertion was already used");
  assert.equal(await checkAssertion(client, assertion("fresh"), [TOKEN_ENDPOINT]), null);
});
