// scripts/peek.ts, run as the operator runs it, changing only the database it reads.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const PEEK = fileURLToPath(new URL("../../scripts/peek.ts", import.meta.url));

export async function peek(database: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [PEEK, ...args], {
    env: { ...process.env, DB_NAME: database, DB_PORT: String(process.env.TEST_DB_PORT ?? 5439) },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
