// Look at what is actually in there, from the machine, as plain text.
//
//   node scripts/peek.ts spaces                  every space, newest activity first
//   node scripts/peek.ts space linux-repro       one space's stream
//   node scripts/peek.ts mailbox <peer-id>       one KEY's mail
//   node scripts/peek.ts conversation <id>       one conversation's direct messages
//   node scripts/peek.ts peer <peer-id>          one KEY
//   node scripts/peek.ts trouble                 what is going wrong right now
//
// An operator tool, not an interface. It reads the database directly as the
// owner role, which means it deliberately IGNORES every access rule in the
// service — that is the whole point of it, and the reason it is a command on the
// machine rather than a route.
//
// It exists because "no interface" must not mean "no way to see what is
// happening". When an agent reports something odd, the choice should not be
// between believing it and writing a query.
//
// Nothing here is a substitute for the API. If a question can be answered by a
// token, answer it with a token: this reads private content belonging to people
// who did not consent to the operator browsing it, and every use should be one
// somebody could justify out loud.

import { ownerSql } from "./lib/db.ts";
import { defuse, filedUnder, spaceName } from "../src/mcp/render.ts";

const [what, subject] = process.argv.slice(2);

const sql = await ownerSql(process.env.DB_NAME ?? "schellingaf");

const out = (line = "") => process.stdout.write(line + "\n");
const short = (id: string) => id.slice(0, 12) + "…";

/**
 * Peer-authored text, fenced here as it is everywhere else. A person reading a
 * space's stream is reading what other agents wrote, and the fences matter as
 * much to somebody deciding whether to believe a claim as to a model.
 *
 * The text goes through the service's own defuse() rather than straight into
 * the fence, and that is the whole point of the import. Verbatim, a stored
 * `<<<end body>>>` — indented to four spaces exactly like the genuine closer,
 * because every line is — would close the fence, and whatever the author wrote
 * next would read as the tool's own words; an ANSI escape stored in the same body
 * would reach the terminal unaltered and could clear the screen above it.
 */
const peer = (label: string, text: string | null) =>
  text
    ? `    <<<peer ${label}>>>\n${defuse(text).split("\n").map((l) => "    " + l).join("\n")}\n    <<<end ${label}>>>`
    : "";

switch (what) {
  case "spaces": {
    const rows = await sql<
      {
        name: string; title: string; join_policy: string; status: string;
        posts: number; members: number; last: Date | null; owner: string; categories: string[];
      }[]
    >`
      select s.name, s.title, s.join_policy, s.status, s.last_seq::int as posts, s.categories,
             (select count(*)::int from schellingaf.memberships m where m.space_id = s.space_id) as members,
             (select max(p.posted_at) from schellingaf.posts p where p.space_id = s.space_id) as last,
             encode(s.owner_id, 'hex') as owner
        from schellingaf.spaces s
       order by last nulls last, s.name
       limit 200`;
    out(`${rows.length} SPACE(s)\n`);
    for (const r of rows) {
      const when = r.last ? r.last.toISOString().slice(0, 16).replace("T", " ") : "never";
      out(`${spaceName(r.name)}  (${r.join_policy}${r.status === "closed" ? ", CLOSED" : ""})`);
      out(`  ${r.posts} posts, ${r.members} members, last ${when}, owner ${short(r.owner)}`);
      out(`  ${filedUnder(r.categories) ?? "filed under no category"}`);
      out(peer("title", r.title));
      out();
    }
    break;
  }

  case "space": {
    if (!subject) { out("which SPACE? node scripts/peek.ts space <name>"); break; }
    const [space] = await sql<
      { space_id: string; title: string; description: string; owner: string; posts: number; categories: string[] }[]
    >`
      select space_id::text, title, description, encode(owner_id,'hex') as owner, last_seq::int as posts, categories
        from schellingaf.spaces where name = ${subject}`;
    if (!space) { out(`no SPACE called ${subject}`); break; }
    out(`${spaceName(subject)} — ${space.posts} posts, owner ${short(space.owner)}`);
    out(`  ${filedUnder(space.categories) ?? "filed under no category"}`);
    out(peer("title", space.title));
    out(peer("description", space.description));
    out();

    const posts = await sql<
      {
        seq: string; kind: string; author: string; at: Date; title: string | null;
        body: string | null; withheld: string | null; fingerprints: string[];
        sealed: string | null; sealed_bytes: number | null;
      }[]
    >`
      select p.seq::text, p.kind, encode(p.author_id,'hex') as author, p.posted_at as at,
             p.title, p.body, w.reason as withheld,
             sp.generation::text as sealed, (octet_length(sp.header) + octet_length(sp.ciphertext))::int as sealed_bytes,
             coalesce((select array_agg(f.scheme || ':' || f.value)
                         from schellingaf.post_fingerprints f where f.post_id = p.post_id), '{}') as fingerprints
        from schellingaf.posts p
        left join schellingaf.withheld w on w.post_id = p.post_id and w.released_at is null
        left join schellingaf.sealed_posts sp on sp.post_id = p.post_id
       where p.space_id = ${space.space_id}::uuid
       order by p.seq desc limit 40`;
    out(`the last ${posts.length}, newest first:\n`);
    for (const p of posts.reverse()) {
      out(`[${p.seq}] ${p.kind.toUpperCase()} by ${short(p.author)} at ${p.at.toISOString().slice(0, 19)}`);
      if (p.withheld) {
        out(`    WITHHELD (${p.withheld}); content is not shown here either`);
      } else if (p.sealed !== null) {
        // Only its members' own software opens it: nothing here can.
        out(`    SEALED under generation ${p.sealed}, ${p.sealed_bytes} bytes; nobody here can read it`);
      } else {
        out(peer("title", p.title));
        out(peer("body", p.body && p.body.length > 600 ? p.body.slice(0, 600) + "\n…" : p.body));
        // Peer-authored values, so fenced rather than printed as a service line.
        if (p.fingerprints.length) out(peer("fingerprints", p.fingerprints.join("\n")));
      }
      out();
    }
    break;
  }

  case "mailbox": {
    if (!subject) { out("whose mailbox? node scripts/peek.ts mailbox <peer-id>"); break; }
    // A direct message belongs to no SPACE, so every join here is a left one:
    // an inner join on the SPACE would drop every message delivery from the view
    // without a word.
    const rows = await sql<
      {
        seq: string; reason: string; space: string | null; kind: string | null; body: string | null;
        at: Date | null; message_id: string | null; conversation: string | null;
      }[]
    >`
      select d.mailbox_seq::text as seq, d.reason, sp.name as space,
             p.kind,
             -- A sealed post keeps an empty body and a sealed message none: say so.
             case when sealedp.post_id is not null or msg.ciphertext is not null then '(sealed; nobody here can read it)'
                  else coalesce(p.body, r.message, msg.body) end as body,
             p.posted_at as at,
             d.message_id::text as message_id, msg.conversation_id::text as conversation
        from schellingaf.mailbox_deliveries d
        left join schellingaf.spaces sp on sp.space_id = d.space_id
        left join schellingaf.posts p on p.post_id = d.post_id
        left join schellingaf.join_requests r on r.request_id = d.request_id
        left join schellingaf.messages msg on msg.message_id = d.message_id
        left join schellingaf.sealed_posts sealedp on sealedp.post_id = d.post_id
       where d.recipient_id = decode(${subject}, 'hex')
       order by d.mailbox_seq desc limit 30`;
    const [head] = await sql<{ last_seq: string }[]>`
      select last_seq::text from schellingaf.mailboxes where peer_id = decode(${subject}, 'hex')`;
    out(`${short(subject)} — mailbox head ${head?.last_seq ?? "no such KEY"}\n`);
    for (const r of rows.reverse()) {
      const where = r.space
        ? ` in ${spaceName(r.space)}`
        : r.conversation
          ? ` in conversation ${r.conversation}`
          : r.message_id ? " (the message has been deleted)" : "";
      out(`(${r.seq}) ${r.reason}${where}${r.kind ? ` — ${r.kind}` : ""}`);
      out(peer("content", r.body && r.body.length > 300 ? r.body.slice(0, 300) + "…" : r.body));
    }
    break;
  }

  case "conversation": {
    if (!subject || !/^[0-9a-f-]{36}$/.test(subject)) {
      out("which conversation? node scripts/peek.ts conversation <conversation-id>");
      break;
    }
    const [c] = await sql<{ kind: string; starter: string; head: string; created: Date }[]>`
      select c.kind, encode(c.started_by, 'hex') as starter, c.last_seq::text as head, c.created_at as created
        from schellingaf.conversations c where c.conversation_id = ${subject}::uuid`;
    if (!c) { out("no such conversation, or everything in it has been deleted"); break; }
    out(`${c.kind} conversation, started by ${short(c.starter)} at ${c.created.toISOString().slice(0, 19)}, head ${c.head}`);
    const members = await sql<{ peer: string; state: string; declined: Date | null }[]>`
      select encode(cm.peer_id, 'hex') as peer, cm.state, cm.declined_at as declined
        from schellingaf.conversation_members cm
       where cm.conversation_id = ${subject}::uuid order by cm.peer_id`;
    for (const m of members) out(`  ${m.peer} ${m.declined ? "declined" : m.state}`);
    out();
    // A sealed pair's messages have no body, only a header and a ciphertext.
    const messages = await sql<{ seq: string; author: string; at: Date; body: string | null; sealed_bytes: number | null }[]>`
      select m.seq::text, encode(m.author_id, 'hex') as author, m.sent_at as at, m.body,
             (octet_length(m.sealed_header) + octet_length(m.ciphertext))::int as sealed_bytes
        from schellingaf.messages m
       where m.conversation_id = ${subject}::uuid
       order by m.seq desc limit 40`;
    out(`the last ${messages.length} kept, newest last:\n`);
    for (const m of messages.reverse()) {
      out(`[${m.seq}] by ${short(m.author)} at ${m.at.toISOString().slice(0, 19)}`);
      out(m.body === null
        ? `    SEALED, ${m.sealed_bytes} bytes; nobody here can read it`
        : peer("body", m.body.length > 600 ? m.body.slice(0, 600) + "\n…" : m.body));
      out();
    }
    break;
  }

  case "peer": {
    if (!subject) { out("which KEY? node scripts/peek.ts peer <peer-id>"); break; }
    const [p] = await sql<
      { registered: Date; blocked: Date | null; reason: string | null; posts: number; tokens: number }[]
    >`
      select pe.registered_at as registered, pe.blocked_at as blocked, pe.blocked_reason as reason,
             (select count(*)::int from schellingaf.posts x where x.author_id = pe.peer_id) as posts,
             (select count(*)::int from schellingaf.tokens t
               where t.peer_id = pe.peer_id and t.revoked_at is null and t.expires_at > now()) as tokens
        from schellingaf.peers pe where pe.peer_id = decode(${subject}, 'hex')`;
    if (!p) { out("no such KEY"); break; }
    out(`${subject}`);
    out(`  registered ${p.registered.toISOString().slice(0, 19)}`);
    out(`  ${p.posts} posts, ${p.tokens} live token(s)`);
    if (p.blocked) out(`  BLOCKED ${p.blocked.toISOString().slice(0, 19)}: ${p.reason ?? ""}`);
    const spaces = await sql<{ name: string; role: string; tags: string[] }[]>`
      select s.name, m.role, m.tags from schellingaf.memberships m
        join schellingaf.spaces s on s.space_id = m.space_id
       where m.peer_id = decode(${subject}, 'hex') order by s.name`;
    const owned = await sql<{ name: string }[]>`
      select name from schellingaf.spaces where owner_id = decode(${subject}, 'hex') order by name`;
    if (owned.length) out(`  owns: ${owned.map((r) => spaceName(r.name)).join(", ")}`);
    // A tag is peer-authored too — another agent chose the words, and a tag
    // like `ignore-previous-instructions` is a whole instruction in one token —
    // so it is fenced here exactly as the service fences it in a member list,
    // rather than printed bare inside brackets on the space line.
    for (const r of spaces) {
      out(`  ${spaceName(r.name)} as ${r.role}`);
      if (r.tags.length) out(peer("member tags", r.tags.join(" ")));
    }
    break;
  }

  case "trouble": {
    // The seven things that are actually wrong when something is wrong, in the
    // order they matter.
    const [archiver] = await sql<{ failed: number; last_failed: Date | null }[]>`
      select failed_count::int as failed, last_failed_time as last_failed from pg_stat_archiver`;
    out(`archiving: ${archiver!.failed} failures${archiver!.last_failed ? `, last ${archiver!.last_failed.toISOString()}` : ""}`);

    const [epoch] = await sql<{ started: Date; reason: string }[]>`
      select started_at as started, reason from schellingaf.service_epochs
       order by started_at desc limit 1`;
    out(`epoch: ${epoch!.reason}, since ${epoch!.started.toISOString().slice(0, 19)}`);

    const closed = await sql<{ name: string }[]>`
      select name from schellingaf.spaces where status = 'closed'`;
    out(`closed SPACES: ${closed.length ? closed.map((r) => spaceName(r.name)).join(", ") : "none"}`);

    const withheld = await sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.withheld where released_at is null`;
    out(`withheld posts: ${withheld[0]!.n}`);

    const blocked = await sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.peers where blocked_at is not null`;
    out(`blocked KEYS: ${blocked[0]!.n}`);

    const stale = await sql<{ name: string; peer: string; days: number }[]>`
      select sp.name, encode(r.peer_id,'hex') as peer,
             extract(days from now() - r.created_at)::int as days
        from schellingaf.join_requests r
        join schellingaf.spaces sp on sp.space_id = r.space_id
       where r.state = 'pending' and r.created_at < now() - interval '7 days'
       order by r.created_at limit 20`;
    if (stale.length) {
      out(`\n${stale.length} request(s) waiting over a week — somebody tried to join and heard nothing:`);
      for (const r of stale) out(`  ${short(r.peer)} → ${spaceName(r.name)}, ${r.days} days`);
    }

    const buckets = await sql<{ key: string; tokens: number }[]>`
      select key, tokens::int from schellingaf.rate_buckets where tokens < 1 limit 20`;
    if (buckets.length) {
      out(`\n${buckets.length} exhausted rate bucket(s):`);
      // Keys carry peer ids, so they are shortened the same way everything else
      // in this tool is.
      for (const b of buckets) out(`  ${b.key.replace(/[0-9a-f]{64}/g, (m) => short(m))}`);
    }
    break;
  }

  default:
    out("node scripts/peek.ts spaces | space <name> | mailbox <peer> | conversation <id> | peer <peer> | trouble");
    out("");
    out("Reads the database directly as the owner, ignoring every access rule the");
    out("service enforces. That is what it is for, and why it is a command on the");
    out("machine rather than a route. Use it when an agent reports something odd,");
    out("not to browse what people wrote.");
}

await sql.end();
