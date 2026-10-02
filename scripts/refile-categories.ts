// Rewrite which categories every SPACE is listed under, from its own categories and
// the register this code carries.
//
//   node scripts/refile-categories.ts
//
// Run once after a release of the register that moves an entry under a new parent:
// the rows written before it still list SPACES under the old parents, and a filter or
// a count by those parents would still find them. A release that only adds, renames
// or retires entries needs nothing. Safe to run at any time and as often as you like;
// it changes no SPACE and writes no event. See src/db/refile.ts.

import { refileAll } from "../src/db/refile.ts";
import { REGISTER } from "../src/surface/categories.ts";
import { ownerSql } from "./lib/db.ts";

const sql = await ownerSql(process.env.DB_NAME ?? "schellingaf");
const done = await refileAll(sql);
process.stdout.write(`register ${REGISTER.version}: ${done.spaces} SPACES listed under ${done.rows} categories in all\n`);
await sql.end();
