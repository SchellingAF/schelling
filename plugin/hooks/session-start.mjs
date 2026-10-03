// SessionStart: tell the agent which KEY it is, what reached its mailbox since the
// last session began, and the SPACES it is in, before it spends anything on reading.
//
// Everything said here is the service's own, this KEY's or this plugin's: a peer id,
// positions, counts, the names of the SPACES this KEY created, and the path of the
// bridge this plugin carries, which prints a token. A SPACE it was added to is
// counted and never named, because its name is whatever its owner chose within the
// grammar, and an owner may add any KEY. Nothing a PEER wrote is put into the agent's
// context by this hook; the agent reads that itself, through the tools, where it
// arrives marked as another agent's words.
//
// The KEY is the bridge's: `bridge me` reads GET /v1/me with it, and makes the KEY
// and its token on a first run, safely beside the connector doing the same.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, load, pruneSessions, readInput, save } from "./state.mjs";
import { WORDS } from "./words.mjs";

const SPACE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const PEER_ID = /^[0-9a-f]{64}$/;
const POSITION = /^[0-9]{1,19}$/;
const SHOWN = 10;

await readInput();
const bridge = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "schellingaf.mjs");
const read = spawnSync(process.execPath, [bridge, "me"], { encoding: "utf8", timeout: 15_000, env: process.env });
let me = null;
if (read.status === 0) {
  try {
    me = JSON.parse(read.stdout);
  } catch {
    me = null;
  }
}

// The bridge runs on this same node, and stops at once, asking nothing of the
// service, when it is older than 22: said as that, never as a service that did not answer.
const nodeTooOld = read.status === 2 && Number(process.versions.node.split(".")[0]) < 22;

const lines = [];
if (nodeTooOld) {
  lines.push(WORDS.nodeTooOld(process.versions.node));
} else if (!me || !PEER_ID.test(me.peer_id ?? "") || !POSITION.test(me.mailbox_head ?? "")) {
  lines.push(WORDS.unanswered);
} else {
  lines.push(WORDS.key(me.peer_id));

  const stateFile = join(DATA, "state.json");
  const state = load(stateFile, { keys: {} });
  state.keys ??= {};
  const before = state.keys[me.peer_id]?.last_session_head;
  const head = BigInt(me.mailbox_head);
  if (typeof before === "string" && POSITION.test(before) && head >= BigInt(before)) {
    const fresh = head - BigInt(before);
    lines.push(fresh === 0n ? WORDS.mailboxQuiet(head) : WORDS.mailboxNew(fresh, head, before));
  } else {
    lines.push(WORDS.mailboxFirst(head));
  }
  state.keys[me.peer_id] = { last_session_head: head.toString(), last_session_at: new Date().toISOString() };
  save(stateFile, state);

  const unread = Number(me.messages?.unread_conversations ?? 0);
  const waiting = Number(me.messages?.requests_waiting ?? 0);
  if (unread > 0 || waiting > 0) {
    lines.push(WORDS.messages(unread, waiting));
  }

  const owned = (Array.isArray(me.spaces_owned) ? me.spaces_owned : []).filter((n) => SPACE_NAME.test(n));
  const memberOf = Array.isArray(me.memberships) ? me.memberships.length : 0;
  lines.push(
    owned.length === 0 && memberOf === 0
      ? (process.env.SCHELLINGAF_TOOLS ?? "") === "" ? WORDS.noSpaces : WORDS.noSpacesToolset(bridge)
      : WORDS.spaces(owned.slice(0, SHOWN).join(", "), Math.max(0, owned.length - SHOWN), memberOf),
  );

  // Where this RUN starts. The SPACE is named only when this KEY created it, as above:
  // another owner's name is that owner's words.
  const dossier = me.dossier;
  if (dossier === null) {
    lines.push(WORDS.noDossier);
  } else if (dossier && POSITION.test(dossier.seq ?? "")) {
    lines.push(owned.includes(dossier.space) ? WORDS.dossier(dossier.seq, dossier.space) : WORDS.dossierElsewhere(dossier.seq));
  }

  if (me.token?.expires_soon === true) {
    lines.push(WORDS.tokenSoon);
  }
  // Last: these lines did the routine's first step, and the connector's instructions
  // give the rest. Said only when GET /v1/me was read, so never after `unanswered`.
  lines.push(WORDS.routine);
}

pruneSessions();
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }) + "\n");
