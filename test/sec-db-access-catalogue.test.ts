// The database's own access rules, read from the catalogue of a database built from the
// migrations: who holds which privilege, which relations the api role reads without
// row-level security and why, the shape of every policy, and what each shape lets a
// member, a stranger and nobody read. test/schema.test.ts checks some of these for the
// objects it names; these check every object, so a new one fails here until it is placed.
//
// Written by the security review of 7 October 2026.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";

let fixture: Fixture;

const opened = setUp(async () => {
  fixture = await cloneDatabase("sec_db_access_catalogue");
});
after(async () => {
  await opened;
  await fixture.end();
});

const OWNER = "schellingaf_owner";
const API = "schellingaf_api";

describe("who holds which privilege", () => {
  test("nothing in the schema is granted to PUBLIC, and only the owner and the api role hold any privilege on it", async () => {
    await opened;
    // An object never granted has a null ACL, which means its kind's defaults: for a
    // function, EXECUTE to PUBLIC. So the ACL read is acldefault() where it is null.
    const rows = await fixture.owner<{ kind: string; name: string; grantee: string; owner: string }[]>`
      select 'function' as kind, p.oid::regprocedure::text as name,
             coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee, p.proowner::regrole::text as owner
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.pronamespace = 'schellingaf'::regnamespace
      union all
      select case c.relkind when 'S' then 'sequence' else 'relation' end, c.relname,
             coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'), c.relowner::regrole::text
        from pg_class c, aclexplode(coalesce(c.relacl, acldefault(case c.relkind when 'S' then 's' else 'r' end::"char", c.relowner))) a
       where c.relnamespace = 'schellingaf'::regnamespace and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
      union all
      select 'column', c.relname || '.' || t.attname,
             coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'), c.relowner::regrole::text
        from pg_class c join pg_attribute t on t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped,
             aclexplode(t.attacl) a
       where c.relnamespace = 'schellingaf'::regnamespace`;
    assert.ok(rows.length > 300, `only ${rows.length} grants were read`);
    assert.deepEqual(rows.filter((r) => ![OWNER, API].includes(r.grantee)).map((r) => `${r.kind} ${r.name} to ${r.grantee}`), []);
    assert.deepEqual([...new Set(rows.filter((r) => r.owner !== OWNER).map((r) => `${r.kind} ${r.name} owned by ${r.owner}`))], []);
    assert.deepEqual(rows.filter((r) => r.kind === "sequence" && r.grantee === API).map((r) => r.name), [], "a sequence's value counts rows");
  });

  test("the api role writes no table but the token and OAuth rows the sign-in routes write, and creates nothing anywhere", async () => {
    await opened;
    // Every other write is a definer function's, which checks who may write.
    const writes = await fixture.owner<{ write: string }[]>`
      select c.relname || ' ' || a.privilege_type as write
        from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       where c.relnamespace = 'schellingaf'::regnamespace and a.grantee = ${API}::regrole and a.privilege_type <> 'SELECT'
      union all
      select c.relname || ' ' || x.privilege_type || '(' || t.attname || ')'
        from pg_class c join pg_attribute t on t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped,
             aclexplode(t.attacl) x
       where c.relnamespace = 'schellingaf'::regnamespace and x.grantee = ${API}::regrole and x.privilege_type <> 'SELECT'
       order by 1`;
    assert.deepEqual(writes.map((w) => w.write), [
      "oauth_clients INSERT",
      "oauth_clients UPDATE(last_used_at)",
      "oauth_requests INSERT",
      "tokens INSERT",
      "tokens UPDATE(last_used_at)",
      "tokens UPDATE(revoked_at)",
    ]);
    const [creates] = await fixture.owner<{ schemas: string[]; database: boolean }[]>`
      select array(select n.nspname::text from pg_namespace n where has_schema_privilege(${API}, n.oid, 'CREATE') order by 1) as schemas,
             has_database_privilege(${API}, current_database(), 'CREATE') as database`;
    assert.deepEqual(creates!.schemas, [], "the api role may create objects in a schema");
    assert.equal(creates!.database, false, "the api role may create a schema");
  });

  test("default privileges grant nothing to anybody but the owner, so a new object starts closed", async () => {
    await opened;
    const rows = await fixture.owner<{ role: string; schema: string | null; kind: string; acl: string[] }[]>`
      select defaclrole::regrole::text as role, nullif(defaclnamespace::regnamespace::text, '-') as schema,
             defaclobjtype::text as kind, defaclacl::text[] as acl
        from pg_default_acl order by 1, 2, 3`;
    // Functions: EXECUTE taken from PUBLIC, so a new function is the owner's until granted.
    assert.deepEqual([...rows], [{ role: OWNER, schema: null, kind: "f", acl: [`${OWNER}=X/${OWNER}`] }]);
  });

  test("the roles: the owner logs in nowhere, the migration runner is the owner's, and the api role is nobody's and nothing more", async () => {
    await opened;
    const roles = await fixture.owner<{ name: string; login: boolean; elevated: boolean; bypass: boolean }[]>`
      select rolname as name, rolcanlogin as login, (rolsuper or rolcreatedb or rolcreaterole or rolreplication) as elevated,
             rolbypassrls as bypass
        from pg_roles where rolname like 'schellingaf%' order by 1`;
    assert.deepEqual([...roles], [
      { name: "schellingaf_api", login: true, elevated: false, bypass: false },
      { name: "schellingaf_migrate", login: true, elevated: false, bypass: false },
      { name: "schellingaf_owner", login: false, elevated: false, bypass: false },
    ]);
    const members = await fixture.owner<{ grant: string }[]>`
      select r.roleid::regrole::text || ' to ' || r.member::regrole::text as grant
        from pg_auth_members r
       where r.member::regrole::text like 'schellingaf%' or r.roleid::regrole::text like 'schellingaf%'
       order by 1`;
    // Of the predefined roles too: no pg_read_all_data, no pg_read_all_stats.
    assert.deepEqual(members.map((m) => m.grant), ["schellingaf_owner to schellingaf_migrate"]);
  });
});

/**
 * Relations the api role reads with row-level security off, and why each needs none.
 * Everything else it reads is under a policy below, so a new table it is granted fails
 * here until it has a policy or a reason.
 */
const OPEN: Record<string, string> = {
  connection_keys: "a connection key's public half, its statement and the KEY that signed it: every post it signs is checked against them",
  connection_vaults: "a connection key's private half sealed under its token, which is not stored: nothing kept here opens it",
  encryption_keys: "the public keys sealed messages and sealed SPACES are sealed to",
  oauth_clients: "the apps that registered, by their public metadata",
  oauth_requests: "an authorization request, read by its id or its code's hash, which only its own flow holds",
  passkeys: "a passkey's public key and credential id, which every sign-in presents",
  peer_names: "the name a KEY gave itself, which anybody may read",
  peers: "a KEY's public key and whether it may act; the reason it was blocked is not granted",
  rate_buckets: "allowances, counts without content, read without a debit before a write",
  schema_migrations: "the applied version alone, read by the start-up check",
  service_epochs: "the service's epochs; their details are not granted",
  service_keys: "the service's public signing keys",
  space_categories: "what a SPACE's public profile already says, once for each category it is filed under",
  spaces: "a SPACE's public profile; its counters and revision are not granted",
  tokens: "a token by its hash, which only its holder can present",
  withheld: "the public record that a post is withheld, and since when; the note is not granted",
  withheld_spaces: "the public record that a SPACE is withheld, and since when; the note is not granted",
};

/** What each policy says, named for what it lets a caller read. */
const MEMBERS_OR_PUBLIC = "((space_id IN ( SELECT schellingaf.caller_space_ids() AS caller_space_ids)) OR schellingaf.space_is_public(space_id))";
const MEMBERS = "(space_id IN ( SELECT schellingaf.caller_space_ids() AS caller_space_ids))";
const READERS = "schellingaf.can_read_space(space_id)";
const OWN = "((peer_id)::bytea = schellingaf.caller_id())";
const OWN_DELIVERY = "((recipient_id)::bytea = schellingaf.caller_id())";
const OWN_BLOCK = "((blocker_id)::bytea = schellingaf.caller_id())";
const CONVERSATION = "(conversation_id IN ( SELECT schellingaf.caller_conversation_ids() AS caller_conversation_ids))";
const MESSAGE = "schellingaf.can_read_message(conversation_id, seq, (author_id)::bytea)";
const INVITE = "((space_id IN ( SELECT schellingaf.governed_space_ids() AS governed_space_ids)) OR (maker_seat IN ( SELECT schellingaf.caller_seat_ids() AS caller_seat_ids)) OR ((for_peer)::bytea = schellingaf.caller_id()))";
const REQUEST = "(((peer_id)::bytea = schellingaf.caller_id()) OR (space_id IN ( SELECT schellingaf.admitting_space_ids() AS admitting_space_ids)))";
const BLOCK = "(((peer_id)::bytea = schellingaf.caller_id()) OR (space_id IN ( SELECT schellingaf.governed_space_ids() AS governed_space_ids)))";
const CHECKPOINT = "((space_id IN ( SELECT schellingaf.caller_space_ids() AS caller_space_ids)) OR ((stream = 'posts'::text) AND schellingaf.space_is_public(space_id)))";
const ATTACHED_FILE = "(attached AND ((space_id IN ( SELECT schellingaf.caller_space_ids() AS caller_space_ids)) OR schellingaf.space_is_public(space_id)))";
const RECOVERY = "schellingaf.recovery_notice_readable(canonical)";
const NOBODY = "false";

/** Every table under row-level security: its policy, by name and shape, or none, which reads nothing. */
const POLICIES: Record<string, [string, string] | null> = {
  conversation_locks: ["conversation_locks_read", OWN],
  conversation_members: ["conversation_members_read", CONVERSATION],
  conversations: ["conversations_read", CONVERSATION],
  file_uploads: ["file_uploads_none", NOBODY],
  findings: ["findings_read", MEMBERS_OR_PUBLIC],
  invites: ["invites_read", INVITE],
  join_requests: ["requests_read", REQUEST],
  mailbox_deliveries: ["deliveries_read", OWN_DELIVERY],
  mailboxes: ["mailboxes_read", OWN],
  memberships: ["memberships_read", MEMBERS],
  message_blocks: ["message_blocks_read", OWN_BLOCK],
  message_settings: ["message_settings_read", OWN],
  messages: ["messages_read", MESSAGE],
  oracle_links: ["oracle_links_read", READERS],
  oracle_versions: ["oracle_versions_read", READERS],
  oracle_watches: ["oracle_watches_read", OWN],
  own_dossiers: null,
  post_attachments: ["post_attachments_read", MEMBERS_OR_PUBLIC],
  post_fingerprints: ["fingerprints_read", MEMBERS_OR_PUBLIC],
  post_objections: ["post_objections_read", MEMBERS_OR_PUBLIC],
  post_objects: ["post_objects_read", MEMBERS_OR_PUBLIC],
  post_search: ["search_none", NOBODY],
  post_sources: ["post_sources_read", MEMBERS_OR_PUBLIC],
  posts: ["posts_read", MEMBERS_OR_PUBLIC],
  recovery_notices: ["recovery_notices_read", RECOVERY],
  sealed_generations: ["sealed_generations_read", MEMBERS],
  sealed_keeper_lists: ["sealed_keeper_lists_read", MEMBERS],
  sealed_keeping: ["sealed_keeping_read", MEMBERS],
  sealed_lock_senders: null,
  sealed_locks: ["sealed_locks_read", OWN],
  sealed_posts: ["sealed_posts_read", MEMBERS],
  sealed_stamps: ["sealed_stamps_read", OWN],
  space_blocks: ["space_blocks_read", BLOCK],
  space_checkpoints: ["checkpoints_read", CHECKPOINT],
  space_event_objects: ["event_objects_read", MEMBERS],
  space_events: ["events_read", MEMBERS],
  space_file_totals: ["space_file_totals_none", NOBODY],
  space_files: ["space_files_read", ATTACHED_FILE],
  space_finding_counts: null,
  space_hidden: ["space_hidden_read", MEMBERS_OR_PUBLIC],
  space_stages: ["space_stages_read", READERS],
  task_adds: null,
  task_attempts: ["task_attempts_read", MEMBERS_OR_PUBLIC],
  task_check_offers: null,
  task_checks: ["task_checks_read", MEMBERS_OR_PUBLIC],
  task_claims: ["task_claims_read", MEMBERS_OR_PUBLIC],
  task_revisions: ["task_revisions_read", MEMBERS_OR_PUBLIC],
  task_upkeep: null,
  tasks: ["tasks_read", MEMBERS_OR_PUBLIC],
};

/**
 * What each shape lets the caller read of a row, by the SPACE the row is in (one only its
 * members read, a public one, and a public one an operator withheld) and by who asks: a
 * KEY that owns all three SPACES and is the row's own KEY and a party to its conversation,
 * another KEY in none of them, and nobody. A withheld SPACE goes dark to its owner as well
 * (runbooks/withhold.md); a row that is the KEY's own, or its conversation's, is not the
 * SPACE's. A recovery notice is about a SPACE as src/db/recover.ts signs it: apart, by its
 * space_id, for a SPACE that is not public, which its members alone read; in the public
 * SPACES' notice for a public one, which everybody reads, withheld or not, because
 * withholding hides a SPACE's posts, not what the service signed about its chain.
 */
type Where = "private" | "public" | "withheld";
type Who = "member" | "stranger" | "nobody";
const content = (where: Where, who: Who) => where !== "withheld" && (who === "member" || where === "public");
const theirs = (_where: Where, who: Who) => who === "member";
const ADMITS: Record<string, (where: Where, who: Who) => boolean> = {
  [MEMBERS_OR_PUBLIC]: content,
  [READERS]: content,
  [CHECKPOINT]: content,
  [ATTACHED_FILE]: content,
  [RECOVERY]: (where, who) => where !== "private" || who === "member",
  [MEMBERS]: (where, who) => where !== "withheld" && who === "member",
  [OWN]: theirs,
  [OWN_DELIVERY]: theirs,
  [OWN_BLOCK]: theirs,
  [CONVERSATION]: theirs,
  [MESSAGE]: theirs,
  [INVITE]: theirs,
  [REQUEST]: theirs,
  [BLOCK]: theirs,
  [NOBODY]: () => false,
};

/** A policy's condition with the row's values where its columns are. */
function rowOf(qual: string, value: Record<string, string>): string {
  return qual.replace(new RegExp(`(?<![\\w.])(${Object.keys(value).join("|")})(?![\\w(])`, "g"), (column) => value[column]!);
}

describe("which relations are under row-level security, and what each policy lets a caller read", () => {
  test("every relation the api role reads is under row-level security, or runs as its invoker, or is listed with its reason", async () => {
    await opened;
    const rows = await fixture.owner<{ name: string; kind: string; rls: boolean; force: boolean; invoker: boolean }[]>`
      select c.relname as name, c.relkind::text as kind, c.relrowsecurity as rls, c.relforcerowsecurity as force,
             coalesce('security_invoker=true' = any(c.reloptions), false) as invoker
        from pg_class c
       where c.relnamespace = 'schellingaf'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f')
         and (has_table_privilege(${API}, c.oid, 'SELECT')
              or exists (select 1 from pg_attribute t where t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped
                                                       and has_column_privilege(${API}, c.oid, t.attnum, 'SELECT')))
       order by 1`;
    assert.ok(rows.length > 40, `the api role reads only ${rows.length} relations`);
    assert.deepEqual(rows.filter((r) => r.force).map((r) => r.name), [], "FORCE would break the owner-run functions");
    assert.deepEqual(rows.filter((r) => r.kind !== "r" && r.kind !== "v").map((r) => r.name), [], "a relation of a kind this test does not class");
    assert.deepEqual(rows.filter((r) => r.kind === "v" && !r.invoker).map((r) => r.name), [], "a view the api role reads runs as its owner, past every policy");
    const open = rows.filter((r) => r.kind === "r" && !r.rls).map((r) => r.name);
    assert.deepEqual(open.filter((n) => !(n in OPEN)), [], "the api role reads a table with no row-level security and no reason here");
    assert.deepEqual(Object.keys(OPEN).filter((n) => !open.includes(n)), [], "listed as read without row-level security, and no longer is");
  });

  test("every policy is one of the shapes above, permissive, for SELECT, to the api role alone, and none checks a write", async () => {
    await opened;
    // Deparsed with pg_catalog alone on the search path, so every function is named in full.
    const rows = (await fixture.owner.begin(async (tx) => {
      await tx`set local search_path = pg_catalog`;
      return tx<{ table: string; name: string; permissive: string; roles: string[]; cmd: string; qual: string | null; check: string | null }[]>`
        select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd, qual, with_check as check
          from pg_policies where schemaname = 'schellingaf' order by 1, 2`;
    })) as unknown as { table: string; name: string; permissive: string; roles: string[]; cmd: string; qual: string | null; check: string | null }[];
    const tables = await fixture.owner<{ name: string }[]>`
      select relname as name from pg_class where relnamespace = 'schellingaf'::regnamespace and relrowsecurity order by 1`;
    assert.deepEqual(tables.map((t) => t.name), Object.keys(POLICIES).sort(), "a table under row-level security this test does not name, or one no longer under it");
    const shapes = Object.fromEntries(Object.entries(POLICIES).map(([table, p]) => [table, p === null ? [] : [p]]));
    const found: Record<string, [string, string][]> = Object.fromEntries(Object.keys(POLICIES).map((t) => [t, []]));
    for (const r of rows) {
      assert.equal(r.permissive, "PERMISSIVE", `${r.table}.${r.name}`);
      assert.deepEqual(r.roles, [API], `${r.table}.${r.name} applies to another role`);
      assert.equal(r.cmd, "SELECT", `${r.table}.${r.name} is for a write: the api role writes through definer functions`);
      assert.equal(r.check, null, `${r.table}.${r.name}`);
      (found[r.table] ??= []).push([r.name, r.qual ?? ""]);
    }
    assert.deepEqual(found, shapes);
  });

  test("each shape lets a member, a stranger and nobody read what the comment above says, a withheld SPACE dark to all but in a recovery notice", async () => {
    await opened;
    // One KEY owns a private, a public and a withheld public SPACE and has a conversation
    // with a second KEY; a third KEY is in none of it. Each policy is asked about a row by
    // putting the row's values where its columns are, as the api role, with each caller
    // bound the way readTx binds it.
    const owner = publicKey("sec-catalogue-owner");
    const other = publicKey("sec-catalogue-other");
    const stranger = publicKey("sec-catalogue-stranger");
    const o = peerIdOf(owner);
    const d = peerIdOf(other);
    const s = peerIdOf(stranger);
    for (const key of [owner, other, stranger]) await fixture.owner`select schellingaf.register_peer(${key})`;
    const made: Record<Where, { id: string; seat: string }> = {} as never;
    for (const [where, visibility] of [["private", "private"], ["public", "public"], ["withheld", "public"]] as const) {
      await fixture.owner`
        select schellingaf.create_space(p_owner => decode(${o}, 'hex'), p_name => ${`sec-catalogue-${where}`}, p_title => 'A SPACE',
                                        p_visibility => ${visibility})`;
      const [row] = await fixture.owner<{ id: string; seat: string }[]>`
        select space_id::text as id, owner_seat::text as seat from schellingaf.spaces where name = ${`sec-catalogue-${where}`}`;
      made[where] = row!;
    }
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note) values (${made.withheld.id}::uuid, 'abuse', 'test')`;
    const low = o < d ? o : d;
    const high = o < d ? d : o;
    const [conversation] = await fixture.owner<{ id: string }[]>`
      insert into schellingaf.conversations (kind, started_by, pair_low, pair_high, last_seq)
      values ('pair', decode(${o}, 'hex'), decode(${low}, 'hex'), decode(${high}, 'hex'), 1)
      returning conversation_id::text as id`;
    await fixture.owner`
      insert into schellingaf.conversation_members (conversation_id, peer_id, state)
      values (${conversation!.id}::uuid, decode(${o}, 'hex'), 'accepted'), (${conversation!.id}::uuid, decode(${d}, 'hex'), 'accepted')`;
    await fixture.owner`
      insert into schellingaf.messages (conversation_id, seq, author_id, body, content_hash)
      values (${conversation!.id}::uuid, 1, decode(${d}, 'hex'), 'hello', sha256('hello'::bytea))`;

    const rows = (await fixture.owner.begin(async (tx) => {
      await tx`set local search_path = pg_catalog`;
      return tx<{ table: string; qual: string }[]>`select tablename as table, qual from pg_policies where schemaname = 'schellingaf' order by 1`;
    })) as unknown as { table: string; qual: string }[];
    const callers: Record<Who, string | null> = { member: o, stranger: s, nobody: null };
    /** Every row a policy lets a caller read that its shape says it may not, and the reverse. */
    const misreads = async (): Promise<string[]> => {
      const wrong: string[] = [];
      for (const where of ["private", "public", "withheld"] as const) {
        const space = made[where];
        const value: Record<string, string> = {
          space_id: `'${space.id}'::uuid`,
          maker_seat: `'${space.seat}'::uuid`,
          peer_id: `'\\x${o}'::bytea`,
          for_peer: `'\\x${o}'::bytea`,
          recipient_id: `'\\x${o}'::bytea`,
          blocker_id: `'\\x${o}'::bytea`,
          conversation_id: `'${conversation!.id}'::uuid`,
          seq: "1::bigint",
          author_id: `'\\x${d}'::bytea`,
          stream: "'posts'::text",
          attached: "true",
          canonical:
            where === "private"
              ? `convert_to('{"space_id": "${space.id}", "spaces": [{"space_id": "${space.id}"}]}', 'UTF8')`
              : `convert_to('{"spaces": [{"space_id": "${space.id}"}]}', 'UTF8')`,
        };
        for (const { table, qual } of rows) {
          const admits = ADMITS[qual];
          assert.ok(admits, `${table}'s policy is no shape this test knows: ${qual}`);
          const asked = rowOf(qual, value);
          for (const [who, caller] of Object.entries(callers) as [Who, string | null][]) {
            const [answer] = (await fixture.asCaller(caller, (sql) => sql.unsafe(`select (${asked}) is true as reads`))) as unknown as { reads: boolean }[];
            if (answer!.reads !== admits(where, who)) wrong.push(`${table}: ${who} ${answer!.reads ? "reads" : "does not read"} a row of the ${where} SPACE`);
          }
        }
      }
      return wrong;
    };
    assert.deepEqual(await misreads(), []);
    // The same questions find a predicate that forgets withholding, here in this clone only:
    // every content row of the withheld SPACE then reaches a stranger and nobody.
    const [kept] = await fixture.owner<{ def: string }[]>`select pg_get_functiondef('schellingaf.space_is_public(uuid)'::regprocedure) as def`;
    await fixture.owner.unsafe(`
      create or replace function schellingaf.space_is_public(p_space uuid) returns boolean
        language sql stable security definer set search_path = pg_catalog, schellingaf, pg_temp
        return coalesce((select s.visibility = 'public' from schellingaf.spaces s where s.space_id = p_space), false)`);
    try {
      const forgot = await misreads();
      assert.ok(forgot.includes("posts: nobody reads a row of the withheld SPACE"), forgot.join("\n"));
      assert.ok(forgot.includes("space_stages: stranger reads a row of the withheld SPACE"), forgot.join("\n"));
      assert.ok(forgot.every((w) => / reads a row of the withheld SPACE$/.test(w)), forgot.join("\n"));
    } finally {
      await fixture.owner.unsafe(kept!.def);
    }
    assert.deepEqual(await misreads(), [], "space_is_public was not put back");
    // And the one shape that splits by stream: a public SPACE's event chain is its members' alone.
    const events = rowOf(CHECKPOINT, { space_id: `'${made.public.id}'::uuid`, stream: "'events'::text" });
    const [nobody] = (await fixture.asCaller(null, (sql) => sql.unsafe(`select (${events}) is true as reads`))) as unknown as { reads: boolean }[];
    assert.equal(nobody!.reads, false, "nobody reads a public SPACE's event checkpoints");
  });
});
