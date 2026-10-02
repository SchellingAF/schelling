// Rewrite space_categories from the SPACES' own categories and the register.
//
// The functions that create, change and continue a SPACE keep its rows as they go;
// this is for everything else. A release of the register that moves an entry under
// a new parent changes which categories are above it, and rows written before the
// release still name the old ones: scripts/refile-categories.ts runs this once after
// such a release. The seed and the plan tests, which put SPACES in with SQL of their
// own, call it too.
//
// Run as the owning role, in one transaction, so no reader ever sees a SPACE listed
// under nothing. A SPACE filed under an id the register does not have gets no row
// for it; the API never files one.

import type postgres from "postgres";
import { rollUp } from "../surface/categories.ts";

export async function refileAll(sql: postgres.Sql): Promise<{ spaces: number; rows: number }> {
  const { ids, into } = rollUp();
  return (await sql.begin(async (tx) => {
    // A SPACE changed while this runs waits for it rather than refiling rows this is
    // halfway through replacing: its own DELETE would miss the rows inserted here, and
    // its INSERT then meet them.
    await tx`lock table schellingaf.space_categories in share row exclusive mode`;
    await tx`delete from schellingaf.space_categories`;
    const [row] = await tx<{ spaces: number; rows: number }[]>`
      with written as (
        insert into schellingaf.space_categories (category, name, space_id, main)
        select r.into_id, s.name, s.space_id, bool_or(f.ord = 1)
          from schellingaf.spaces s
          cross join lateral unnest(s.categories) with ordinality as f(id, ord)
          join unnest(${ids}::text[], ${into}::text[]) as r(id, into_id) on r.id = f.id
         group by r.into_id, s.name, s.space_id
        returning space_id)
      select count(distinct space_id)::int as spaces, count(*)::int as rows from written`;
    return row!;
  })) as { spaces: number; rows: number };
}
