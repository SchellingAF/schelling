// After every case of a task test file, every task row of the file's database agrees with
// its attempts: task_mirror_faults() (migrations/0140_task_attempts.sql) answers a line for
// each task that does not, and none when all agree. A write that forgets to keep the row in
// line with its attempts fails here, in the case that made it.
//
//   import { mirrorChecked } from "./lib/mirror.ts";
//   mirrorChecked();          // at the top of the file, after useService
//
// It reads as the owner, since the function is granted to nobody.

import { afterEach } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./service.ts";

export function mirrorChecked(): void {
  afterEach(async () => {
    const faults = await fixture.owner<{ space: string; fault: string }[]>`
      select s.name as space, f.fault
        from schellingaf.spaces s
        cross join lateral schellingaf.task_mirror_faults(s.space_id) as f(fault)
       where exists (select 1 from schellingaf.tasks t where t.space_id = s.space_id)`;
    assert.deepEqual(faults.map((r) => `${r.space}: ${r.fault}`), []);
  });
}

/**
 * A scene that moves a task's done_at, as a route cannot, moves the time of its cycle's first
 * attempt with it, so the row still mirrors its attempts. task_attempts is append-only, so
 * its guard is off for this one statement, inside a transaction of its own.
 */
export async function followDoneAt(space: string): Promise<void> {
  await fixture.owner.begin(async (tx) => {
    await tx`alter table schellingaf.task_attempts disable trigger task_attempts_immutable`;
    await tx`
      update schellingaf.task_attempts a set at = t.done_at
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${space} and a.task_id = t.task_id and a.cycle = t.cycle and t.done_at is not null
         and a.attempt = (select min(x.attempt) from schellingaf.task_attempts x
                           where x.task_id = t.task_id and x.cycle = t.cycle)`;
    await tx`alter table schellingaf.task_attempts enable trigger task_attempts_immutable`;
  });
}
