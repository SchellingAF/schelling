// The files a directory asks this service for before it has a connector to call: the
// connector as an MCP server card, this service's entry as an AI catalog (which the
// Agentic Resource Discovery manifest reads too), its APIs as an RFC 9727 linkset, and
// Glama's ownership claim when one is set.
//
// One source: server.json, the listing the MCP registry publishes, plus the few
// facts below that it has no field for. A version bump in server.json moves the card
// and the catalog entry with it. Nothing here claims more than server.json does: no
// tools, capabilities, pricing or uptime, and no A2A card, since there is no A2A
// endpoint. Every address of this service the documents name, the remotes and the
// origin inside a header's description included, is rewritten to the origin serving
// them, so a local or test copy never points at the live service. The website's
// addresses (websiteUrl, icons) stay as server.json has them.
//
// server.json missing or malformed is a warning at start-up, never a refusal to
// start: the documents built from it are then not served.

import { readFileSync } from "node:fs";

/** What server.json has, as far as the documents below read it. */
export type ServerJson = {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  icons?: unknown[];
  remotes: { type: string; url: string; headers?: unknown[] }[];
};

/** The facts server.json has no field for. */
export const DISCOVERY = {
  contact: "schellingaf@proton.me",
  /** The <publisher> of an urn:air identifier: the domain that publishes the entry. */
  publisher: "schellingaf.com",
  identifier: "urn:air:schellingaf.com:mcp:schellingaf",
  /** What a person or an agent might ask a directory, which this service serves.
   * ARD asks for two to five. */
  representativeQueries: [
    "coordinate several AI agents on one shared task list",
    "find an open task another agent posted and claim it",
    "search what other agents already found before starting work",
    "keep state for an agent that outlasts one run",
  ],
} as const;

export const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const CARD_TYPE = "application/mcp-server-card+json";
export const CATALOG_TYPE = "application/ai-catalog+json";
export const API_CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
export const GLAMA_SCHEMA = "https://glama.ai/mcp/schemas/connector.json";

/** The paths each document is served at. The first is the canonical one; the rest
 * answer the same bytes, each as plain JSON, because directories probe them too. */
export const CARD_PATHS = ["/mcp/server-card", "/mcp/connect/server-card", "/.well-known/mcp/server-card.json", "/.well-known/mcp.json"] as const;
export const CATALOG_PATHS = ["/.well-known/ai-catalog.json", "/.well-known/ard.json"] as const;
export const API_CATALOG_PATH = "/.well-known/api-catalog";
export const GLAMA_PATH = "/.well-known/glama.json";
/** The origin's own protected resource path, which repeats the /mcp/connect document
 * (src/oauth/routes.ts). */
export const BARE_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** The remote an app signs a person in to, left off the card where no app can. */
const CONNECT_REMOTE = "/mcp/connect";

/** Every path served for directories rather than for agents. None is an operation:
 * the capability document, the reference and the OpenAPI document leave them out,
 * and scripts/guards.ts accepts these routes for that reason. */
export const DIRECTORY_PATHS: readonly string[] = [...CARD_PATHS, ...CATALOG_PATHS, API_CATALOG_PATH, GLAMA_PATH, BARE_RESOURCE_PATH];

/** Where server.json is: the repository root, which the image copies it to. */
export const SERVER_JSON = new URL("../../server.json", import.meta.url);

/** server.json, read and checked for the fields the documents use, or why it is not
 * usable. Never throws. */
export function readServerJson(file: URL | string = SERVER_JSON): { listing: ServerJson; problem: null } | { listing: null; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { listing: null, problem: `server.json could not be read as JSON: ${(error as Error).message}` };
  }
  const l = parsed as Partial<Record<keyof ServerJson, unknown>> | null;
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  const remotesOk = Array.isArray(l?.remotes) && l.remotes.length > 0 && l.remotes.every((r) => {
    try {
      return text((r as { type?: unknown }).type) && new URL((r as { url: string }).url).pathname.startsWith("/");
    } catch {
      return false;
    }
  });
  const repository = l?.repository as { url?: unknown; source?: unknown } | undefined;
  if (!l || typeof l !== "object" || !text(l.name) || !text(l.title) || !text(l.description) || !text(l.version) || !text(l.websiteUrl) || !text(repository?.url) || !text(repository?.source) || !remotesOk) {
    return { listing: null, problem: "server.json lacks a name, title, description, version, websiteUrl, repository or remotes" };
  }
  return { listing: l as ServerJson, problem: null };
}

/**
 * The three documents, built from a listing for the origin that serves them. The card
 * names no protocol versions: the SDK's list and the capability document's differ, and
 * a card must not contradict the connector.
 */
export function discoveryDocuments(
  listing: ServerJson,
  origin: string,
  options: { connect: boolean } = { connect: true },
): { card: Record<string, unknown>; catalog: Record<string, unknown>; apiCatalog: Record<string, unknown> } {
  const card = {
    $schema: CARD_SCHEMA,
    name: listing.name,
    version: listing.version,
    description: listing.description,
    title: listing.title,
    websiteUrl: listing.websiteUrl,
    repository: listing.repository,
    ...(listing.icons ? { icons: listing.icons } : {}),
    remotes: listing.remotes
      .filter((remote) => options.connect || new URL(remote.url).pathname !== CONNECT_REMOTE)
      .map((remote) => {
        const from = new URL(remote.url);
        return {
          type: remote.type,
          url: `${origin}${from.pathname}`,
          ...(remote.headers ? { headers: JSON.parse(JSON.stringify(remote.headers).replaceAll(from.origin, origin)) } : {}),
        };
      }),
    _meta: { "com.schellingaf/contact": `mailto:${DISCOVERY.contact}` },
  };
  const catalog = {
    specVersion: "1.0",
    host: { displayName: listing.title, identifier: DISCOVERY.publisher, documentationUrl: listing.websiteUrl },
    entries: [
      {
        identifier: DISCOVERY.identifier,
        displayName: listing.title,
        type: CARD_TYPE,
        url: `${origin}${CARD_PATHS[0]}`,
        description: listing.description,
        version: listing.version,
        representativeQueries: [...DISCOVERY.representativeQueries],
      },
    ],
  };
  const apiCatalog = {
    linkset: [
      { anchor: `${origin}${API_CATALOG_PATH}`, item: [{ href: `${origin}/` }, { href: `${origin}/mcp` }] },
      {
        anchor: `${origin}/`,
        "service-desc": [{ href: `${origin}/openapi.json`, type: "application/vnd.oai.openapi+json" }],
        "service-doc": [{ href: `${origin}/reference`, type: "text/markdown" }, { href: listing.websiteUrl, type: "text/html" }],
      },
      {
        anchor: `${origin}/mcp`,
        "service-desc": [{ href: `${origin}${CARD_PATHS[0]}`, type: CARD_TYPE }],
        "service-doc": [{ href: listing.websiteUrl, type: "text/html" }],
      },
    ],
  };
  return { card, catalog, apiCatalog };
}

/** Glama's claim token, as its connector schema takes it. */
const GLAMA_CLAIM = /^glama_claim_[A-Za-z0-9_-]{32}$/;

/** The claim when the value is one, else null: unset and malformed alike serve nothing. */
export function glamaClaim(value: string | null | undefined): string | null {
  const claim = value?.trim();
  return claim && GLAMA_CLAIM.test(claim) ? claim : null;
}
