// The addresses an app names when it signs a person in: where to send the person
// back to, which server it wants a token for, and the address that is its own id.
//
// These decide where a code goes, so every rule here is a way a code could go
// somewhere it should not.

/** The verdict on a redirect URI: allowed, and whether on loopback, or why not. */
type RedirectCheck = { ok: true; loopback: boolean } | { ok: false; reason: string };

/**
 * Schemes no app may be sent back to, whatever it registers: each one runs, reads
 * or navigates somewhere a code must never land.
 */
const FORBIDDEN_SCHEMES = new Set([
  "javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "filesystem:",
  "view-source:", "chrome:", "chrome-extension:", "moz-extension:", "ws:", "wss:",
  "ftp:", "mailto:", "tel:", "sms:",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The schemes of programs that sign people in to MCP servers and predate RFC 8252's
 * rule below, taken as they are: each opens a code editor.
 */
const KNOWN_PROGRAM_SCHEMES = new Set(["cursor:", "vscode:", "vscode-insiders:", "windsurf:", "zed:"]);

/**
 * Whether an address is one an app may register to be sent back to.
 *
 * https anywhere. http only to this computer's own loopback, which is where a
 * program on the person's machine, Claude Code for one, listens for the answer
 * (RFC 8252, section 7.3). Another scheme only as RFC 8252, section 7.1, has a
 * program's own written: a domain name its publisher holds, reversed, such as
 * com.example.app, or one of the few above. The operating systems hand their own
 * short schemes to programs that search the disk, install software or open system
 * settings (search-ms:, ms-msdt:, itms-services:), and a page sending a browser to
 * one is an attack of long standing. Never a fragment, never a user name or password.
 */
export function checkRedirectUri(value: unknown): RedirectCheck {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2048) {
    return { ok: false, reason: "a redirect URI is a string of at most 2048 bytes" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "a redirect URI is an absolute URI" };
  }
  if (url.hash !== "" || value.includes("#")) return { ok: false, reason: "a redirect URI has no fragment" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "a redirect URI carries no user name or password" };
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return { ok: false, reason: `a redirect URI may not use ${url.protocol}` };
  if (url.protocol === "https:") return { ok: true, loopback: false };
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? { ok: true, loopback: true }
      : { ok: false, reason: "a redirect URI over http must be this computer's loopback: localhost, 127.0.0.1 or [::1]" };
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return { ok: false, reason: "a redirect URI's scheme is not one this service reads" };
  if (KNOWN_PROGRAM_SCHEMES.has(url.protocol)) return { ok: true, loopback: false };
  const labels = url.protocol.slice(0, -1).split(".");
  if (labels.length < 2 || labels.some((label) => label === "") || url.protocol.startsWith("x-apple.")) {
    return { ok: false, reason: "a program's own scheme is a domain name its publisher holds, reversed, such as com.example.app (RFC 8252, section 7.1)" };
  }
  return { ok: true, loopback: false };
}

/** Whether an address is one an app may be sent back to on this computer's loopback. */
export function isLoopback(uri: unknown): boolean {
  const check = checkRedirectUri(uri);
  return check.ok && check.loopback;
}

/**
 * Whether the address an app asked to be sent back to is one it registered.
 *
 * Exactly, character for character, except on loopback, where the port is left
 * out of the comparison: a program listening for the answer picks a free port each
 * time, and the specification requires a server to accept any (RFC 8252, section
 * 7.3). Claude Code registers http://localhost/callback and http://127.0.0.1/callback
 * with no port at all, and is sent back to whichever port it opened.
 */
export function redirectMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  if (!isLoopback(asked)) return false;
  const want = new URL(asked);
  return registered.some((one) => {
    if (!isLoopback(one)) return false;
    const have = new URL(one);
    return have.protocol === want.protocol && have.hostname === want.hostname &&
      have.pathname === want.pathname && have.search === want.search;
  });
}

/** The host a person is shown for an address they will be sent to. */
export function shownHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host !== "" ? url.host : url.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/** The resource an app names, compared as the specification's canonical form: the
 * scheme and host in lower case, which URL does, and no trailing slash. */
export function sameResource(asked: string, ours: string): boolean {
  let url: URL;
  try {
    url = new URL(asked);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.search !== "" || url.username !== "" || url.password !== "") return false;
  const canonical = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return canonical === ours;
}

/**
 * Whether an app's id is the address of a client ID metadata document it publishes.
 *
 * The draft's rules: https, with a path, and no fragment, user name, password or
 * dot segment. A query is refused too, because two addresses that differ only in a
 * query would be two apps with one publisher's name on both.
 */
export function isMetadataDocumentId(value: string): boolean {
  if (!value.startsWith("https://") || Buffer.byteLength(value, "utf8") > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value) return false;
  if (url.hash !== "" || url.search !== "" || url.username !== "" || url.password !== "") return false;
  if (url.pathname === "/" || url.pathname === "") return false;
  if (/(^|\/)\.\.?(\/|$)/.test(url.pathname)) return false;
  return true;
}

/** An address to send a person back to, with the answer added to its query. */
export function withQuery(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}
