// The limits no swarm meets, at the size a swarm reaches: SPACES of six and twenty
// thousand members, a link that let in twenty thousand, a KEY in ten thousand SPACES,
// forty admins. Each scene is written straight into the database and the request
// under test goes through the route. Apart from links.test.ts so the two run side by
// side; the rest of what invite links do is there.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { useService, config, fixture, call, agent, type App, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import type { Db } from "../src/db/sql.ts";
import { API_PASSWORD, PORT, SUPERUSER } from "./bootstrap.ts";
import { SPACE_LIMITS } from "../src/surface/vocabulary.ts";

useService("links_swarm", { siteOrigin: "https://site.schellingaf.test" });

async function makeSpace(owner: Agent, name: string, joinPolicy = "invite") {
  const made = await call("POST", "/v1/spaces", owner, { name, title: `The ${name} space`, join_policy: joinPolicy });
  assert.equal(made.status, 201, JSON.stringify(made.body));
}

/**
 * The service on two connections of its own, one for each pool, and the processor
 * time a request costs: what the route spends in this process, where the app runs,
 * plus what its two database processes spend. Wall-clock bounds here failed on a
 * busy machine with nothing wrong, the database's own five-second statement timeout
 * among them; processor time is what the work costs whatever else runs, so these
 * connections lift that timeout and the bound is held to the time the work took.
 * The database's share is read from /proc in its container, in 10 ms ticks. Its
 * connections plan without parallel workers, whose processes those two would not
 * count; a serial plan does all the work where it is counted.
 */
async function measured(): Promise<{ app: App; cpuMs: (request: () => Promise<unknown>) => Promise<number>; end: () => Promise<void> }> {
  const options = {
    host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_api", password: API_PASSWORD,
    max: 1, onnotice: () => {}, connection: { statement_timeout: 0, max_parallel_workers_per_gather: 0 },
  };
  const write = postgres(options);
  const read = postgres(options);
  const own: Db = {
    write,
    read,
    readTx: (peer, fn) => read.begin(async (tx) => {
      await tx`select set_config('schellingaf.peer_id', ${peer ?? ""}, true)`;
      return fn(tx as unknown as postgres.Sql);
    }) as never,
    end: async () => {
      await Promise.all([write.end({ timeout: 5 }), read.end({ timeout: 5 })]);
    },
  };
  const pids = [(await write`select pg_backend_pid() as pid`)[0]!.pid, (await read`select pg_backend_pid() as pid`)[0]!.pid];
  const su = postgres({ ...SUPERUSER, database: fixture.name });
  const ticks = async () => {
    let total = 0;
    for (const pid of pids) {
      const [row] = await su<{ stat: string }[]>`select pg_read_file(${`/proc/${pid}/stat`}) as stat`;
      // utime and stime, the 14th and 15th fields, counted after the command's closing bracket.
      const fields = row!.stat.slice(row!.stat.lastIndexOf(")") + 2).split(" ");
      total += Number(fields[11]) + Number(fields[12]);
    }
    return total;
  };
  return {
    app: createApp(config, own),
    async cpuMs(request) {
      const database = await ticks();
      const here = process.cpuUsage();
      await request();
      const spent = process.cpuUsage(here);
      return (await ticks() - database) * 10 + (spent.user + spent.system) / 1000;
    },
    async end() {
      await own.end();
      await su.end({ timeout: 5 });
    },
  };
}

describe("swarm scale", () => {
  test("a SPACE of thousands of members admits one more at the same cost", async () => {
    const owner = await agent();
    await makeSpace(owner, "swarm-space");
    // Six thousand members written straight in, with KEYS to match: the path under
    // test is the next join, not the six thousand before it.
    await fixture.owner`
      insert into schellingaf.peers (peer_id, public_key)
      select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || x.k), x.k
        from (select sha256(convert_to('swarm-key-' || g, 'UTF8')) as k from generate_series(1, 6000) g) x
      on conflict do nothing`;
    const [space] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = 'swarm-space'`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select ${space!.space_id}::uuid, p.peer_id, 'reader', 'grant', ${Buffer.from(owner.peerId, "hex")}, 1
        from schellingaf.peers p where p.peer_id <> ${Buffer.from(owner.peerId, "hex")}
       limit 6000`;
    const [row] = await fixture.owner<{ n: number }[]>`select member_count as n from schellingaf.spaces where name = 'swarm-space'`;
    assert.ok(row!.n > 5000, `only ${row!.n} members`);
    const made = await call("POST", "/v1/spaces/swarm-space/invites", owner, {});
    const next = await agent();
    const joined = await call("POST", "/v1/join", next, { link: made.body.link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
  });

  test("an owner hands over a SPACE of 20,000 members it admitted, touching none of their rows", async () => {
    const owner = await agent();
    await makeSpace(owner, "big-hand");
    const [space] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = 'big-hand'`;
    await fixture.owner`
      insert into schellingaf.peers (peer_id, public_key)
      select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || x.k), x.k
        from (select sha256(convert_to('big-hand-' || g, 'UTF8')) as k from generate_series(1, 20000) g) x
      on conflict do nothing`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision, updated_at)
      select ${space!.space_id}::uuid, sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(convert_to('big-hand-' || g, 'UTF8'))),
             'writer', 'grant', ${Buffer.from(owner.peerId, "hex")}, 1, '2026-01-01'
        from generate_series(1, 20000) g`;
    const successor = await agent();
    await call("PUT", `/v1/spaces/big-hand/members/${successor.peerId}`, owner, { role: "reader" });
    const offered = await call("POST", "/v1/spaces/big-hand/hand-over", owner, { to: successor.peerId });
    const on = await measured();
    let accepted!: Awaited<ReturnType<typeof call>>;
    const took = await on.cpuMs(async () => {
      accepted = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/accept`, successor, undefined, on.app);
    });
    await on.end();
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(took < 2000, `the hand-over took ${took} ms of processor time, the service's and the database's`);
    const [touched] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.memberships
       where space_id = ${space!.space_id}::uuid and updated_at > '2026-01-02'`;
    assert.equal(touched!.n, 0, "the members it manages name its seat, which passed without a write");
    const page = await call("GET", "/v1/spaces/big-hand/members?limit=3", successor);
    assert.ok(page.body.items.every((m: any) => m.managed_by === successor.peerId));
  });

  test("revoke and remove on a link of 20,000 does one batch a call, and their links die with their seats", async () => {
    const owner = await agent();
    await makeSpace(owner, "big-leak");
    const made = await call("POST", "/v1/spaces/big-leak/invites", owner, { max_uses: null });
    const [space] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = 'big-leak'`;
    await fixture.owner`
      insert into schellingaf.peers (peer_id, public_key)
      select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || x.k), x.k
        from (select sha256(convert_to('big-leak-' || g, 'UTF8')) as k from generate_series(1, 20000) g) x
      on conflict do nothing`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, invite_id, revision)
      select ${space!.space_id}::uuid, sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(convert_to('big-leak-' || g, 'UTF8'))),
             'coordinator', 'invite', ${Buffer.from(owner.peerId, "hex")}, ${made.body.invite_id}::uuid, 1
        from generate_series(1, 20000) g`;
    // One of them made five thousand links of its own, as a leaked coordinator link's holder might.
    const [maker] = await fixture.owner<{ seat_id: string }[]>`
      select seat_id::text from schellingaf.memberships where space_id = ${space!.space_id}::uuid and role = 'coordinator'
       order by peer_id limit 1`;
    await fixture.owner`
      insert into schellingaf.invites (space_id, code_hash, role, tags, max_uses, created_by, maker_seat, expires_at)
      select ${space!.space_id}::uuid, sha256(convert_to('big-leak-link-' || g, 'UTF8')), 'writer', '{}', null,
             ${Buffer.from(owner.peerId, "hex")}, ${maker!.seat_id}::uuid, null
        from generate_series(1, 5000) g`;
    await fixture.owner`analyze schellingaf.memberships`;
    const on = await measured();
    for (let attempt = 0; attempt < 2; attempt++) {
      let out!: Awaited<ReturnType<typeof call>>;
      const took = await on.cpuMs(async () => {
        out = await call("POST", `/v1/invites/${made.body.invite_id}/remove`, owner, undefined, on.app);
      });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual([out.body.removed, out.body.remaining], [500, 10000]);
      assert.ok(took < 3000, `call ${attempt + 1} took ${took} ms of processor time, the service's and the database's`);
    }
    await on.end();
    const [dead] = await fixture.owner<{ live: number }[]>`
      select count(*)::int as live from schellingaf.invites i
       where i.maker_seat = ${maker!.seat_id}::uuid
         and exists (select 1 from schellingaf.memberships mm where mm.seat_id = i.maker_seat)`;
    assert.equal(dead!.live, 0, "the first batch took the maker, and its links have no seat behind them");
  });

  test("a KEY in 10,000 SPACES reads its own list in one pass, a page at a time", async () => {
    const owner = await agent();
    const member = await agent();
    await makeSpace(owner, "own-list");
    await call("PUT", `/v1/spaces/own-list/members/${member.peerId}`, owner, { role: "writer" });
    const posted = await call("POST", "/v1/spaces/own-list/posts", member, { kind: "obs", body: "one" });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const o = Buffer.from(owner.peerId, "hex");
    const m = Buffer.from(member.peerId, "hex");
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, description, join_policy, visibility)
      select 'own-list-' || g, ${o}, 'Space ' || g, '', 'invite', 'private' from generate_series(1, 9999) g`;
    await fixture.owner`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select s.space_id, ${m}, 'reader', 'grant', ${o}, 1 from schellingaf.spaces s where s.name like 'own-list-%'`;
    // One withheld from everybody: its members are told no position.
    const [hidden] = await fixture.owner<{ space_id: string }[]>`
      select space_id::text from schellingaf.spaces where name = 'own-list-5000'`;
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${hidden!.space_id}::uuid, 'abuse', 'a test')`;
    await fixture.owner`analyze schellingaf.memberships`;

    const on = await measured();
    let first!: Awaited<ReturnType<typeof call>>;
    const took = await on.cpuMs(async () => {
      first = await call("GET", "/v1/me", member, undefined, on.app);
    });
    await on.end();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(took < 1000, `the first page took ${took} ms of processor time, the service's and the database's`);
    assert.equal(first.body.memberships.length, 200);
    assert.equal(first.body.memberships[0].space, "own-list");
    assert.equal(first.body.memberships[0].head_seq, "1", "how far its own SPACE has got");
    let after = first.body.next_after as string;
    let seen = first.body.memberships.length;
    let withheld: any;
    while (after) {
      const page = await call("GET", `/v1/me?after=${after}`, member);
      seen += page.body.memberships.length;
      withheld ??= page.body.memberships.find((x: any) => x.space === "own-list-5000");
      after = page.body.next_after;
    }
    assert.equal(seen, 10000, "every SPACE, once, across the pages");
    assert.equal(withheld.head_seq, null, "a SPACE withheld from its members tells them no position");
  });

  test("with many admins, a join request reaches the owner and the first thirty-two alone", async () => {
    const owner = await agent();
    await makeSpace(owner, "many-admins", "request");
    const [space] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = 'many-admins'`;
    const admins: Agent[] = [];
    for (let i = 0; i < 40; i++) admins.push(await agent());
    for (const a of admins) {
      await fixture.owner`
        insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
        values (${space!.space_id}::uuid, ${Buffer.from(a.peerId, "hex")}, 'admin', 'grant', ${Buffer.from(owner.peerId, "hex")}, 1)`;
    }
    const asker = await agent();
    const asked = await call("POST", "/v1/spaces/many-admins/join", asker, { message: "hello" });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    const [delivered] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.mailbox_deliveries d
       where d.request_id = ${asked.body.request_id}::uuid and d.reason = 'request'`;
    assert.equal(delivered!.n, 1 + SPACE_LIMITS.request_notices);
  });
});
