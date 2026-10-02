// The apps that sign people in: who each says it is, where it may be sent back to,
// and how it proves itself when it trades a code for a token.
//
// Two ways to be an app here, because the apps use both and the specification now
// prefers the second:
//
//   registered          RFC 7591. The app sends its details to /oauth/register and
//                       is given an id, and a secret if it asked for one. Stored in
//                       oauth_clients. Claude Code and claude.ai use this when a
//                       server offers nothing else.
//   metadata_document   The app's id IS the https address of a JSON document it
//                       publishes about itself. Fetched, checked and kept in memory,
//                       never stored. Claude's apps and ChatGPT prefer this, and
//                       Claude chooses it only when this server says it takes it and
//                       takes "none" as a way to authenticate at the token endpoint.
//
// Everything an app says about itself is its own claim: its name, its address, its
// logo. The consent page shows the name quoted and the HOSTS it will send the
// person to, which are the things a person can check.

import { randomBytes } from "node:crypto";
import type { Db } from "../db/sql.ts";
import { sha256, toHex } from "../domain/keys.ts";
import { FetchBusy, FetchRefused, fetchJsonDocument, keepFor, sharedFetch, type Fetched, type FetchFor } from "./fetch.ts";
import { checkRedirectUri, isMetadataDocumentId } from "./uris.ts";

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";

export type Client = {
  id: string;
  kind: "registered" | "metadata_document";
  name: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  /** sha256 of a registered app's secret. */
  secretHash: Buffer | null;
  /** Where a metadata-document app publishes the keys it signs token requests with. */
  jwksUri: string | null;
  /** Or the keys themselves, inline in its document. */
  jwks: { keys: unknown[] } | null;
  signingAlg: string | null;
};

/** The algorithms a client assertion may be signed with here. */
export const ASSERTION_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;

/** Replaced by a test, never by the service: the fetch of an app's documents. */
let fetchDocument: (address: string) => Promise<Fetched> = (address) => fetchJsonDocument(address);
export function useDocumentFetcherForTests(fetcher: ((address: string) => Promise<Fetched>) | null): void {
  fetchDocument = fetcher ?? ((address) => fetchJsonDocument(address));
  documents.clear();
  failures.clear();
  keySets.clear();
}

/** Good documents, by address: kept as long as each says, and used for up to a day
 * past that while fetching it again fails for a reason that says nothing about the
 * document (no answer, a server's error, too many fetches), so a flood cannot stop the
 * apps people already use from connecting. A document its publisher took down or
 * broke is forgotten as soon as the service sees so. */
const documents = new Map<string, { until: number; client: Client; at: number }>();
/** Fetches that failed, by address, for a minute, kept apart from the good documents
 * so a flood of failing addresses cannot push one out. */
const failures = new Map<string, { until: number; why: string }>();
const DOCUMENTS_KEPT = 1000;
const STALE_FOR_MS = 86_400_000;
const FAILURE_KEPT_MS = 60_000;

/** Keep an entry, as the newest: one set again moves to the end, so what is still used
 * stays and what is not is the first to go. */
function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= DOCUMENTS_KEPT) map.delete(map.keys().next().value!);
  map.set(key, value);
}

/** A JSON object read from text, or null for anything else: not JSON, a list, a
 * bare value. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether an answer says nothing about the document it was asked for. */
function passing(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** A name an app gave itself, cut to what the column and a page can hold, with its
 * control characters taken out, and every character that is not seen but changes
 * what is seen: the marks that reverse the direction of text, joiners and spaces of
 * no width, and line and paragraph separators. A name holding them could reorder the
 * sentence on the consent page that says what the app may do. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return cutToBytes(text, 128);
}

/** Text cut, between two characters, to at most `maxBytes` bytes of UTF-8. */
export function cutToBytes(text: string, maxBytes: number): string {
  let out = "";
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
    out += ch;
  }
  return out;
}

function cleanUri(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The redirect URIs an app declared, or why they will not do. */
function readRedirectUris(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return "redirect_uris is a list of 1 to 10 addresses";
  for (const one of value) {
    const check = checkRedirectUri(one);
    if (!check.ok) return check.reason;
  }
  return value as string[];
}

/** A metadata-document app, from its document, or why it is not one. */
function fromDocument(address: string, fetched: Fetched): Client | string {
  if (fetched.status !== 200) return `the document answered ${fetched.status}`;
  if (!/\bjson\b/i.test(fetched.contentType)) return "the document is not JSON";
  const doc = jsonObject(fetched.body);
  if (!doc) return "the document is not a JSON object";
  if (doc.client_id !== address) return "the document's client_id is not its own address";
  if ("client_secret" in doc || "client_secret_expires_at" in doc) return "a published document carries no secret";
  const redirects = readRedirectUris(doc.redirect_uris);
  if (typeof redirects === "string") return redirects;
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "private_key_jwt") {
    return "a published document authenticates with none or private_key_jwt";
  }
  let jwksUri: string | null = null;
  let jwks: { keys: unknown[] } | null = null;
  let signingAlg: string | null = null;
  if (method === "private_key_jwt") {
    if (typeof doc.jwks_uri === "string") {
      jwksUri = cleanUri(doc.jwks_uri);
      // The keys must come from the publisher of the document, or anybody who can
      // host a file could sign for an app whose name they borrowed.
      if (jwksUri === null || new URL(jwksUri).origin !== new URL(address).origin) {
        return "jwks_uri is an https address on the document's own origin";
      }
    } else if (doc.jwks && typeof doc.jwks === "object" && Array.isArray((doc.jwks as { keys?: unknown }).keys)) {
      // As many keys as a set fetched from jwks_uri keeps, and no more.
      jwks = { keys: (doc.jwks as { keys: unknown[] }).keys.slice(0, MAX_KEYS) };
    } else {
      return "private_key_jwt needs jwks_uri or jwks";
    }
    if (doc.token_endpoint_auth_signing_alg !== undefined) {
      if (!(ASSERTION_ALGORITHMS as readonly unknown[]).includes(doc.token_endpoint_auth_signing_alg)) {
        return `token_endpoint_auth_signing_alg is one of ${ASSERTION_ALGORITHMS.join(", ")}`;
      }
      signingAlg = doc.token_endpoint_auth_signing_alg as string;
    }
  }
  return {
    id: address,
    kind: "metadata_document",
    name: cleanName(doc.client_name),
    redirectUris: redirects,
    authMethod: method as AuthMethod,
    secretHash: null,
    jwksUri,
    jwks,
    signingAlg,
  };
}

/** The most keys a set is read for: a set is tried key by key only by id. */
const MAX_KEYS = 20;

/**
 * The app an id names, or why not. `busy` says the service is fetching too much to
 * look now, which is a reason to try later and not a verdict on the app.
 *
 * A metadata-document id is fetched at most once an hour however often it is
 * asked, and a failure once a minute. A registered id is one row.
 */
export async function resolveClient(
  db: Db,
  clientId: string,
  fetchFor: FetchFor = {},
): Promise<{ client: Client } | { why: string; busy?: true }> {
  if (isMetadataDocumentId(clientId)) {
    const now = Date.now();
    const good = documents.get(clientId);
    if (good && good.until > now) return { client: good.client };
    const failed = failures.get(clientId);
    if (failed && failed.until > now) return { why: failed.why };
    const stale = good && now - good.at < STALE_FOR_MS ? good : undefined;
    // The last good document stands in, and is asked for again in a minute.
    const standIn = (last: { client: Client; at: number }) => {
      keep(documents, clientId, { until: Date.now() + FAILURE_KEPT_MS, client: last.client, at: last.at });
      return { client: last.client };
    };
    const fail = (why: string) => {
      keep(failures, clientId, { until: Date.now() + FAILURE_KEPT_MS, why });
      return { why };
    };
    let fetched: Fetched;
    try {
      fetched = await sharedFetch(clientId, fetchDocument, fetchFor);
    } catch (error) {
      if (error instanceof FetchBusy) return stale ? standIn(stale) : { why: "busy", busy: true as const };
      if (!(error instanceof FetchRefused)) throw error;
      return stale ? standIn(stale) : fail(`the document could not be fetched: ${error.message}`);
    }
    const result = fromDocument(clientId, fetched);
    if (typeof result === "string") {
      if (stale && passing(fetched.status)) return standIn(stale);
      // Taken down or broken by its publisher: not used again from now.
      documents.delete(clientId);
      return fail(result);
    }
    failures.delete(clientId);
    keep(documents, clientId, { until: Date.now() + keepFor(fetched.cacheControl), client: result, at: Date.now() });
    return { client: result };
  }
  if (!/^schellingaf_client_[0-9a-f]{32}$/.test(clientId)) return { why: "no app has that id" };
  const [row] = await db.read<
    { client_name: string | null; redirect_uris: string[]; auth_method: AuthMethod; secret_hash: Buffer | null }[]
  >`
    select client_name, redirect_uris, auth_method, secret_hash
      from schellingaf.oauth_clients where client_id = ${clientId}`;
  if (!row) return { why: "no app has that id" };
  return {
    client: {
      id: clientId,
      kind: "registered",
      name: row.client_name,
      redirectUris: row.redirect_uris,
      authMethod: row.auth_method,
      secretHash: row.secret_hash,
      jwksUri: null,
      jwks: null,
      signingAlg: null,
    },
  };
}

/** The keys a metadata-document app signs with, fetched and kept like its document:
 * a set that could not be fetched is not asked for again for a minute, a set its
 * publisher took down is forgotten, and the last good set is used for up to a day
 * only while fetching it again fails for a reason that says nothing about the set.
 * `goodAt` is when the keys kept were last fetched good, or 0 for none. */
const keySets = new Map<string, { until: number; keys: unknown[]; fetchedAt: number; goodAt: number }>();

export async function keysOf(client: Client, refresh = false, fetchFor: FetchFor = {}): Promise<unknown[]> {
  if (client.jwks) return client.jwks.keys;
  if (!client.jwksUri) return [];
  const uri = client.jwksUri;
  const now = Date.now();
  const kept = keySets.get(uri);
  // A refresh is allowed once every five minutes, for a key id the set does not
  // have yet: an app rotating its keys is served, an app naming random ids is not.
  const mayRefresh = kept === undefined || now - kept.fetchedAt > 300_000;
  if (kept && kept.until > now && !(refresh && mayRefresh)) return kept.keys;
  const goodAt = kept && now - kept.goodAt < STALE_FOR_MS ? kept.goodAt : 0;
  const stale = goodAt > 0 ? kept!.keys : [];
  const remember = (keys: unknown[], at: number) => {
    keep(keySets, uri, { until: Date.now() + FAILURE_KEPT_MS, keys, fetchedAt: Date.now(), goodAt: at });
    return keys;
  };
  let fetched: Fetched;
  try {
    fetched = await sharedFetch(uri, fetchDocument, fetchFor);
  } catch (error) {
    // Too many fetches says nothing about the set, so it is not remembered; with no
    // keys to stand in, the request is told to try later.
    if (error instanceof FetchBusy) {
      if (stale.length > 0) return stale;
      throw error;
    }
    if (!(error instanceof FetchRefused)) throw error;
    return remember(stale, goodAt);
  }
  let keys: unknown[] | null = null;
  if (fetched.status === 200) {
    const listed = jsonObject(fetched.body)?.keys;
    if (Array.isArray(listed)) keys = listed.slice(0, MAX_KEYS);
  }
  if (keys === null) return passing(fetched.status) ? remember(stale, goodAt) : remember([], 0);
  keep(keySets, uri, { until: Date.now() + keepFor(fetched.cacheControl), keys, fetchedAt: Date.now(), goodAt: Date.now() });
  return keys;
}

type Registration = {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  application_type: string;
};

/** Register an app from what it sent, or say which field will not do. */
export async function registerClient(db: Db, sent: Record<string, unknown>): Promise<Registration | { field: string; why: string }> {
  const redirects = readRedirectUris(sent.redirect_uris);
  if (typeof redirects === "string") return { field: "redirect_uris", why: redirects };

  const grants = sent.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => typeof g !== "string")) {
    return { field: "grant_types", why: "grant_types must include authorization_code" };
  }
  const responses = sent.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) {
    return { field: "response_types", why: "response_types is code" };
  }
  // RFC 7591's default is client_secret_basic; an app that wants to be public says
  // none, as the MCP clients do.
  const method = sent.token_endpoint_auth_method ?? "client_secret_basic";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return { field: "token_endpoint_auth_method", why: "token_endpoint_auth_method is none, client_secret_post or client_secret_basic" };
  }
  const applicationType = sent.application_type ?? "web";
  if (applicationType !== "web" && applicationType !== "native") {
    return { field: "application_type", why: "application_type is web or native" };
  }

  const id = `schellingaf_client_${toHex(randomBytes(16))}`;
  const secret = method === "none" ? null : `schellingaf_secret_${toHex(randomBytes(32))}`;
  const name = cleanName(sent.client_name);
  const uri = cleanUri(sent.client_uri);
  const [row] = await db.write<{ created_at: Date }[]>`
    insert into schellingaf.oauth_clients
      (client_id, client_name, client_uri, redirect_uris, auth_method, secret_hash, application_type)
    values (${id}, ${name}, ${uri}, ${redirects}, ${method as string}, ${secret === null ? null : sha256(secret)},
            ${applicationType as string})
    returning created_at`;
  return {
    client_id: id,
    client_id_issued_at: Math.floor(row!.created_at.getTime() / 1000),
    ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    ...(name === null ? {} : { client_name: name }),
    ...(uri === null ? {} : { client_uri: uri }),
    redirect_uris: redirects,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: method as string,
    application_type: applicationType as string,
  };
}
