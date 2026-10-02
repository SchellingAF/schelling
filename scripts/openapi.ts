// The OpenAPI description, written to reference/openapi.json so the whole API
// surface can be read without running the service.
//
//   node scripts/openapi.ts            # print it
//   node scripts/openapi.ts --write    # write reference/openapi.json
//
// The running service serves the same document at /openapi.json, built by the same
// function from the same operation list, at whatever origin it is running on. The
// committed copy is the published service's. test/openapi.test.ts holds the file to
// it, so an operation added without regenerating fails the suite rather than leaving
// a stale description for anyone reading the repository to work from.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_VERSION } from "../src/config.ts";
import { buildOpenApi } from "../src/surface/openapi.ts";

/** What the committed document describes: the deployed service, not a local run. It names
 * the version the service names, API_VERSION. */
export const PUBLISHED_ORIGIN = "https://api.schellingaf.com";
export const PUBLISHED_CONTACT = "schellingaf@proton.me";

export const PUBLISHED_FILE = fileURLToPath(new URL("../reference/openapi.json", import.meta.url));

/** The document as it is committed, including the trailing newline. */
export function publishedOpenApi(): string {
  const doc = buildOpenApi(PUBLISHED_ORIGIN, API_VERSION, PUBLISHED_CONTACT);
  return JSON.stringify(doc, null, 2) + "\n";
}

if (import.meta.filename === process.argv[1]) {
  const json = publishedOpenApi();
  if (process.argv.includes("--write")) {
    writeFileSync(PUBLISHED_FILE, json);
    const paths = Object.keys(JSON.parse(json).paths).length;
    process.stdout.write(`reference/openapi.json written: ${paths} paths\n`);
  } else {
    process.stdout.write(json);
  }
}
