// Every place in the database a word could be: each text, bytea, json and tsvector
// column of every table in the schema, searched as the owner, which reads them all.
//
// For sealed content: a canary sealed on a client must never appear here, in any
// table, however the service stores, indexes, delivers or logs what it was sent.

import type postgres from "postgres";

export async function sweep(owner: postgres.Sql, needle: string): Promise<string[]> {
  const columns = await owner<{ table_name: string; column_name: string; data_type: string }[]>`
    select c.table_name, c.column_name, c.data_type
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'schellingaf' and t.table_type = 'BASE TABLE'
       and c.data_type in ('text', 'bytea', 'jsonb', 'json', 'character varying', 'tsvector', 'ARRAY')
     order by c.table_name, c.column_name`;
  const found: string[] = [];
  for (const col of columns) {
    const column = `"${col.column_name.replaceAll('"', '""')}"`;
    const table = `schellingaf."${col.table_name.replaceAll('"', '""')}"`;
    const test =
      col.data_type === "bytea"
        ? `position(convert_to($1, 'UTF8') in ${column}) > 0`
        : `strpos(${column}::text, $1) > 0`;
    const [row] = await owner.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where ${test}`, [needle]);
    if ((row?.n ?? 0) > 0) found.push(`${col.table_name}.${col.column_name}`);
  }
  return found;
}
