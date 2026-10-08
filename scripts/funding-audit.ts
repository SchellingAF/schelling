// Every deposit credited or held, checked again: the body each of its callbacks carried,
// kept byte for byte, against the signature kept beside it, under CryptAPI's committed key
// (src/funding/cryptapi-pubkey.ts). Then what the body says against the row it wrote: its
// uuid, address, wallet, transaction and coin, and, credited by a callback or held, the
// micro-dollars creditOf() makes of it. A row that fails was not written by a signed
// callback, or not as the callback said.
//
//   node scripts/funding-audit.ts               against the committed key
//   node scripts/funding-audit.ts --key <file>  against another PEM public key (a test double's)
//
// Reads as the owner role (scripts/lib/db.ts), DB_NAME or schellingaf. Prints the count
// checked and the deposit ids that fail, each with why, and exits 1 when any does. Writes
// nothing.

import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { ownerSql } from "./lib/db.ts";
import { creditOf, parseCallback, signedBy, type Callback } from "../src/funding/callback.ts";
import { CRYPTAPI_PUBKEY_PEM } from "../src/funding/cryptapi-pubkey.ts";

export type Audit = { checked: number; failed: string[]; why: Record<string, string> };

type Row = {
  deposit_id: string; state: string; released: boolean; txid_in: string; coin: string; usd_micro: string | null;
  pending_uuid: string | null; confirmed_uuid: string | null;
  raw_pending: Buffer | null; sig_pending: string | null; raw_confirmed: Buffer | null; sig_confirmed: string | null;
  family: string; address_in: string; address_out: string;
};

/** Why a kept body does not match its row, or null when it does. */
function mismatch(row: Row, raw: Buffer, sig: string | null, pem: string, confirmed: boolean): string | null {
  if (!signedBy(raw, sig ?? undefined, pem)) return "signature";
  let cb: Callback;
  try {
    cb = parseCallback(raw);
  } catch {
    return "body";
  }
  const same = (a: string | null, b: string) => a !== null && (row.family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (cb.pending === confirmed) return "pending";
  if (cb.uuid !== (confirmed ? row.confirmed_uuid : row.pending_uuid)) return "uuid";
  if (!same(cb.addressIn, row.address_in)) return "address_in";
  if (!same(cb.addressOut, row.address_out)) return "address_out";
  if (cb.txidIn !== row.txid_in) return "txid_in";
  if (cb.coin !== row.coin) return "coin";
  // A release credits what the operator decided; anything else, what the body asks.
  if (confirmed && !row.released) {
    const usd = creditOf(cb).usdMicro;
    if ((usd === null ? null : usd.toString()) !== row.usd_micro) return "usd_micro";
  }
  return null;
}

/** Each confirmed or held deposit's kept callbacks against `pem` and against its row: every body kept must verify and match, and a confirmed callback's must be there. */
export async function auditDeposits(sql: postgres.Sql, pem: string): Promise<Audit> {
  const rows = await sql<Row[]>`
    select d.deposit_id::text, d.state, d.released_at is not null as released, d.txid_in, d.coin, d.usd_micro::text,
           d.pending_uuid::text, d.confirmed_uuid::text, d.raw_pending, d.sig_pending, d.raw_confirmed, d.sig_confirmed,
           a.family, a.address_in, a.address_out
      from schellingaf.funding_deposits d join schellingaf.funding_addresses a on a.address_id = d.address_id
     where d.state in ('confirmed', 'held')
     order by d.seen_at, d.deposit_id`;
  const failed: string[] = [];
  const why: Record<string, string> = {};
  for (const r of rows) {
    const wrong =
      r.raw_confirmed === null
        ? "no confirmed body"
        : (mismatch(r, r.raw_confirmed, r.sig_confirmed, pem, true) ?? (r.raw_pending === null ? null : mismatch(r, r.raw_pending, r.sig_pending, pem, false)));
    if (wrong !== null) {
      failed.push(r.deposit_id);
      why[r.deposit_id] = wrong;
    }
  }
  return { checked: rows.length, failed, why };
}

if (import.meta.main) {
  const at = process.argv.indexOf("--key");
  const pem = at > 0 ? readFileSync(process.argv[at + 1]!, "utf8") : CRYPTAPI_PUBKEY_PEM;
  const sql = await ownerSql(process.env.DB_NAME ?? "schellingaf");
  try {
    const { checked, failed, why } = await auditDeposits(sql, pem);
    process.stdout.write(`${checked} deposit(s) checked, ${failed.length} failed\n`);
    for (const id of failed) process.stdout.write(`  ${id} ${why[id]}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
