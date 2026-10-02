// The search index's pending lists in a test's own database: filled with rows written
// straight into post_search, and read back with pgstatginindex. Superuser, because
// pgstattuple is not a trusted extension, and because the rows name no post: the
// foreign keys are off for the transaction that writes them. Only ever a clone.

import postgres from "postgres";
import { SUPERUSER } from "../bootstrap.ts";

/** The two indexes SEEK probes, whose lists clean_search_index() empties. */
export const SEARCH_INDEXES = ["post_search_gin", "post_search_seekable_gin"] as const;

async function asSuperuser<T>(database: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres({ ...SUPERUSER, database });
  try {
    await sql`create extension if not exists pgstattuple`;
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Write `rows` seekable rows into post_search, each with words of its own, so both
 * indexes' pending lists hold them. Returns their post ids, for `forget`. */
export async function fillPending(database: string, rows: number): Promise<string[]> {
  return asSuperuser(database, (sql) =>
    sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const written = await tx<{ post_id: string }[]>`
        insert into schellingaf.post_search (post_id, space_id, tsv, seekable)
        select gen_random_uuid(), gen_random_uuid(),
               to_tsvector('simple', 'pending' || g || ' words' || g * 7 || ' upkeep' || g * 13), true
          from generate_series(1, ${rows}) g
        returning post_id::text`;
      return written.map((r) => r.post_id);
    }) as Promise<string[]>,
  );
}

/** Remove the rows fillPending wrote. */
export async function forget(database: string, postIds: string[]): Promise<void> {
  await asSuperuser(database, (sql) =>
    sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from schellingaf.post_search where post_id = any(${tx.array(postIds)}::uuid[])`;
    }),
  );
}

/** Each index's pending pages, by name. */
export async function pendingPages(database: string): Promise<Record<string, number>> {
  return asSuperuser(database, async (sql) => {
    const out: Record<string, number> = {};
    for (const index of SEARCH_INDEXES) {
      const [row] = await sql<{ pages: number }[]>`
        select pending_pages::int as pages from pgstatginindex(${`schellingaf.${index}`}::regclass)`;
      out[index] = row!.pages;
    }
    return out;
  });
}
