// A recovery notice, as the api role reads it.
//
// GET /v1/recovery serves a notice only to a caller who may read every SPACE it names
// (src/http/proofs.ts): a SPACE that is not public keeps its name, its id and how far its
// chains reached to its readers. That rule was the route's statement alone, because the
// table had no policy. recovery_notices is now under row-level security with the route's
// own rule, so any read of it by the api role answers what the route answers.
//
// Written by the security review of 7 October 2026.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";

let fixture: Fixture;

const opened = setUp(async () => {
  fixture = await cloneDatabase("sec_db_access_recovery");
});

after(async () => {
  await opened;
  await fixture.end();
});

describe("a recovery notice reaches only a caller who may read every SPACE it names", () => {
  test("as the api role, with each caller bound as readTx binds it", async () => {
    await opened;
    // One KEY owns two private SPACES, a public one and a public one the operator
    // withheld; a second is a member of the first private SPACE only; a third is in none.
    const ownerKey = publicKey("sec-recovery-owner");
    const memberKey = publicKey("sec-recovery-member");
    const strangerKey = publicKey("sec-recovery-stranger");
    for (const key of [ownerKey, memberKey, strangerKey]) await fixture.owner`select schellingaf.register_peer(${key})`;
    const owner = peerIdOf(ownerKey);
    const member = peerIdOf(memberKey);
    const stranger = peerIdOf(strangerKey);
    const ids: Record<string, string> = {};
    for (const [name, visibility] of [["kept", "private"], ["other", "private"], ["open", "public"], ["dark", "public"]] as const) {
      const [made] = await fixture.owner<{ r: { space_id: string } }[]>`
        select schellingaf.create_space(p_owner => decode(${owner}, 'hex'), p_name => ${`sec-recovery-${name}`}, p_title => 'Drill',
                                        p_visibility => ${visibility}) as r`;
      ids[name] = made!.r.space_id;
    }
    await fixture.owner`select schellingaf.grant_membership('sec-recovery-kept', decode(${owner}, 'hex'), decode(${member}, 'hex'), 'writer', null)`;
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${ids.dark!}::uuid, 'abuse', 'test')`;

    // Notices as src/db/recover.ts signs them, and as it signed them before: one of the
    // public SPACES; one apart for each other SPACE, naming it by space_id; an older one
    // naming a public and a private SPACE together; and a few edges.
    const [signer] = await fixture.owner<{ id: Buffer }[]>`
      select schellingaf.register_service_key(${Buffer.alloc(32, 3)}, ${Buffer.alloc(32, 4)},
        ${Buffer.from("a certificate")}, ${Buffer.alloc(64, 5)}, true) as id`;
    const [epoch] = await fixture.owner<{ epoch: string }[]>`select epoch::text from schellingaf.service_epochs limit 1`;
    const about = (name: string) => ({ space_id: ids[name] ?? name, name: `sec-recovery-${name}` });
    const notices: Record<string, Record<string, unknown>> = {
      public: { spaces: [about("open"), about("dark")] },
      "apart kept": { space_id: ids.kept, spaces: [about("kept")] },
      "apart other": { space_id: ids.other, spaces: [about("other")] },
      "apart dark": { space_id: ids.dark, spaces: [about("dark")] },
      "older, mixed": { spaces: [about("open"), about("kept")] },
      "naming none": { spaces: [] },
      "with no list": {},
      "naming a SPACE that is gone": { spaces: [{ space_id: randomUUID(), name: "gone" }] },
      "apart, gone": { space_id: randomUUID(), spaces: [] },
    };
    for (const [reason, body] of Object.entries(notices)) {
      const canonical = Buffer.from(JSON.stringify({ v: 1, service_epoch: epoch!.epoch, reason, ...body }), "utf8");
      await fixture.owner`select schellingaf.record_recovery_notice(${canonical}, ${Buffer.alloc(64, 6)}, ${signer!.id})`;
    }

    const read = async (caller: string | null): Promise<string[]> => {
      const rows = await fixture.asCaller(caller, (sql) => sql<{ reason: string }[]>`
        select convert_from(n.canonical, 'UTF8')::jsonb ->> 'reason' as reason from schellingaf.recovery_notices n`);
      return rows.map((r) => r.reason).sort();
    };
    // Everybody reads the notices that name no SPACE, and the public SPACES' notice, a
    // withheld public SPACE in it too: withholding hides its posts, not what the service
    // signed about its chain. A notice apart reaches whoever may read its SPACE, which a
    // withheld one nobody may; an older one, a caller who may read every SPACE it names.
    const everybody = ["naming none", "public", "with no list"];
    assert.deepEqual(await read(null), everybody.sort(), "no caller");
    assert.deepEqual(await read(stranger), everybody.sort(), "a KEY in no SPACE");
    assert.deepEqual(await read(member), [...everybody, "apart kept", "older, mixed"].sort(), "a member of one private SPACE");
    assert.deepEqual(await read(owner), [...everybody, "apart kept", "apart other", "older, mixed"].sort(), "the owner of every SPACE");
    // What the table holds, as its owner reads it: every notice, the hidden ones too.
    const [all] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.recovery_notices`;
    assert.equal(all!.n, Object.keys(notices).length);
  });
});
