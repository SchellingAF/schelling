// RFC 8785, the JSON Canonicalization Scheme, with nothing but the language.
//
// A signature is over bytes, and two programs that agree a JSON object means the
// same thing can still write it as different bytes. RFC 8785 fixes one writing:
// no whitespace, object members sorted by the UTF-16 code units of their names,
// strings and numbers exactly as ECMAScript's JSON.stringify writes them. That
// last rule is why this file is short. JSON.stringify of a well-formed string is
// already the canonical string, and of a finite number is ECMAScript's
// Number::toString, which is the canonical number: 4.50 is 4.5, 1E30 is 1e+30,
// and -0 is 0.
//
// The hard part of canonical JSON is usually the numbers. Here it is refusal:
// a lone surrogate, a non-finite number, or a value JSON has no word for, is an
// error rather than something quietly repaired, because a repaired value is a
// value the author never signed.
//
// readCanonical() is the other direction, for bytes that CLAIM to be canonical:
// strict UTF-8, the service's strict JSON rules, and then the bytes must be
// exactly what canonicalize() writes for what they parse to. A duplicate member
// name, a byte-order mark, a space, an escaped slash or 1.0 for 1 all fail that
// comparison, which is the whole check.
//
// test/fixtures/jcs-vectors.json is the contract, and the website's copy of this
// algorithm, which signs a person's post in the browser, runs the same file.

import { ApiError } from "../db/errors.ts";
import { parseStrictJson } from "./validate.ts";

/** The canonical text of a JSON value. Throws TypeError on anything JSON cannot say. */
export function canonicalize(value: unknown): string {
  switch (typeof value) {
    case "string":
      if (!value.isWellFormed()) throw new TypeError("a lone surrogate is not text");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("a non-finite number has no JSON form");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("only plain objects have a JSON form");
      }
      const record = value as Record<string, unknown>;
      // Array.prototype.sort with no comparator orders by UTF-16 code units,
      // which is exactly the order RFC 8785 section 3.2.3 names.
      const names = Object.keys(record).sort();
      return `{${names
        .map((name) => {
          if (!name.isWellFormed()) throw new TypeError("a lone surrogate is not a member name");
          return `${JSON.stringify(name)}:${canonicalize(record[name])}`;
        })
        .join(",")}}`;
    }
    default:
      throw new TypeError(`a ${typeof value} has no JSON form`);
  }
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The value some bytes canonically encode, or a refusal naming `field`.
 *
 * ignoreBOM keeps a byte-order mark in the decoded text instead of silently
 * dropping it, so bytes that start with one fail the comparison below rather
 * than verifying as the bytes after it.
 */
export function readCanonical(bytes: Buffer, field: string): unknown {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new ApiError("INVALID_REQUEST", { detail: `${field} is not UTF-8` });
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch {
    throw new ApiError("INVALID_REQUEST", {
      detail: `${field} is not JSON this service accepts: no NUL, no lone surrogate, no integer above 9007199254740991`,
    });
  }
  let again: string;
  try {
    again = canonicalize(parsed);
  } catch {
    throw new ApiError("INVALID_REQUEST", { detail: `${field} holds a value JSON has no canonical form for` });
  }
  if (again !== text) {
    throw new ApiError("INVALID_REQUEST", {
      detail: `${field} is not RFC 8785 canonical JSON: no whitespace, members sorted, numbers and strings as JSON.stringify writes them`,
    });
  }
  return parsed;
}
