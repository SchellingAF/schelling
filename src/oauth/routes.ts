// An app signs a person in: OAuth 2.1 as the MCP authorization specification of
// 2026-07-28 profiles it, with this service as both the connector the app wants a
// token for and the server that issues it.
//
// THE WAY THROUGH, IN ORDER.
//
//   1. The app calls /mcp/connect with no token and is answered 401, naming the
//      protected resource metadata below.
//   2. It reads that, then the authorization server metadata, and identifies
//      itself: by the address of a document it publishes, or by registering.
//   3. It sends the person's browser to /oauth/authorize. This service checks the
//      request, keeps it for ten minutes, and sends the browser to the website's
//      /me/connect, because the service serves no page and a passkey signs only on
//      the site it was made for.
//   4. The website signs the person in with their passkey if they are not, shows
//      them who is asking, and on Allow calls /v1/authorizations/<id>/approve with
//      the person's own token. The answer is where to send the browser: back to the
//      app, with a code that works once, for five minutes.
//   5. The app trades the code at /oauth/token, proving it is the app the code was
//      for and holds the PKCE verifier, and is given a token for /mcp/connect.
//
// THE WORDS IT ANSWERS IN. Steps 2, 3 and 5 are the app's and are answered in
// OAuth's words (RFC 6749, 7591, 8414, 9207, 9728), because an app acts on those
// and nothing else. Step 4 is the website's and uses the service's own envelope,
// like every other /v1 route.
//
// WHAT IS NEVER DONE. No code or token is written to a log, no address the app
// named is fetched except an https document it identifies itself by (fetch.ts), no
// refresh token is issued (a connection lasts ninety days, like every token, and
// then the person says yes again), and nothing here reads a SPACE.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { sha256, toHex } from "../domain/keys.ts";
import { UUID, readBody } from "../domain/validate.ts";
import { TOKEN_TTL_DEFAULT_SECONDS } from "../domain/protocol.ts";
import { newToken } from "../http/auth.ts";
import { signerOf } from "../domain/encryption.ts";
import { checkConnectionKey, codeVaultData, openVault, readConnectionKeyBody, sealVault } from "../domain/connection-keys.ts";
import { publishChange } from "../mcp/listen.ts";
import { ASSERTION_TYPE, checkAssertion } from "./assertion.ts";
import { FetchBusy, type FetchFor } from "./fetch.ts";
import { ASSERTION_ALGORITHMS, cutToBytes, jsonObject, registerClient, resolveClient, type Client } from "./clients.ts";
import { isLoopback, redirectMatches, sameResource, shownHost, withQuery } from "./uris.ts";
import { LIMITS, clientAddress, networkOfAddress, refuseIfEmpty, spend, withinReadWindow, TOKEN_REQUESTS_PER_MINUTE } from "../http/ratelimit.ts";
import { floorPlace, requireBearer, type Env } from "../http/app.ts";

/** The scopes an app may ask for. `read` alone is a connection that may only look. */
export const SCOPES = ["read", "write"] as const;

/** How long a request to connect waits for the person, and a code for the app. */
const REQUEST_MINUTES = 10;

/** How long after a code is traded the same app may trade it again and be refused
 * without what the first trade minted being revoked. Smithery's servers trade one
 * code twice, 0.7 seconds apart (2 October 2026), and revoking then threw away the
 * token its first trade was given. A replay needs the code and its verifier both. */
export const REPLAY_GRACE_SECONDS = 10;

export const CONNECT_PATH = "/mcp/connect";
export const connectResource = (config: Config) => `${config.publicOrigin}${CONNECT_PATH}`;
export const resourceMetadataUrl = (config: Config) =>
  `${config.publicOrigin}/.well-known/oauth-protected-resource${CONNECT_PATH}`;

/** Whether an app can sign a person in here: there has to be a site whose passkey
 * page the person says yes on. */
export function oauthAvailable(config: Config): boolean {
  return Boolean(config.siteOrigin && config.passkeys);
}

/** The challenge a 401 or 403 at /mcp/connect carries, per RFC 6750 and 9728. */
export function bearerChallenge(config: Config, error?: "invalid_token" | "insufficient_scope"): string {
  const parts = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataUrl(config)}"`,
    `scope="${SCOPES.join(" ")}"`,
  ];
  return `Bearer ${parts.join(", ")}`;
}

/** Scopes as an app asked for them, in their one stored form, or null if unknown. */
function readScope(raw: string | undefined): "read" | "read write" | null {
  if (raw === undefined || raw.trim() === "") return "read write";
  const asked = new Set(raw.trim().split(/\s+/));
  for (const one of asked) if (!(SCOPES as readonly string[]).includes(one)) return null;
  return asked.has("write") ? "read write" : "read";
}

/** The label a token is listed under: the app's name, cut to the column's 64 bytes. */
function labelFor(client: Client): string {
  return cutToBytes(client.name ?? shownHost(client.id), 64) || "an app";
}

/** The first parameter sent more than once, or undefined: RFC 6749, section 3.1,
 * refuses one rather than guess which was meant. */
function repeated(params: URLSearchParams): string | undefined {
  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length > 1) return key;
  }
  return undefined;
}

/** Whether an error means "try again later": an allowance spent, the service's gate
 * full when a request stepping back in after a fetch found no place, or too many
 * fetches running to start the one a signature's keys needed. */
function tryLater(error: unknown): boolean {
  return error instanceof FetchBusy || (error instanceof ApiError && (error.code === "RATE_LIMITED" || error.code === "BUSY"));
}

/** Who a fetch made for this request is counted against, and the gate place it
 * gives up while the fetch runs. */
function fetchForRequest(c: Context<Env>): FetchFor {
  const address = clientAddress(c);
  return { caller: address, network: networkOfAddress(address), place: floorPlace(c) };
}

/** What the request log may hold of a refusal's reason: short, one line. */
const WHY_BYTES = 160;

/** Note a refusal for the request log: the code, and a reason that is never a
 * token, a code or a secret. See Refusal in src/http/log.ts. */
function noteRefusal(c: Context<Env>, code: string, why: string): void {
  c.set("appRefusal", { code, why: cutToBytes(why, WHY_BYTES) });
}

/** An OAuth error answer. `why` is what the request log holds beside the code,
 * where the description the app is told does not say it (default: the description). */
function oauthError(c: Context<Env>, status: number, error: string, description: string, headers: Record<string, string> = {}, why = description) {
  noteRefusal(c, error, why);
  c.header("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ error, error_description: description }, status as 400);
}

/** The origins an app's own browser page may call the discovery, registration and
 * token addresses from: any, with no credentials, as public clients need. */
function openToBrowsers(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  c.header("Access-Control-Max-Age", "86400");
}

export function mountOAuth(app: Hono<Env>, config: Config, db: Db): void {
  const issuer = config.publicOrigin;
  const tokenEndpoint = `${issuer}/oauth/token`;

  /** A browser's preflight for one of the addresses open to browsers. */
  const preflight = (path: string) =>
    app.options(path, (c) => {
      openToBrowsers(c);
      return c.body(null, 204);
    });

  /** A discovery document, built from the configuration alone, open to browsers and
   * kept an hour by any cache. Unavailable is said first, with no CORS headers. */
  const discovery = (path: string, document: Record<string, unknown>) => {
    preflight(path);
    app.get(path, (c) => {
      if (!oauthAvailable(config)) throw new ApiError("OAUTH_UNAVAILABLE");
      openToBrowsers(c);
      c.header("Cache-Control", "public, max-age=3600");
      return c.json(document);
    });
  };

  // ── discovery ────────────────────────────────────────────────────────────────

  discovery("/.well-known/oauth-protected-resource/mcp/connect", {
    resource: connectResource(config),
    authorization_servers: [issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Schelling Add Forward",
    resource_documentation: `${config.siteOrigin}/api`,
  });

  discovery("/.well-known/oauth-authorization-server", {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: tokenEndpoint,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    // "none" is what makes Claude choose a published document over registering,
    // and private_key_jwt is how ChatGPT signs its token requests.
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGORITHMS,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: `${config.siteOrigin}/api`,
  });

  // ── registering an app ───────────────────────────────────────────────────────

  preflight("/oauth/register");
  app.post("/oauth/register", async (c) => {
    openToBrowsers(c);
    // Every write answers the same way while a restore is in progress, here too:
    // the service's own refusal, which is a 503 an app treats as try-later.
    if (config.readOnly) throw new ApiError("SERVICE_READ_ONLY");
    if (!oauthAvailable(config)) return oauthError(c, 404, "invalid_request", "No app can sign a person in to this server.");
    try {
      await refuseIfEmpty(db, [LIMITS.appRegistrationsService()]);
      await spend(c, db, LIMITS.appRegistrations(clientAddress(c)));
      await spend(c, db, LIMITS.appRegistrationsNetwork(clientAddress(c)));
    } catch (error) {
      if (error instanceof ApiError && error.code === "RATE_LIMITED") {
        return oauthError(c, 429, "temporarily_unavailable", "Too many apps registered from here. Wait and try again.", {
          "Retry-After": String(error.retryAfter ?? 60),
        });
      }
      throw error;
    }
    // A body cut off part-way cannot be read, and is answered as one that is no object.
    const sent = jsonObject(await c.req.text().catch(() => ""));
    if (!sent) return oauthError(c, 400, "invalid_client_metadata", "The registration is a JSON object.");
    const out = await registerClient(db, sent);
    if ("field" in out) {
      return oauthError(c, 400, out.field === "redirect_uris" ? "invalid_redirect_uri" : "invalid_client_metadata", out.why);
    }
    await spend(c, db, LIMITS.appRegistrationsService());
    c.header("Cache-Control", "no-store");
    return c.json(out, 201);
  });

  // ── the person's browser arrives ─────────────────────────────────────────────

  app.get("/oauth/authorize", async (c) => {
    // No page to show here, ever, and nothing goes back to the app before the person
    // has answered: a request that cannot go on sends the browser to the website's
    // page, which says what was wrong in a person's words. An error sent straight
    // back to an address an app registered for itself would make this address a
    // redirect anybody could use, to any website or any program's scheme, with no
    // click at all (RFC 9700, section 4.11.2).
    const toSite = (error: "unknown_app" | "wrong_return_address" | "malformed" | "busy" | "unavailable", why: string) => {
      noteRefusal(c, error, why);
      return c.redirect(`${config.siteOrigin}/me/connect?error=${error}`, 302);
    };
    if (!oauthAvailable(config)) {
      return c.text("No app can sign a person in to this server.\n", 404);
    }
    if (config.readOnly) return toSite("unavailable", "the service is read-only");

    const url = new URL(c.req.url);
    const twice = repeated(url.searchParams);
    if (twice !== undefined) return toSite("malformed", "a parameter is sent more than once");
    const q = (key: string) => url.searchParams.get(key) ?? undefined;

    // Every allowance spent below, and the fetch of the app's document, can say
    // "try later", and the person is then sent to the website's page saying so. The
    // insert cannot: a database error reaches the service's own error answer.
    try {
      // Counted before the app is looked up: naming an app this service has to fetch
      // costs a fetch, so an address or a network asking too often is refused before
      // it causes one.
      const address = clientAddress(c);
      await spend(c, db, LIMITS.appConnections(address));
      await spend(c, db, LIMITS.appConnectionsNetwork(address));

      const clientId = q("client_id");
      if (!clientId) return toSite("unknown_app", "no client_id");
      const resolved = await resolveClient(db, clientId, fetchForRequest(c));
      if ("why" in resolved) return toSite(resolved.busy ? "busy" : "unknown_app", resolved.why);
      const client = resolved.client;

      const redirectUri = q("redirect_uri");
      if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
        return toSite("wrong_return_address", redirectUri ? `redirect_uri on ${shownHost(redirectUri) || "no host"} is not one the app declared` : "no redirect_uri");
      }

      if (q("response_type") !== "code") return toSite("malformed", "response_type is not code");
      const challenge = q("code_challenge");
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || q("code_challenge_method") !== "S256") {
        return toSite("malformed", "no S256 code_challenge");
      }
      const scope = readScope(q("scope"));
      if (scope === null) return toSite("malformed", "scope is not read or write");
      const resource = q("resource");
      if (resource !== undefined && !sameResource(resource, connectResource(config))) {
        return toSite("malformed", "resource is not this service's connector");
      }
      const state = q("state");
      if (state !== undefined && Buffer.byteLength(state, "utf8") > 2048) return toSite("malformed", "state is over 2048 bytes");

      await spend(c, db, LIMITS.appConnectionsService());

      const [row] = await db.write<{ request_id: string }[]>`
        insert into schellingaf.oauth_requests
          (client_id, client_kind, client_name, redirect_uri, code_challenge, scope, resource, state, expires_at)
        values (${client.id}, ${client.kind}, ${client.name}, ${redirectUri}, ${challenge}, ${scope},
                ${connectResource(config)}, ${state ?? null}, now() + make_interval(mins => ${REQUEST_MINUTES}))
        returning request_id::text`;
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(`${config.siteOrigin}/me/connect?request=${row!.request_id}`, 302);
    } catch (error) {
      if (tryLater(error)) return toSite("busy", "an allowance is spent or the service is busy");
      throw error;
    }
  });

  // ── the website asks what the request is, and answers it ────────────────────

  /** The person asking, and the request they ask about, in the order every read
   * and decision checks them: a signed-in token, a service apps can sign in to, an id
   * that could be a request's. */
  const requestOf = (c: Context<Env>) => {
    const bearer = requireBearer(c.get("bearer"));
    if (!oauthAvailable(config)) throw new ApiError("OAUTH_UNAVAILABLE");
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new ApiError("AUTHORIZATION_NOT_FOUND");
    return { bearer, id };
  };

  app.get("/v1/authorizations/:id", async (c) => {
    const { bearer, id } = requestOf(c);
    const [row] = await db.read<
      {
        client_id: string; client_kind: string; client_name: string | null; redirect_uri: string; scope: string;
        resource: string; created_at: Date; expires_at: Date; decision: string | null; redeemed_at: Date | null;
        peer_id: Buffer | null;
      }[]
    >`
      select client_id, client_kind, client_name, redirect_uri, scope, resource, created_at, expires_at, decision, redeemed_at,
             peer_id
        from schellingaf.oauth_requests where request_id = ${id}::uuid`;
    // A request once decided is the deciding KEY's alone: its id is published in the
    // statement of a connection key, and nobody else learns the app's return address,
    // its state or the answer from it. One still pending is shown to whoever has its id,
    // which is how the website shows it to the person signing in.
    if (!row || (row.decision !== null && !row.peer_id?.equals(bearer.peerId))) throw new ApiError("AUTHORIZATION_NOT_FOUND");
    const loopback = isLoopback(row.redirect_uri);
    // Every redirect URI this app registered, to tell a person when the only place
    // it can send them is a program on their own computer.
    let onlyLoopback = loopback;
    if (onlyLoopback) {
      // Kept from the request a moment ago, almost always. When it is not and the
      // service is too busy to fetch it, the warning stays: saying less is the risk.
      const resolved = await resolveClient(db, row.client_id, { place: floorPlace(c) }).catch((error: unknown) => {
        if (tryLater(error)) return { why: "busy", busy: true as const };
        throw error;
      });
      if ("client" in resolved) onlyLoopback = resolved.client.redirectUris.every(isLoopback);
    }
    return c.json({
      request_id: id,
      state: row.decision !== null
        ? row.decision
        : row.expires_at.getTime() <= Date.now()
          ? "expired"
          : "pending",
      client: {
        id: row.client_id,
        kind: row.client_kind,
        // The app's own name for itself, which it chose: show it as a claim.
        name: row.client_name,
        // For a published document, the host that published it, which a person can
        // recognise and nobody else can serve a document from.
        publisher: row.client_kind === "metadata_document" ? shownHost(row.client_id) : null,
      },
      redirect: {
        host: shownHost(row.redirect_uri),
        uri: row.redirect_uri,
        loopback,
        only_loopback: onlyLoopback,
      },
      scope: row.scope.split(" "),
      resource: row.resource,
      expires_at: row.expires_at.toISOString(),
      token_lifetime_days: Math.round(TOKEN_TTL_DEFAULT_SECONDS / 86400),
    });
  });

  /**
   * The connection key an approval may carry, so the app can sign the person's posts:
   * checked whole before anything is kept (checkConnectionKey), against the request as
   * it stands and the approving KEY's own key, with a passkey's counter moved on as it
   * is at sign-in. Answers what oauth_decide records, or null for an approval without
   * one, which connects the app as before. Nothing of it is logged.
   */
  async function connectionKeyOf(c: Context<Env>, bearer: { peerId: Buffer }, id: string) {
    const body = await readBody(c);
    for (const key of Object.keys(body)) {
      if (key !== "connection_key") throw new ApiError("INVALID_REQUEST", { detail: `${key} is not a field of an approval, which takes connection_key or nothing` });
    }
    if (body.connection_key === undefined) return null;
    const sent = readConnectionKeyBody(body.connection_key);
    // The request as it stands, refused as oauth_decide would refuse it, before a
    // signature is checked or a counter moved; oauth_decide asks again under the lock.
    // With the database's clock, which a statement's not_before is held to here and again
    // in oauth_decide, and posts' times are taken from.
    const [request] = await db.read<{ scope: string; decided: boolean; expired: boolean; now_ms: number }[]>`
      select scope, decision is not null as decided, expires_at <= now() as expired,
             (extract(epoch from now()) * 1000)::float8 as now_ms
        from schellingaf.oauth_requests where request_id = ${id}::uuid`;
    if (!request) throw new ApiError("AUTHORIZATION_NOT_FOUND");
    if (request.decided) throw new ApiError("AUTHORIZATION_DECIDED");
    if (request.expired) throw new ApiError("AUTHORIZATION_EXPIRED");
    // An app that may only read posts nothing, so it is given nothing to sign with.
    if (!request.scope.split(" ").includes("write")) {
      throw new ApiError("INVALID_REQUEST", { detail: "connection_key is for an app allowed to write, and this one may only read" });
    }
    const [peer] = await db.read<
      { public_key: Buffer | null; key_type: string; passkey_algorithm: number | null; passkey_key: Buffer | null; credential_id: Buffer | null }[]
    >`
      select p.public_key, p.key_type, k.algorithm as passkey_algorithm, k.public_key as passkey_key, k.credential_id
        from schellingaf.peers p
        left join schellingaf.passkeys k on k.peer_id = p.peer_id
       where p.peer_id = ${bearer.peerId}`;
    const signer = peer ? signerOf(peer) : null;
    if (!signer) throw new ApiError("INTERNAL");
    const checked = checkConnectionKey({
      body: sent,
      approver: bearer.peerId,
      signer,
      request: { id },
      passkeys: config.passkeys ?? null,
      nowMs: request.now_ms,
    });
    if (sent.envelope.alg === "webauthn") {
      // The passkey that signed is the KEY's own, by the credential the prompt names,
      // and its counter moves as it does at sign-in: one that counts and did not move
      // is a copy of the authenticator.
      if (!peer!.credential_id || sent.envelope.credential_id !== peer!.credential_id.toString("base64url")) {
        throw new ApiError("INVALID_REQUEST", { detail: "connection_key.signature.credential_id is not the passkey of the KEY allowing the app" });
      }
      const [moved] = await db.write<{ ok: boolean }[]>`
        select schellingaf.advance_passkey(${peer!.credential_id}, ${checked.signCount ?? 0}) as ok`;
      if (!moved?.ok) {
        throw new ApiError("INVALID_REQUEST", { detail: "connection_key.signature: the signature counter of this passkey did not advance" });
      }
    }
    return { publicKey: checked.publicKey, statement: sent.statement, envelope: sent.envelope, seed: sent.seed };
  }

  const decide = (approve: boolean) => async (c: Context<Env>) => {
    const { bearer, id } = requestOf(c);
    const connection = approve ? await connectionKeyOf(c, bearer, id) : null;
    // The code: 256 random bits, never stored, only its hash. Its nonce becomes the
    // token's challenge nonce, whose unique index lets it mint one token at most.
    const code = approve ? randomBytes(32).toString("base64url") : null;
    // A connection key's seed is kept only sealed under the code, which is never stored:
    // the app's trade of the code moves it under the token (/oauth/token below).
    const vault = connection && code ? sealVault(code, connection.seed, codeVaultData(id)) : null;
    connection?.seed.fill(0);
    const [row] = await db.write<{ result: { redirect_uri: string; state: string | null } }[]>`
      select schellingaf.oauth_decide(${id}::uuid, ${bearer.peerId}, ${approve},
                                      ${code === null ? null : sha256(code)},
                                      ${code === null ? null : randomBytes(16)},
                                      ${connection?.publicKey ?? null}::bytea, ${connection?.statement ?? null}::bytea,
                                      ${connection === null ? null : db.write.json(connection.envelope as never)}::jsonb,
                                      ${vault}::bytea) as result`;
    const decided = row!.result;
    const answer = approve
      ? { code, state: decided.state, iss: issuer }
      : { error: "access_denied", error_description: "The person declined.", state: decided.state, iss: issuer };
    c.header("Cache-Control", "no-store");
    // Whether a connection key was kept, so a page says the app will sign only once the
    // service has said it holds the key.
    return c.json({
      redirect_to: withQuery(decided.redirect_uri, answer),
      decision: approve ? "approved" : "declined",
      ...(approve ? { connection_key: connection ? "kept" : "none" } : {}),
    });
  };

  app.post("/v1/authorizations/:id/approve", decide(true));
  app.post("/v1/authorizations/:id/decline", decide(false));

  // ── the app trades its code ──────────────────────────────────────────────────

  /** A code used a second time revokes the token its first use minted (in
   * oauth_redeem), and a connector stream that token holds open ends with it; see
   * src/mcp/listen.ts. Read after the revocation, so it names the token revoked. */
  async function endStreamsOfReplayedCode(codeHash: Buffer): Promise<void> {
    const [redeemed] = await db.write<{ token_hash: Buffer | null; peer_id: Buffer | null }[]>`
      select token_hash, peer_id from schellingaf.oauth_requests where code_hash = ${codeHash}`;
    if (redeemed?.token_hash && redeemed.peer_id) {
      publishChange({ kind: "tokens_revoked", peer: toHex(redeemed.peer_id), tokenHash: toHex(redeemed.token_hash) });
    }
  }

  preflight("/oauth/token");
  app.post("/oauth/token", async (c) => {
    openToBrowsers(c);
    c.header("Pragma", "no-cache");
    if (config.readOnly) throw new ApiError("SERVICE_READ_ONLY");
    if (!oauthAvailable(config)) return oauthError(c, 404, "invalid_request", "No app can sign a person in to this server.");
    // Token requests from one address in a minute: a brake on a flood, never on an
    // app. Claude's and ChatGPT's servers each send every one of their users' token
    // requests from a handful of addresses, and a code cannot be guessed.
    const window = withinReadWindow(`oauth-token:${clientAddress(c)}`, TOKEN_REQUESTS_PER_MINUTE);
    if (!window.allowed) {
      return oauthError(c, 429, "temporarily_unavailable", "Too many token requests from here. Wait and try again.", { "Retry-After": String(window.retryAfter) });
    }

    // RFC 6749 sends this form-encoded. A JSON body is read too, because some
    // clients send one, and it means the same fields.
    const type = c.req.header("content-type") ?? "";
    let form: URLSearchParams;
    try {
      const text = await c.req.text();
      form = type.includes("application/json")
        ? new URLSearchParams(Object.entries(JSON.parse(text) as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string") as [string, string][])
        : new URLSearchParams(text);
    } catch {
      return oauthError(c, 400, "invalid_request", "The request is form-encoded fields.");
    }
    const key = repeated(form);
    if (key !== undefined) return oauthError(c, 400, "invalid_request", `${key} is sent once.`, {}, "a parameter is sent more than once");
    const field = (key: string) => form.get(key) ?? undefined;

    if (field("grant_type") !== "authorization_code") {
      return oauthError(c, 400, "unsupported_grant_type", "The grant type is authorization_code.");
    }

    // Who is asking: from HTTP Basic, from the body, or from a signed assertion.
    let basicId: string | undefined;
    let basicSecret: string | undefined;
    const authorization = c.req.header("authorization");
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon < 0) throw new Error("no colon");
        basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
        basicSecret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
      } catch {
        return oauthError(c, 401, "invalid_client", "The Basic credentials are not client_id:client_secret.", { "WWW-Authenticate": "Basic" });
      }
    }
    const clientId = basicId ?? field("client_id");
    if (!clientId) return oauthError(c, 401, "invalid_client", "The request names no app.");
    if (basicId !== undefined && field("client_id") !== undefined && field("client_id") !== basicId) {
      return oauthError(c, 400, "invalid_request", "client_id differs between the header and the body.");
    }

    const code = field("code");
    const redirectUri = field("redirect_uri");
    const verifier = field("code_verifier");
    if (!code || !redirectUri || !verifier) {
      return oauthError(c, 400, "invalid_request", "code, redirect_uri and code_verifier are all required.");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthError(c, 400, "invalid_grant", "The code or its verifier does not hold.", {}, "the verifier is not 43 to 128 allowed characters");
    }
    // The code and its verifier before the app: an indexed read and a hash, where the
    // app's document may have to be fetched and its signature checked, both of which
    // cost this service far more than the request cost whoever sent it. Only a live
    // code, for this app, with its verifier, causes either: a code used before or
    // past its five minutes is settled here, and one code cannot hold a fetch open
    // for a day.
    const codeHash = sha256(code);
    const [pending] = await db.read<{
      request_id: string; code_challenge: string; resource: string; client_id: string; redeemed: boolean; recent: boolean; expired: boolean;
      connection_vault: Buffer | null;
    }[]>`
      select request_id::text, code_challenge, resource, client_id, redeemed_at is not null as redeemed,
             redeemed_at > now() - make_interval(secs => ${REPLAY_GRACE_SECONDS}) as recent,
             code_expires_at <= now() as expired, connection_vault
        from schellingaf.oauth_requests where code_hash = ${codeHash}`;
    const notHeld = (why: string) => oauthError(c, 400, "invalid_grant", "The code or its verifier does not hold.", {}, why);
    if (!pending || pending.client_id !== clientId) return notHeld("no live code for this app");
    const computed = createHash("sha256").update(verifier, "ascii").digest();
    const expected = Buffer.from(pending.code_challenge, "base64url");
    if (expected.length !== computed.length || !timingSafeEqual(expected, computed)) return notHeld("the verifier does not match");
    if (pending.redeemed) {
      // The same app with the verifier again within the grace: refused, and what the
      // first use minted stands, because an app that trades twice in a moment is
      // the app (REPLAY_GRACE_SECONDS).
      if (pending.recent) return notHeld("the code was already used, moments ago");
      // A code with its verifier, a second time: whatever the first use minted is
      // revoked, since one of the two was not the app (RFC 6749, section 4.1.2).
      await db.write`select schellingaf.oauth_redeem(${codeHash}, ${clientId}, ${redirectUri}, ${newToken().hash},
                                                     ${TOKEN_TTL_DEFAULT_SECONDS}, ${"an app"})`;
      await endStreamsOfReplayedCode(codeHash);
      return notHeld("the code was already used");
    }
    if (pending.expired) return notHeld("the code expired");

    // Who the app is, and its proof: fetching its document or its keys can say "try
    // later", which the app is told as a 503 it retries.
    const later = () => oauthError(c, 503, "temporarily_unavailable", "The service is busy. Try again in a moment.", { "Retry-After": "5" });
    let client: Client;
    try {
      const fetchFor = fetchForRequest(c);
      const resolved = await resolveClient(db, clientId, fetchFor);
      if ("why" in resolved) return resolved.busy ? later() : oauthError(c, 401, "invalid_client", "No app has that id.", {}, resolved.why);
      client = resolved.client;

      const assertion = field("client_assertion");
      if (client.authMethod === "private_key_jwt") {
        if (field("client_assertion_type") !== ASSERTION_TYPE || !assertion) {
          return oauthError(c, 401, "invalid_client", "This app signs its token requests: send client_assertion.");
        }
        const why = await checkAssertion(client, assertion, [tokenEndpoint, issuer], fetchFor);
        if (why !== null) return oauthError(c, 401, "invalid_client", "The client assertion does not hold.", {}, why);
      } else if (client.authMethod === "client_secret_basic" || client.authMethod === "client_secret_post") {
        const secret = basicSecret ?? field("client_secret");
        if (!secret || !client.secretHash || !timingSafeEqual(sha256(secret), client.secretHash)) {
          return oauthError(c, 401, "invalid_client", "The client secret does not match.", basicId ? { "WWW-Authenticate": "Basic" } : {});
        }
      } else if (assertion !== undefined || basicSecret !== undefined || field("client_secret") !== undefined) {
        return oauthError(c, 401, "invalid_client", "This app registered with no credential and sent one.");
      }
    } catch (error) {
      if (tryLater(error)) return later();
      throw error;
    }

    const resource = field("resource");
    if (resource !== undefined && !sameResource(resource, pending.resource)) {
      return oauthError(c, 400, "invalid_target", `This code is for ${pending.resource}.`);
    }

    try {
      await refuseIfEmpty(db, [LIMITS.serviceTokens()]);
      await spend(c, db, LIMITS.serviceTokens());
    } catch (error) {
      if (error instanceof ApiError && error.code === "RATE_LIMITED") {
        return oauthError(c, 503, "temporarily_unavailable", "The service is issuing no more tokens today.");
      }
      throw error;
    }

    const token = newToken();
    // A yes that came with a connection key: its seed, opened with the code, sealed again
    // under the token minted now, and kept beside the token's hash by oauth_redeem, which
    // deletes the code's copy in the same transaction. Opened in memory, zeroed once it is
    // sealed again, and no reference to it is kept.
    let vault: Buffer | null = null;
    if (pending.connection_vault) {
      const seed = openVault(code, pending.connection_vault, codeVaultData(pending.request_id));
      if (seed === null) throw new ApiError("INTERNAL");
      vault = sealVault(token.token, seed, token.hash);
      seed.fill(0);
    }
    const [row] = await db.write<{ result: { outcome: string; expires_at?: string; scope?: string } }[]>`
      select schellingaf.oauth_redeem(${codeHash}, ${client.id}, ${redirectUri}, ${token.hash},
                                      ${TOKEN_TTL_DEFAULT_SECONDS}, ${labelFor(client)}, ${vault}::bytea) as result`;
    const result = row!.result;
    // Two uses of one code at once: the other was first, and this one, finding the
    // code redeemed under its lock, revoked what the first minted.
    if (result.outcome === "replayed") await endStreamsOfReplayedCode(codeHash);
    if (result.outcome !== "issued") {
      return oauthError(c, 400, "invalid_grant", result.outcome === "blocked"
        ? "The key this code was for is blocked."
        : "The code or its verifier does not hold.", {}, `the code was not redeemed: ${result.outcome}`);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      access_token: token.token,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((Date.parse(result.expires_at!) - Date.now()) / 1000)),
      scope: result.scope,
    });
  });
}

