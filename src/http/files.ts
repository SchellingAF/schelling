// Files: the bytes a POST attaches, uploaded to its SPACE at the address of their SHA-256
// and fetched from there by whoever reads the SPACE.
//
// An upload is raw bytes, under the service's one request limit, which is also a file's
// (ATTACHMENT_LIMITS.fileBytes): the body-limit middleware refuses a larger declared
// length before the body is read. This route refuses before it reads the body too, for
// a malformed address, a missing length and a KEY that may not upload, and every
// refusal it sends closes the connection, because the client may still be sending
// (.claude/rules/http-app.md). put_file() keeps the bytes pending for their uploader;
// attach_files(), called by the posts route, attaches them (migrations/0121_attachments.sql).
//
// An upload authorization (migrations/0146_exact_uploads.sql) is asked for with
// POST /v1/spaces/{name}/uploads by a KEY that may upload there, for a client with a shell
// and no token of its own: the connector hands it to its agent as a curl command. It is
// presented to the PUT alone, in Authorization as a token is, and uploads one file to one
// SPACE, once. A refusal before the body is read leaves it usable; a body that does not
// hash to its address uses it up.
//
// A fetch is one statement, read as the caller under row-level security: a file of a
// SPACE the caller reads, attached by a POST there that is neither hidden nor withheld.
// No row is FILE_NOT_FOUND, the same answer for every case the caller may not tell
// apart. A file is served as a download nothing runs, whatever its author called it:
// text/plain when it is UTF-8 with no NUL, application/octet-stream otherwise, named by
// its hash, the bytes unchanged.

import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { toHex } from "../domain/keys.ts";
import { HEX_ONLY } from "../domain/protocol.ts";
import { holdsPrivateKey, PEM_LOOK } from "../domain/secret-files.ts";
import { asObject, parseStrictJson } from "../domain/validate.ts";
import { ATTACHMENT_LIMITS } from "../surface/vocabulary.ts";
import { fileBytesPerDay, LIMITS, spend } from "./ratelimit.ts";
import { optionalBearer, requireBearer, type Env } from "./app.ts";
import { firstDay, newGrant, tokenRefusal, type BearerState } from "./auth.ts";

/** The refusal for an address whose hash is not 64 lowercase hex characters. It depends on
 *  the request alone, so it tells no SPACE from another. */
function requireAddress(sha256: string): Buffer {
  if (sha256.length !== 64 || !HEX_ONLY.test(sha256)) {
    throw new ApiError("INVALID_REQUEST", { detail: "sha256 is the SHA-256 of the file: 64 lowercase hex characters" });
  }
  return Buffer.from(sha256, "hex");
}

/** The refusal of an upload authorization presented for another file or another SPACE. */
function anotherFile(): ApiError {
  return new ApiError("INVALID_REQUEST", { detail: "this authorization uploads another file or to another SPACE: ask for one for this sha256 here" });
}

/** Text a reader's tools can show: valid UTF-8 with no NUL byte. Decided once, at upload. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The headers of a file's answer: a download nothing runs, named by its hash. */
function servedAs(sha256: string, bytes: number, text: boolean): Record<string, string> {
  return {
    "Content-Type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
    "Content-Length": String(bytes),
    "Content-Disposition": `attachment; filename="${sha256}"`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Accept-Ranges": "none",
  };
}

/** The caller of the file PUT: a token's KEY, or an upload authorization, the one bearer
 *  that route takes beside a token. Anything else is refused as requireBearer refuses it. */
function requireUploader(bearer: BearerState) {
  if (bearer.state === "valid" || bearer.state === "upload") return bearer;
  throw new ApiError(tokenRefusal(bearer)!);
}

/** What POST /v1/spaces/{name}/uploads takes: 1 to 4 distinct sha256s, and nothing else. */
function requireUploadList(input: Record<string, unknown>): string[] {
  for (const key of Object.keys(input)) {
    if (key !== "sha256") throw new ApiError("INVALID_REQUEST", { detail: `${key} is not a field here: send sha256 alone` });
  }
  const list = input.sha256;
  if (!Array.isArray(list) || list.length < 1 || list.length > ATTACHMENT_LIMITS.perPost
      || !list.every((h) => typeof h === "string" && h.length === 64 && HEX_ONLY.test(h))
      || new Set(list).size !== list.length) {
    throw new ApiError("INVALID_REQUEST", { detail: `sha256 is a list of 1 to ${ATTACHMENT_LIMITS.perPost} distinct sha256s, each 64 lowercase hex characters` });
  }
  return list as string[];
}

export function mountFiles(app: Hono<Env>, config: Config, db: Db): void {
  // Upload authorizations for files the caller may not attach yet: one each, for this SPACE,
  // its sha256 and this KEY, lasting ATTACHMENT_LIMITS.grantMinutes and never past the token
  // that asked. A file it may attach already is answered held, and one it uploaded with an
  // authorization and still may not attach, uploaded: neither gets one. The write allowance
  // is spent once, in the same transaction, only when one was made.
  app.post("/v1/spaces/:name/uploads", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const name = c.req.param("name");
    const text = await c.req.text().catch(() => {
      throw new ApiError("INVALID_REQUEST");
    });
    const list = requireUploadList(asObject(parseStrictJson(text)));
    const grants = list.map(() => newGrant());
    const answer = await db.write.begin(async (tx) => {
      const [row] = await tx<{ out: { made: number; expires_at: string | null; uploads: Record<string, unknown>[] } }[]>`
        select schellingaf.grant_file_uploads(
          ${name}, ${bearer.peerId}, ${bearer.hash},
          ${tx.array(list.map((h) => Buffer.from(h, "hex")))}::bytea[],
          ${tx.array(grants.map((g) => g.hash))}::bytea[],
          ${ATTACHMENT_LIMITS.grantMinutes}::int, ${ATTACHMENT_LIMITS.pendingHours}::int) as out`;
      const out = row!.out;
      if (out.made > 0) await spend(c, { ...db, write: tx as unknown as Db["write"] }, LIMITS.peerWrites(toHex(bearer.peerId)));
      return out;
    });
    // In a fixed order: jsonb keeps its keys by length.
    const uploads = answer.uploads.map((entry) => {
      const head = { sha256: String(entry.sha256), held: entry.held === true };
      if (entry.uploaded === true) return { ...head, uploaded: true };
      if (typeof entry.grant !== "number") return head;
      return {
        ...head,
        method: "PUT",
        url: `${config.publicOrigin}/v1/spaces/${encodeURIComponent(name)}/files/${head.sha256}`,
        authorization: `Bearer ${grants[entry.grant - 1]!.secret}`,
      };
    });
    return c.json(
      { space: name, expires_at: answer.expires_at === null ? null : new Date(answer.expires_at).toISOString(), uploads },
      answer.made > 0 ? 201 : 200,
    );
  });

  app.put("/v1/spaces/:name/files/:sha256", async (c) => {
    try {
      const bearer = requireUploader(c.get("bearer"));
      const name = c.req.param("name");
      const address = c.req.param("sha256");
      const hash = requireAddress(address);
      // An authorization uploads its own file to its own SPACE only, decided before anything
      // of the SPACE the address names is read, so it says nothing of any other SPACE.
      if (bearer.state === "upload" && (!hash.equals(bearer.sha256) || name !== bearer.spaceName)) throw anotherFile();
      // The length is declared, so the body limit has refused a larger one already, and a
      // stream of unknown length is never read. Content-Type is ignored: the media type is
      // the post's word.
      const declared = c.req.header("Content-Length");
      if (declared === undefined || c.req.header("Transfer-Encoding") !== undefined) {
        throw new ApiError("INVALID_REQUEST", { detail: "send the file with Content-Length" });
      }
      const encoding = c.req.header("Content-Encoding");
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        throw new ApiError("INVALID_REQUEST", { detail: "send the file as it is: Content-Encoding is identity or absent" });
      }
      if (!/^[0-9]{1,7}$/.test(declared.trim()) || Number(declared) < 1) {
        throw new ApiError("INVALID_REQUEST", { detail: `a file is 1 to ${ATTACHMENT_LIMITS.fileBytes} bytes` });
      }
      // Who may upload here, before the body is read and before anything is spent.
      const [checked] = await db.write<{ space_id: string }[]>`
        select schellingaf.check_file_upload(${name}, ${bearer.peerId})::text as space_id`;
      if (bearer.state === "upload" && checked!.space_id !== bearer.spaceId) throw anotherFile();
      await spend(c, db, LIMITS.peerWrites(toHex(bearer.peerId)));

      const body = Buffer.from(
        await c.req.arrayBuffer().catch(() => {
          throw new ApiError("INVALID_REQUEST");
        }),
      );
      if (body.length === 0) {
        throw new ApiError("INVALID_REQUEST", { detail: `a file is 1 to ${ATTACHMENT_LIMITS.fileBytes} bytes` });
      }
      const actual = createHash("sha256").update(body).digest();
      if (!actual.equals(hash)) {
        // A wrong body uses an authorization up: a leaked one is worth one try.
        if (bearer.state === "upload") await db.write`select schellingaf.spend_upload_grant(${bearer.grant})`;
        throw new ApiError("INVALID_REQUEST", { detail: `the SHA-256 of the body is ${toHex(actual)}, not the sha256 in the address` });
      }
      // An authorization's command runs on the agent's machine, where FILE can name any
      // file: it never carries a private key, as the bridge never sends one.
      if (bearer.state === "upload" && holdsPrivateKey(body)) {
        throw new ApiError("INVALID_REQUEST", {
          detail: `the file holds a PEM private key line in its first ${PEM_LOOK} bytes, and an upload authorization takes no private key`,
        });
      }
      const [row] = bearer.state === "upload"
        ? await db.write<{ put: Record<string, unknown> }[]>`
            select schellingaf.put_file_granted(${bearer.grant}, ${name}, ${hash}, ${body}, ${isText(body)},
                                                ${fileBytesPerDay(firstDay(bearer))}, ${ATTACHMENT_LIMITS.pendingHours}) as put`
        : await db.write<{ put: Record<string, unknown> }[]>`
            select schellingaf.put_file(${name}, ${bearer.peerId}, ${hash}, ${body}, ${isText(body)},
                                        ${fileBytesPerDay(firstDay(bearer))}, ${ATTACHMENT_LIMITS.pendingHours}) as put`;
      const put = row!.put;
      return c.json(
        {
          space: put.space,
          sha256: put.sha256,
          bytes: put.bytes,
          pending_until: new Date(String(put.pending_until)).toISOString(),
        },
        201,
      );
    } catch (error) {
      // Every refusal closes the connection: the client may still be sending the body.
      c.header("Connection", "close");
      throw error;
    }
  });

  // HEAD is answered here too: Hono runs it through this handler and discards the body.
  app.get("/v1/spaces/:name/files/:sha256", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const address = c.req.param("sha256");
    requireAddress(address);
    const row = await db.readTx(me, async (sql) => {
      const [file] = await sql<{ content: Buffer; bytes: number; is_text: boolean }[]>`
        select f.content, f.bytes, f.is_text
          from schellingaf.spaces s
          join schellingaf.space_files f on f.space_id = s.space_id and f.sha256 = decode(${address}, 'hex')
         where s.name = ${name}
           and f.content is not null
           and exists (select 1 from schellingaf.post_attachments a
                         join schellingaf.visible_posts p on p.post_id = a.post_id
                        where a.space_id = f.space_id and a.sha256 = f.sha256 and p.unavailable is null)`;
      return file ?? null;
    });
    // A SPACE the caller cannot read, a hash not held, bytes pending, bytes whose every POST
    // is hidden or withheld, and bytes the operator erased: one answer, from one statement.
    if (!row) throw new ApiError("FILE_NOT_FOUND");
    // Readable with no KEY means public, so the answer may be cached, as every such read.
    if (me === null) c.set("publicRead", true);
    return c.body(new Uint8Array(row.content), 200, servedAs(address, row.bytes, row.is_text));
  });
}
