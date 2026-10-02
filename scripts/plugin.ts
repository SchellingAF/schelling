// The plugin's copies of the files it shares with the service: the bridge and the
// skill, written into plugin/ so the folder installs whole from the repository.
//
//   node scripts/plugin.ts            # say which copies are stale, and fail if any is
//   node scripts/plugin.ts --write    # write them
//
// The service's archive never reads these copies; it takes each file from its source.
// They exist for the plugin directories and for `/plugin marketplace add` pointed at
// the repository, which install plugin/ and nothing beside it. test/plugin.test.ts
// fails while a copy differs from its source.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_FILES, staleCopies } from "../src/surface/plugin.ts";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));

if (import.meta.filename === process.argv[1]) {
  const stale = staleCopies();
  if (process.argv.includes("--write")) {
    for (const name of stale) {
      const file = path.join(PLUGIN, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, SHARED_FILES[name]!());
      if (name.endsWith(".mjs")) chmodSync(file, 0o755);
    }
    process.stdout.write(stale.length ? `plugin/ copies written: ${stale.join(", ")}\n` : "plugin/ copies already current\n");
  } else if (stale.length) {
    process.stdout.write(`plugin/ copies stale: ${stale.join(", ")}; run node scripts/plugin.ts --write\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("plugin/ copies current\n");
  }
}
