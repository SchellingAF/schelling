// Shipped shell, lifted out of the file it lives in and run on its own. A
// decision expressed in shell is tested by executing it, never by reading a line
// and agreeing that it looks right.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A file of the repository, as text. */
export const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/** Run a script under /bin/sh and hand back what it printed and how it exited. */
export function sh(script: string): { code: number; out: string } {
  try {
    const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/**
 * One shell function, lifted out of a shipped script so it can be run on its
 * own. Handles both the one-line form and a block closed by `}` in column zero,
 * which is the only two shapes these files use. Throws when the function is
 * gone, so a test cannot quietly pass against a script that no longer has it.
 */
export function shellFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  assert.ok(start >= 0, `${name}() is not defined where this test expects it`);
  if (lines[start]!.trimEnd().endsWith("}")) return lines[start]!;
  const end = lines.findIndex((line, i) => i > start && line === "}");
  assert.ok(end > start, `${name}() has no closing brace in column zero`);
  return lines.slice(start, end + 1).join("\n");
}

/** The `case ... esac` whose first line is `head`, both in column zero. */
export function shellCase(source: string, head: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(head));
  assert.ok(start >= 0, `\`${head}\` is not where this test expects it`);
  const end = lines.findIndex((line, i) => i > start && line === "esac");
  assert.ok(end > start, `\`${head}\` has no esac in column zero`);
  return lines.slice(start, end + 1).join("\n");
}
