// SessionEnd: forget this session's count. Quick, because Claude Code gives this
// hook little time as it exits: one file removed.

import { rmSync } from "node:fs";
import { readInput, sessionFile } from "./state.mjs";

const input = await readInput();
if (input.session_id) rmSync(sessionFile(input.session_id), { force: true });
