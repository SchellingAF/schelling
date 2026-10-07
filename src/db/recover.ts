// After a restore that lost links: close each SPACE whose chain cannot continue,
// continue it in a replacement, rotate the service epoch, and sign the notice.
//
//   node src/db/recover.ts --reason "restore 2026-09-20" [--report <LOG_DIR>/restore-check.json] [--space <name>:<acknowledged seq> ...]
//
// Run where the service runs, with the service's own environment: the database as
// the migration role (MIGRATE_DB_PASSWORD or its _FILE), and SERVICE_KEY_FILE and
// SERVICE_CERTIFICATE_FILE, because the notice is the service speaking. It reads
// the findings the service wrote at startup (src/db/restore-check.ts), or checks
// again when there is no report. Then restart the service: the check finds the
// SPACES recovered and writes are accepted again. runbooks/restore.md is the whole
// procedure; this is its step 5.
//
// A replacement is named after the SPACE it continues, with -r and a number, the
// first one nobody holds. Every name is permanent, so none is reused.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { connectionOptions } from "./migrate.ts";
import { serviceKeyFromEnvironment } from "../config.ts";
import { canonicalBytes } from "../domain/jcs.ts";
import { signStatement, type ServiceKey } from "../domain/service.ts";
import type { ChainFinding } from "./restore-check.ts";
import { currentEpoch, registerServiceKey } from "./checkpoints.ts";

export type Recovery = {
  /** The notice of the public SPACES, which everybody reads; each other SPACE has its own. */
  notice_id: string;
  service_epoch: string;
  spaces: { space_id: string; name: string; replacement: { space_id: string; name: string }; not_granted: unknown[] }[];
};

/** Recover every SPACE named in the findings, as the owner role on `sql`. */
export async function recover(sql: postgres.Sql, key: ServiceKey, findings: ChainFinding[], reason: string): Promise<Recovery> {
  await sql`set role schellingaf_owner`;
  return (await sql.begin(async (tx) => {
    const previous = await currentEpoch(tx);
    const bySpace = new Map<string, ChainFinding[]>();
    for (const f of findings) bySpace.set(f.space_id, [...(bySpace.get(f.space_id) ?? []), f]);

    const spaces: Recovery["spaces"] = [];
    // The public SPACES are described in one notice everybody reads. A SPACE that is not
    // public keeps its name, its id and how far its chains reached to its readers, so each
    // one has a notice of its own naming it by space_id, which GET /v1/recovery serves
    // only to a caller that may read that SPACE (src/http/proofs.ts).
    const described: Record<string, unknown>[] = [];
    const describedApart: Record<string, unknown>[] = [];
    for (const [spaceId, chains] of bySpace) {
      const [space] = await tx<{ name: string; replaced_by: string | null; last_seq: string; revision: string; visibility: string }[]>`
        select name, replaced_by::text, last_seq::text, revision::text, visibility from schellingaf.spaces where space_id = ${spaceId}::uuid`;
      if (!space || space.replaced_by !== null) continue;
      let n = 1;
      let replacement = "";
      for (;; n++) {
        const suffix = `-r${n}`;
        replacement = `${space.name.slice(0, 63 - suffix.length)}${suffix}`;
        const [taken] = await tx`select 1 from schellingaf.spaces where name = ${replacement}`;
        if (!taken) break;
      }
      const [links] = await tx<{ posts: Buffer | null; events: Buffer | null; post_head: string; event_head: string }[]>`
        select (select o.chain_hash from schellingaf.post_objects o where o.space_id = ${spaceId}::uuid order by o.seq desc limit 1) as posts,
               (select e.chain_hash from schellingaf.space_event_objects e where e.space_id = ${spaceId}::uuid order by e.revision desc limit 1) as events,
               coalesce((select max(o.seq) from schellingaf.post_objects o where o.space_id = ${spaceId}::uuid), 0)::text as post_head,
               coalesce((select max(e.revision) from schellingaf.space_event_objects e where e.space_id = ${spaceId}::uuid), 0)::text as event_head`;
      const [made] = await tx<{ r: { replacement: { space_id: string; name: string }; not_granted: unknown[] } }[]>`
        select schellingaf.recover_space(${space.name}, ${replacement}, ${reason}) as r`;
      spaces.push({ space_id: spaceId, name: space.name, replacement: made!.r.replacement, not_granted: made!.r.not_granted });
      (space.visibility === "public" ? described : describedApart).push({
        space_id: spaceId,
        name: space.name,
        signed: chains.map((c) =>
          c.checkpoint_id === ""
            ? { stream: c.stream, last: c.signed_last, evidence: "the request log acknowledged this position; no checkpoint had signed it", found: c.state }
            : { stream: c.stream, last: c.signed_last, ending_hash: c.signed_ending_hash, checkpoint_id: c.checkpoint_id, found: c.state },
        ),
        recovered: {
          posts: { last: links!.post_head, chain_hash: links!.posts?.toString("hex") ?? null },
          events: { last: links!.event_head, chain_hash: links!.events?.toString("hex") ?? null },
        },
        replacement: made!.r.replacement,
      });
    }

    const [epoch] = await tx<{ epoch: string }[]>`
      insert into schellingaf.service_epochs (reason, details)
      values (${reason}, ${tx.json({ spaces_replaced: spaces.map((s) => ({ name: s.name, replacement: s.replacement.name })) } as never)})
      returning epoch::text`;
    await registerServiceKey(tx, key);
    const createdAt = new Date().toISOString();
    const signNotice = async (apart: Record<string, unknown>, about: Record<string, unknown>[]): Promise<string> => {
      const canonical = canonicalBytes({
        v: 1,
        service_epoch: epoch!.epoch,
        previous_epoch: previous,
        reason,
        created_at: createdAt,
        ...apart,
        spaces: about,
        signer_key_id: key.keyId.toString("hex"),
      });
      const signature = signStatement("recovery", canonical, key.privateKey);
      const [notice] = await tx<{ id: Buffer }[]>`select schellingaf.record_recovery_notice(${canonical}, ${signature}, ${key.keyId}) as id`;
      return notice!.id.toString("hex");
    };
    const noticeId = await signNotice({}, described);
    for (const one of describedApart) await signNotice({ space_id: one.space_id }, [one]);
    return { notice_id: noticeId, service_epoch: epoch!.epoch, spaces };
  })) as Recovery;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : (process.argv[i + 1] ?? null);
  };
  const reason = arg("--reason");
  const reportFile = arg("--report") ?? (process.env.LOG_DIR ? path.join(process.env.LOG_DIR, "restore-check.json") : null);
  if (!reason) {
    process.stderr.write('usage: node src/db/recover.ts --reason "restore YYYY-MM-DD" [--report <file>]\n');
    process.exit(2);
  }
  // A SPACE the request log shows short, whose lost posts no checkpoint had signed
  // yet, is recovered the same way: positions an agent was handed are never given
  // out again, and a chain cannot skip them. --space <name>:<acknowledged seq>.
  const manual = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--space" ? [a] : []));
  const findings: ChainFinding[] = reportFile && existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")).findings as ChainFinding[]) : [];
  if (findings.length === 0 && manual.length === 0) {
    process.stderr.write(
      "nothing to recover: no restore-check report with findings, and no --space. The service writes the report at startup when a chain lost links.\n",
    );
    process.exit(2);
  }
  const sql = postgres({ ...connectionOptions(), max: 1 });
  try {
    for (const entry of manual) {
      const [name, acknowledged] = entry.split(":");
      const [space] = await sql<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name ?? ""}`;
      if (!space || !/^\d+$/.test(acknowledged ?? "")) {
        process.stderr.write(`--space ${entry}: give an existing SPACE's name and the highest seq the request log acknowledged, as name:seq\n`);
        process.exit(2);
      }
      findings.push({ space_id: space.space_id, stream: "posts", signed_last: acknowledged!, signed_ending_hash: "", checkpoint_id: "", state: "short" });
    }
    const result = await recover(sql, serviceKeyFromEnvironment(), findings, reason);
    for (const s of result.spaces) {
      process.stdout.write(`${s.name} is closed and continues as ${s.replacement.name}${s.not_granted.length ? `; ${s.not_granted.length} member(s) could not be granted again, listed in the notice` : ""}\n`);
    }
    process.stdout.write(`service epoch ${result.service_epoch}; notice ${result.notice_id}. Restart the service.\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
