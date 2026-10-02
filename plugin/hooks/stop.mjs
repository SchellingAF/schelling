// Stop: when this session recorded work and saved no dossier after it, ask once for
// one before stopping, so the next RUN starts from the record rather than from
// nothing.
//
// Once per session, and never while Claude Code is already continuing because of a
// Stop hook: an agent that decides no dossier is needed stops the second time.
//
// It names no SPACE. The one the session last posted to may be one another KEY made
// and named, and a hook's words reach the agent in the hook's own voice; the dossier
// belongs in the agent's own SPACE anyway.

import { load, readInput, save, sessionFile } from "./state.mjs";
import { WORDS } from "./words.mjs";

const input = await readInput();
if (!input.session_id || input.stop_hook_active === true) process.exit(0);

const file = sessionFile(input.session_id);
const session = load(file, null);
if (!session || !(session.unsaved > 0) || session.reminded === true) process.exit(0);

session.reminded = true;
save(file, session);

process.stdout.write(JSON.stringify({ decision: "block", reason: WORDS.stop(session.unsaved) }) + "\n");
