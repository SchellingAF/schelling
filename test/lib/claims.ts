// Claims as a test sets a scene a route cannot (migrations/0141_task_claims.sql): a claim
// is a row of task_claims, and the task's row mirrors them through sync_task_claims(). A
// scene that moved claimed_until on the task row alone would leave the two apart, and
// task_mirror_faults() fails the case. These change the claim rows, then sync the row.
//
//   import { claimUntil, claimsFromRows } from "./lib/claims.ts";
//   await claimUntil(name, 1, "-1 minute");          // every claim of task 1 passed a minute ago
//   await claimUntil(name, 1, "1 minute", b.peerId); // b's claim runs one minute more
//
// They run as the owner, since sync_task_claims() is granted to nobody.

import { fixture } from "./service.ts";

/**
 * Sets the claims of task `number` in `space` (every task when null) to pass at now() plus
 * `interval`, which may be negative: every claim, or only `who`'s, given as a hex peer id.
 */
export async function claimUntil(space: string, number: number | null, interval: string, who?: string): Promise<void> {
  await fixture.owner.begin(async (tx) => {
    const tasks = await tx<{ task_id: string }[]>`
      select t.task_id::text from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${space} and (${number}::int is null or t.number = ${number}::int)
       order by t.task_id for update of t`;
    for (const { task_id } of tasks) {
      await tx`
        update schellingaf.task_claims c set claimed_until = now() + ${interval}::interval
         where c.task_id = ${task_id}::uuid and (${who ?? null}::text is null or c.peer_id = decode(${who ?? null}::text, 'hex'))`;
      await tx`select schellingaf.sync_task_claims(${task_id}::uuid)`;
    }
  });
}

/**
 * Gives `who` a claim of task `number`, taken now at the task's revision and passing an hour
 * from now unless `interval` says otherwise, counted as a take, as next would.
 */
export async function claimFor(space: string, number: number, who: string, interval = "1 hour"): Promise<void> {
  await fixture.owner.begin(async (tx) => {
    const [t] = await tx<{ task_id: string }[]>`
      select t.task_id::text from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${space} and t.number = ${number} for update of t`;
    await tx`
      insert into schellingaf.task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
      select t.task_id, t.space_id, decode(${who}, 'hex'), now(), now() + ${interval}::interval, t.revision
        from schellingaf.tasks t where t.task_id = ${t!.task_id}::uuid`;
    await tx`update schellingaf.tasks set takes = takes + 1 where task_id = ${t!.task_id}::uuid`;
    await tx`select schellingaf.sync_task_claims(${t!.task_id}::uuid)`;
  });
}

/**
 * A scene inserted straight into tasks, with rows already claimed: each claimed task that is
 * not upkeep gets its one claim as a row, as 0141_task_claims.sql's backfill gives it.
 */
export async function claimsFromRows(space: string): Promise<void> {
  await fixture.owner`
    insert into schellingaf.task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
    select t.task_id, t.space_id, t.claimed_by, coalesce(t.claimed_at, t.created_at), t.claimed_until,
           coalesce(t.claim_revision, t.revision)
      from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${space} and t.upkeep is null and t.state = 'claimed'
       and not exists (select 1 from schellingaf.task_claims c where c.task_id = t.task_id)`;
  await fixture.owner`
    update schellingaf.tasks t set claimed_at = coalesce(t.claimed_at, t.created_at), claim_revision = coalesce(t.claim_revision, t.revision)
      from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${space} and t.upkeep is null and t.state = 'claimed'`;
}

/** The claim rows of task `number`: who, until when, taken when and at which revision, oldest first. */
export async function claimRows(space: string, number: number) {
  return fixture.owner<{ by: string; until: Date; at: Date; revision: number }[]>`
    select encode(c.peer_id, 'hex') as by, c.claimed_until as until, c.claimed_at as at, c.claim_revision as revision
      from schellingaf.task_claims c join schellingaf.tasks t on t.task_id = c.task_id
      join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${space} and t.number = ${number}
     order by c.claimed_at, c.peer_id`;
}
