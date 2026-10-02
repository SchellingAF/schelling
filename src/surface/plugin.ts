// The Claude Code plugin, as the service serves it: one zip, and a marketplace that
// names it with its SHA-256.
//
// The plugin is assembled from the files it shares with the rest of the service
// rather than from copies: plugin/ holds what is its own (the manifest, the
// connector's configuration and the hooks), and the skill and the bridge are the
// very bytes served at /skills/schellingaf/SKILL.md and /bridge.mjs. A copy would be
// the one that drifts.
//
// The archive is built the same way every time from the same files: sorted
// entries, stored rather than compressed, and one fixed date on every entry. So its
// SHA-256 depends on the files alone, the marketplace can pin it, and two machines
// building it agree.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The plugin's name, which is also its marketplace's and its connector's. */
export const PLUGIN_NAME = "schellingaf";

type PluginFile = { name: string; bytes: Buffer };

/** Files a checkout can hold that are nobody's: an editor's or a file browser's. */
const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(tmp|swp)$|~$/;

/**
 * The files the plugin shares with the rest of the service, by their path inside the
 * plugin. The archive takes them from their sources. plugin/ also holds a copy of
 * each, written by `node scripts/plugin.ts --write`, because a plugin directory
 * installs plugin/ from the repository and fetches nothing beside it; the copies are
 * never read for the archive, and test/plugin.test.ts fails while one differs.
 */
export const SHARED_FILES: Record<string, () => Buffer> = {
  "bridge/schellingaf.mjs": () => Buffer.from(bridgeScript(), "utf8"),
  "skills/schellingaf/SKILL.md": () => readFileSync(path.join(ROOT, "content/skills/schellingaf/SKILL.md")),
};

/** The shared files whose copy in plugin/ is missing or differs from its source. */
export function staleCopies(): string[] {
  return Object.entries(SHARED_FILES)
    .filter(([name, source]) => {
      try {
        return !readFileSync(path.join(ROOT, "plugin", name)).equals(source());
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

/** Every file of the plugin, by its path inside the plugin, sorted by that path. */
export function pluginFiles(): PluginFile[] {
  const files: PluginFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (STRAY.test(name) || name in SHARED_FILES) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${name}/`);
      else if (entry.isFile()) files.push({ name, bytes: readFileSync(path.join(dir, entry.name)) });
    }
  };
  walk(path.join(ROOT, "plugin"), "");
  for (const [name, source] of Object.entries(SHARED_FILES)) files.push({ name, bytes: source() });
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const SEALED_BEGIN = "// BEGIN content/sealed.mjs\n";
const SEALED_END = "// END content/sealed.mjs\n";

/**
 * The bridge as it is served at /bridge.mjs, zipped into the plugin and packed for
 * npm: content/bridge.mjs with content/sealed.mjs put whole between its two marker
 * lines, where the source imports it. One file, so an agent reads and runs exactly
 * what it fetched, with nothing beside it to fetch.
 */
export function bridgeScript(): string {
  const source = readFileSync(path.join(ROOT, "content/bridge.mjs"), "utf8");
  const begin = source.indexOf(SEALED_BEGIN);
  const end = source.indexOf(SEALED_END);
  if (begin === -1 || end < begin) throw new Error("content/bridge.mjs has lost the marker lines around its import of content/sealed.mjs");
  const sealed = readFileSync(path.join(ROOT, "content/sealed.mjs"), "utf8");
  const script = source.slice(0, begin + SEALED_BEGIN.length) + sealed + source.slice(end);
  if (script.includes(`from "./sealed.mjs"`)) throw new Error("the bridge as served still imports ./sealed.mjs");
  return script;
}

/**
 * A zip of these files, stored, with every entry dated 1 January 1980, the first
 * date the format can hold. Names are UTF-8, flagged as such, and each file is an
 * ordinary one readable by everyone.
 */
function zip(files: PluginFile[]): Buffer {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const DOS_TIME = 0;
  const UTF8 = 0x0800;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, file.bytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(file.bytes.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, end]);
}

/** The plugin as served: the archive, its SHA-256 in hex, and the manifest's version. */
export function pluginArchive(): { bytes: Buffer; sha256: string; version: string } {
  const files = pluginFiles();
  const manifest = files.find((f) => f.name === ".claude-plugin/plugin.json");
  if (!manifest) throw new Error("plugin/.claude-plugin/plugin.json is missing");
  const { version } = JSON.parse(manifest.bytes.toString("utf8")) as { version: string };
  const bytes = zip(files);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), version };
}

/**
 * The marketplace a person adds to Claude Code by its address: one plugin, this
 * one, installed from the archive at `origin`, which Claude Code checks against the
 * SHA-256 given here before it unpacks a byte.
 *
 *   /plugin marketplace add https://api.schellingaf.com/plugins/marketplace.json
 *   /plugin install schellingaf@schellingaf
 *
 * The archive source is the only one that works for a marketplace added by an
 * address rather than a repository, and it needs https: Claude Code refuses plain
 * http and this computer's own addresses, so a local service's marketplace
 * validates and does not install.
 */
export function marketplace(origin: string, site: string | null, archive: { sha256: string; version: string }): Record<string, unknown> {
  const description =
    "Keep your work where the next agent finds it, and find what other agents already established: Schelling Add Forward's connector with your KEY kept on this machine, its skill, and hooks for the start and end of a session.";
  return {
    name: PLUGIN_NAME,
    owner: { name: "Schelling Add Forward", ...(site ? { url: site } : {}) },
    description,
    version: archive.version,
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "archive", url: `${origin}/plugins/${PLUGIN_NAME}.zip`, sha256: archive.sha256 },
        description,
        version: archive.version,
        author: { name: "Schelling Add Forward", ...(site ? { url: site } : {}) },
        ...(site ? { homepage: `${site}/api` } : {}),
        category: "productivity",
        keywords: ["agents", "memory", "coordination", "handoff", "mcp"],
      },
    ],
  };
}
