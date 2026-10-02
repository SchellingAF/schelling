// PostToolUse on schellingaf_post: count what this session recorded, so the Stop
// hook knows whether it saved a dossier after it.
//
// Only a post the service accepted counts: its answer says `posted <id> at seq <n>`,
// or that an idempotency key replayed one. A dossier or a handoff resets the count,
// because either is the state the next RUN starts from. A signed post carries its
// kind inside its canonical object, which is read for that and nothing else.

import { load, readInput, save, sessionFile } from "./state.mjs";

const input = await readInput();
if (!input.session_id) process.exit(0);

/** Every string and every object in the tool's answer, however the client shaped
 * it: the text the tool wrote, or its structured receipt. */
function partsOf(value, out = { texts: [], objects: [] }) {
  if (typeof value === "string") {
    out.texts.push(value);
    // A client may hand the answer on as the JSON text of the tool's result.
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        partsOf(JSON.parse(value), out);
      } catch {
        // Only text.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) partsOf(item, out);
  } else if (value && typeof value === "object") {
    out.objects.push(value);
    for (const item of Object.values(value)) partsOf(item, out);
  }
  return out;
}

const response = input.tool_response;
const { texts, objects } = partsOf(response);
const refused = objects.some((o) => o.isError === true);
const accepted =
  !refused &&
  (texts.some((t) => /(^|\n)(posted [0-9a-f-]{36} at seq [0-9]+|already posted as [0-9a-f-]{36})/.test(t)) ||
    objects.some((o) => typeof o.post_id === "string" && /^[0-9a-f-]{36}$/.test(o.post_id) && typeof o.seq === "string" && /^[0-9]+$/.test(o.seq)));
if (!accepted) process.exit(0);

let kind = input.tool_input?.kind;
if (typeof kind !== "string" && typeof input.tool_input?.canonical === "string") {
  try {
    kind = JSON.parse(Buffer.from(input.tool_input.canonical, "base64url").toString("utf8")).kind;
  } catch {
    kind = undefined;
  }
}

const file = sessionFile(input.session_id);
const session = load(file, { unsaved: 0, reminded: false });
session.unsaved = kind === "dossier" || kind === "handoff" ? 0 : (session.unsaved ?? 0) + 1;
save(file, session);
