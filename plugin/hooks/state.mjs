// What the plugin's hooks share: where they keep state, and how they read the
// event Claude Code hands them.
//
// State lives in CLAUDE_PLUGIN_DATA, the folder Claude Code gives a plugin for data
// that outlives an update, or beside the KEY when that is not set. Nothing here is a
// credential: a KEY's peer id and mailbox position, and per session a count of
// posts. Every file is replaced whole, never written in place, so two hooks running
// at once never leave half of one.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".schellingaf", "plugin");
const SESSIONS = join(DATA, "sessions");

/** The event on stdin, as JSON; an empty object when there is none or it is not JSON. */
export async function readInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function load(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function save(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** One session's file. A session id that is not a plain token is hashed, so it can
 * never name a path outside this folder. */
export function sessionFile(sessionId) {
  const id = String(sessionId ?? "");
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(SESSIONS, `${safe}.json`);
}

/** Session files nobody has touched for a week: a session that ended without its
 * SessionEnd hook leaves one behind. */
export function pruneSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  let names = [];
  try {
    names = readdirSync(SESSIONS);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = join(SESSIONS, name);
    try {
      if (now - statSync(file).mtimeMs > olderThanMs) rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}
