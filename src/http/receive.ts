// How long the server waits while a request arrives: the options Node's server takes,
// and a watch that stops waiting for a request whose body sends nothing for
// HTTP_BODY_IDLE_SECONDS while the server is ready to read it. The numbers are read
// once, in src/config.ts (receiveLimits). src/server.ts passes receiveOptions to
// serve() and calls watchBodies on the server it returns.
//
// Nothing here applies once a request has arrived whole: an answer that takes longer,
// a waiting read or a live-updates stream, is not touched.

import type { IncomingMessage, Server, ServerOptions } from "node:http";
import { receiveLimits, type Config } from "../config.ts";

/** How often the server checks the requests it is waiting on: Node's own check of
 * the headers and request limits, and the body watch below. */
export const CONNECTIONS_CHECKING_MS = 2_000;
const BODY_WATCH_MS = 1_000;

/**
 * The options for Node's server, in milliseconds: headers within HTTP_HEADERS_SECONDS
 * and the whole request within HTTP_REQUEST_SECONDS, checked every two seconds. Past
 * either, Node answers 408 and closes the connection. keepAliveTimeout stays Node's.
 */
export function receiveOptions(config: Pick<Config, "receive">): ServerOptions {
  const limits = config.receive ?? receiveLimits();
  return {
    headersTimeout: limits.headersSeconds * 1000,
    requestTimeout: limits.requestSeconds * 1000,
    connectionsCheckingInterval: CONNECTIONS_CHECKING_MS,
  };
}

/** The body watch of one server. `watching` is how many requests it holds now;
 * `running` is false once the server has closed and the watch has stopped. */
export type BodyWatch = { readonly watching: number; readonly running: boolean };

type Watched = { bytesRead: number; quietSince: number };

/**
 * Stops waiting for a request whose body sends nothing for `idleMs` while the server
 * is ready to read it. Call it on the server serve() returns, before any connection.
 *
 * A request is watched when it declares a body: a Content-Length above 0, or a
 * Transfer-Encoding. The watch never reads the body and never listens for its data, so
 * the body waits for the route to read it. Once a second, for every watched request:
 *
 *   - arrived whole (req.complete) or closed: no longer watched;
 *   - the connection has read more bytes since the last look, or the server holds as
 *     much as it buffers and the route has not read it yet: the quiet clock restarts,
 *     since the server is holding the body back, not the client;
 *   - quiet for idleMs: the connection is closed, as Node closes one past its request
 *     limit. Not a 408: the route may still answer, and two answers on one
 *     connection would collide. The route's read of the body ends as when a client
 *     goes away.
 *
 * One interval for all of them, unref()ed so it never holds the process open, and
 * cleared when the server closes.
 */
export function watchBodies(server: Server, idleMs: number): BodyWatch {
  const watched = new Map<IncomingMessage, Watched>();
  let running = true;

  server.on("request", (req: IncomingMessage) => {
    if (!declaresBody(req) || req.complete) return;
    watched.set(req, { bytesRead: req.socket.bytesRead, quietSince: Date.now() });
    req.once("close", () => watched.delete(req));
  });

  const tick = setInterval(() => {
    const now = Date.now();
    for (const [req, seen] of watched) {
      if (req.complete || req.destroyed) {
        watched.delete(req);
        continue;
      }
      // A socket already gone has nothing left to wait for.
      const bytesRead = req.socket?.bytesRead;
      if (bytesRead === undefined) {
        watched.delete(req);
        continue;
      }
      if (bytesRead > seen.bytesRead || req.readableLength >= req.readableHighWaterMark) {
        seen.bytesRead = bytesRead;
        seen.quietSince = now;
        continue;
      }
      if (now - seen.quietSince >= idleMs) {
        watched.delete(req);
        req.socket.destroy();
      }
    }
  }, BODY_WATCH_MS);
  tick.unref();

  server.once("close", () => {
    clearInterval(tick);
    watched.clear();
    running = false;
  });

  return {
    get watching() {
      return watched.size;
    },
    get running() {
      return running;
    },
  };
}

function declaresBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const length = Number(req.headers["content-length"] ?? 0);
  return Number.isFinite(length) && length > 0;
}
