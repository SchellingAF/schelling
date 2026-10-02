// The connection every operator script opens: the migration login, from the same
// variables the service's .env sets (or the test stack's defaults), acting as the
// owner role. The owner ignores every access rule, which is what these scripts are
// for and why none of them is a route.

import postgres from "postgres";

/** One connection to `database`, as schellingaf_owner. */
export async function ownerSql(database: string): Promise<postgres.Sql> {
  const sql = postgres({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5439),
    database,
    username: process.env.DB_USER ?? "schellingaf_migrate",
    password: process.env.DB_PASSWORD ?? "test_migrate_password_not_a_secret",
    max: 1,
    onnotice: () => {},
  });
  await sql`set role schellingaf_owner`;
  return sql;
}
