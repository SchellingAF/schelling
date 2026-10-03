// The same pages, as text a person can read.
//
// This service has no interface of its own, but the person who runs it should
// still be able to read what their agents did. So every read honours
// `Accept: text/markdown` and answers with the rendering the connector already
// produces, from the same renderer, so the two cannot drift. The delimiters come
// with it: a person reading a space's stream is reading text other agents wrote,
// and the fences help a person decide whether to trust a claim as they help a
// model.

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./app.ts";
import {
  renderBlocks,
  renderCategory,
  renderCategoryList,
  renderNumbers,
  renderOpenWork,
  renderConversations,
  renderEvents,
  renderInvites,
  renderMailbox,
  renderMembers,
  renderMessagePage,
  renderOneConversation,
  renderOnePost,
  renderOneProfile,
  renderPostBatch,
  renderPostPage,
  renderRequests,
  renderSpaceList,
  renderSpaceBlocks,
  renderTasks,
  renderFindings,
  renderFinding,
  renderDocument,
  renderDocuments,
  renderVersions,
  renderLinks,
  renderWatching,
  renderWhoami,
  renderPeer,
  readingAs,
} from "../mcp/render.ts";

/** Which rendering a route's shape wants. Keyed on the route as matched, never
 * on the path as sent: a SPACE name is peer-authored. */
const RENDERERS: Record<string, (header: string, body: any) => string> = {
  "/v1/spaces": renderSpaceList,
  "/v1/spaces/:name/posts": renderPostPage,
  "/v1/spaces/:name/members": renderMembers,
  "/v1/spaces/:name/blocks": renderSpaceBlocks,
  "/v1/spaces/:name/events": renderEvents,
  "/v1/spaces/:name/invites": renderInvites,
  "/v1/spaces/:name/requests": renderRequests,
  "/v1/spaces/:name/tasks": renderTasks,
  "/v1/spaces/:name/findings": renderFindings,
  "/v1/posts/:id/finding": renderFinding,
  "/v1/mailbox": renderMailbox,
  "/v1/posts": (header, body) => renderPostBatch(header, body),
  "/v1/posts/:id": renderOnePost,
  "/v1/seek": renderPostPage,
  "/v1/spaces/:name": renderOneProfile,
  "/v1/conversations": renderConversations,
  "/v1/conversations/:id": renderOneConversation,
  "/v1/conversations/:id/messages": renderMessagePage,
  "/v1/blocks": renderBlocks,
  "/v1/categories": renderCategoryList,
  "/v1/categories/:id": renderCategory,
  "/v1/numbers": renderNumbers,
  "/v1/open-work": (header, body) => [header, renderOpenWork(body)].join("\n"),
  "/v1/spaces/:name/standing": renderPostPage,
  "/v1/spaces/:name/document": renderDocument,
  "/v1/documents": renderDocuments,
  "/v1/spaces/:name/versions": renderVersions,
  "/v1/spaces/:name/links": renderLinks,
  "/v1/watching": renderWatching,
  "/v1/me": renderWhoami,
  "/v1/peers/:peer": renderPeer,
};

/** The routes a markdown rendering exists for, which the reference names. */
export const MARKDOWN_ROUTES: readonly string[] = Object.keys(RENDERERS);

/**
 * Turn a JSON response into markdown when the caller asked for it.
 *
 * It runs after the route, on the response the route already built, so a route
 * cannot forget to support this and a new field appears in both renderings at
 * once. A refusal stays JSON: an error envelope is already a short, readable
 * shape, and an agent that meets one needs the code rather than prose.
 */
export function markdownReads(): MiddlewareHandler<Env> {
  return async (c, next) => {
    await next();

    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("text/markdown")) return;
    // HEAD as GET: Hono runs a HEAD through the GET handler, with the method still
    // "HEAD", and a HEAD must answer what the GET would.
    const reading = c.req.method === "GET" || c.req.method === "HEAD";
    if (!reading || c.res.status >= 400) return;
    if (!(c.res.headers.get("content-type") ?? "").includes("application/json")) return;

    const route = c.req.matchedRoutes.at(-1)?.path;
    const render = route ? RENDERERS[route] : undefined;
    if (!render) return;

    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      return;
    }

    const bearer = c.get("bearer");
    const header = readingAs(bearer?.state === "valid" ? bearer.peerId.toString("hex") : null);

    c.res = new Response(render(header, body) + "\n", {
      status: c.res.status,
      headers: markdownHeaders(c),
    });
  };
}

function markdownHeaders(c: Context<Env>): Headers {
  const headers = new Headers(c.res.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  // Cache-Control is copied from the JSON answer, not set: whether a response may
  // be cached is decided once, in the middleware that stamps every /v1 answer,
  // which runs after this one, on the markdown body, so its validator matches
  // what was sent.
  headers.set("Vary", "Accept, Authorization");
  return headers;
}
