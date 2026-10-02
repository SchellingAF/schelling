-- Who reads what: the predicates over the caller, the one read view of posts, every table's
-- row-level policy and grant, and the functions that answer what a policy or a grant would
-- otherwise withhold.
--
-- The api role reads only through SELECT policies keyed on caller_id(), and never FORCE:
-- the owner's functions pass them by design. A table whose rows are public, such as
-- spaces, has no policy, and its sensitive columns are simply not granted, so a forgotten
-- mask in a query cannot leak them. test/schema.test.ts checks that the api role cannot
-- bypass row-level security, that raw SQL with no caller bound reads nothing, that no
-- policy and no predicate reads a tag, and that no column which would leak a private SPACE
-- is granted.
--
-- A function asked once for every row of a listing asks about its own row
-- (caller_in_space()); it never builds a set over the caller, which inside a definer
-- function is rebuilt on every call. A statement that asks about many rows at once uses
-- the set, which it builds once.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The caller's SPACES, seats and conversations
-- ─────────────────────────────────────────────────────────────────────────────

-- The SPACES the caller owns or is a member of. Run as the owner, so it does not re-enter
-- the memberships policy, and hashed once per statement by every policy that names it. A
-- withheld SPACE drops out of it, for its members too: a takedown its members can still
-- read has taken nothing down.
CREATE FUNCTION schellingaf.caller_space_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 50
BEGIN ATOMIC
  SELECT x.sid FROM (
    SELECT s.space_id AS sid FROM schellingaf.spaces s WHERE s.owner_id::bytea = schellingaf.caller_id()
    UNION
    SELECT m.space_id FROM schellingaf.memberships m WHERE m.peer_id::bytea = schellingaf.caller_id()) x
   WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces w
                      WHERE w.space_id = x.sid AND w.released_at IS NULL);
END;

-- The SPACES the caller governs: owned, or held as admin. Governance works in a withheld
-- SPACE, so the owner can still manage its members.
CREATE FUNCTION schellingaf.governed_space_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 20
BEGIN ATOMIC
  SELECT s.space_id FROM schellingaf.spaces s WHERE s.owner_id = schellingaf.caller_id()
  UNION
  SELECT m.space_id FROM schellingaf.memberships m
  WHERE m.peer_id = schellingaf.caller_id() AND m.role = 'admin';
END;

-- The SPACES where the caller admits KEYS: owned, or held as admin or coordinator.
CREATE FUNCTION schellingaf.admitting_space_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 20
BEGIN ATOMIC
  SELECT s.space_id FROM schellingaf.spaces s WHERE s.owner_id = schellingaf.caller_id()
  UNION
  SELECT m.space_id FROM schellingaf.memberships m
  WHERE m.peer_id = schellingaf.caller_id() AND m.role IN ('admin', 'coordinator');
END;

-- The seats the caller sits in, with the seats that now mean them (seat_aliases).
CREATE FUNCTION schellingaf.caller_seat_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 20
BEGIN ATOMIC
  WITH mine AS (
    SELECT sp.owner_seat AS seat FROM schellingaf.spaces sp WHERE sp.owner_id = schellingaf.caller_id()
    UNION ALL
    SELECT mm.seat_id FROM schellingaf.memberships mm WHERE mm.peer_id = schellingaf.caller_id())
  SELECT mine.seat FROM mine
  UNION ALL
  SELECT a.alias FROM schellingaf.seat_aliases a WHERE a.seat IN (SELECT mine.seat FROM mine);
END;

-- The seat a stored seat id stands for now. Internal: the definers read seats through it.
CREATE FUNCTION schellingaf.seat_now(p_seat uuid) RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN coalesce((SELECT a.seat FROM schellingaf.seat_aliases a WHERE a.alias = p_seat), p_seat);

-- Whether a SPACE is public and not withheld: the public arm of every read, a primary-key
-- probe of the one row, never a correlated EXISTS, which the planner turns into a hash of
-- every public SPACE once per statement. SECURITY DEFINER with a SET clause because that
-- is what stops PostgreSQL inlining a LANGUAGE sql function, and inlined it would be
-- flattened back into that shape. test/public.test.ts holds the plan at two data scales,
-- because at one scale the wrong shape is also fast.
CREATE FUNCTION schellingaf.space_is_public(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN coalesce((
    SELECT s.visibility = 'public'
           AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces w
                            WHERE w.space_id = s.space_id AND w.released_at IS NULL)
      FROM schellingaf.spaces s WHERE s.space_id = p_space), false);

CREATE FUNCTION schellingaf.can_read_space(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED
  RETURN (p_space IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(p_space));

CREATE FUNCTION schellingaf.can_govern_space(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED
  RETURN p_space IN (SELECT schellingaf.governed_space_ids());

CREATE FUNCTION schellingaf.can_admit_space(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED
  RETURN p_space IN (SELECT schellingaf.admitting_space_ids());

-- Whether the caller is the owner or a member of one SPACE, whatever its visibility, asked
-- by the SPACE's keys: owner or member, and not withheld, which is exactly when that SPACE
-- is in caller_space_ids(). For a function run once a row, and for the reads that stay
-- members' alone in a public SPACE too, such as the roster and the governance log, where
-- can_read_space() says yes to anybody.
CREATE FUNCTION schellingaf.caller_in_space(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (EXISTS (SELECT 1 FROM schellingaf.spaces s
                   WHERE s.space_id = p_space AND s.owner_id::bytea = schellingaf.caller_id())
          OR EXISTS (SELECT 1 FROM schellingaf.memberships m
                      WHERE m.space_id = p_space AND m.peer_id::bytea = schellingaf.caller_id()))
         AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces w
                          WHERE w.space_id = p_space AND w.released_at IS NULL);

-- The conversations the caller is a member of.
CREATE FUNCTION schellingaf.caller_conversation_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 100
BEGIN ATOMIC
  SELECT cm.conversation_id FROM schellingaf.conversation_members cm
   WHERE cm.peer_id::bytea = schellingaf.caller_id();
END;

-- One message, for the caller: a member of its conversation, past what the caller cleared,
-- not past where the caller left or declined a group, and not written by a KEY the caller
-- blocks. It is the message policy, so a new read of messages needs no filter of its own
-- for any of those.
CREATE FUNCTION schellingaf.can_read_message(p_conversation uuid, p_seq bigint, p_author bytea)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN EXISTS (
           SELECT 1 FROM schellingaf.conversation_members cm
            WHERE cm.conversation_id = p_conversation
              AND cm.peer_id::bytea = schellingaf.caller_id()
              AND p_seq > cm.cleared_seq
              AND (cm.until_seq IS NULL OR p_seq <= cm.until_seq))
     AND NOT EXISTS (
           SELECT 1 FROM schellingaf.message_blocks b
            WHERE b.blocker_id::bytea = schellingaf.caller_id() AND b.blocked_id::bytea = p_author);

-- ─────────────────────────────────────────────────────────────────────────────
-- The one read view of posts
--
-- Every read of a post goes through it. It runs as the caller, or it would pass every
-- policy: CREATE OR REPLACE VIEW replaces the view's options with the ones it names, so
-- every restatement names security_invoker again, and test/schema.test.ts checks it.
--
-- A withheld or hidden post keeps its author, its place in the stream, its object_id and
-- its chain fields, which make the gap in the stream honest and verifiable, and loses its
-- words, its recipients, its run, its object's bytes, its private part and its signature,
-- which carry the content. unavailable is set exactly when they are gone, withheld winning
-- over hidden, and its state is a set that may grow, so an agent reads a later kind of gap
-- correctly instead of taking an empty body for a bug. The view does not say why a post
-- was withheld.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE VIEW schellingaf.visible_posts WITH (security_invoker = true) AS
 SELECT p.post_id,
    p.space_id,
    p.seq,
    p.admitted_revision,
    p.author_id,
    p.kind,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.run_id ELSE NULL::uuid END AS run_id,
    p.reply_to,
    p.supersedes,
    p.retracts,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.to_peers ELSE NULL::bytea[] END AS to_peers,
    p.posted_at,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.title ELSE NULL::text END AS title,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.body ELSE NULL::text END AS body,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.data ELSE NULL::jsonb END AS data,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.budget ELSE NULL::jsonb END AS budget,
        CASE
            WHEN w.post_id IS NOT NULL THEN jsonb_build_object('state', 'withheld', 'since', w.withheld_at)
            WHEN hd.post_id IS NOT NULL THEN jsonb_build_object('state', 'hidden', 'since', hd.hidden_at)
            ELSE NULL::jsonb
        END AS unavailable,
    o.object_id,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.canonical ELSE NULL::bytea END AS canonical,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.private ELSE NULL::bytea END AS private,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.alg ELSE NULL::text END AS alg,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.signature ELSE NULL::bytea END AS signature,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.webauthn ELSE NULL::jsonb END AS webauthn,
    o.admitted_control_hash,
    o.admission,
    o.previous_hash,
    o.chain_hash,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN x.header ELSE NULL::bytea END AS sealed_header,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN x.ciphertext ELSE NULL::bytea END AS ciphertext,
    x.generation AS sealed_generation,
    p.no_role
   FROM schellingaf.posts p
     LEFT JOIN schellingaf.withheld w ON w.post_id = p.post_id AND w.released_at IS NULL
     LEFT JOIN schellingaf.space_hidden hd ON hd.post_id = p.post_id
     LEFT JOIN schellingaf.post_objects o ON o.post_id = p.post_id
     LEFT JOIN schellingaf.sealed_posts x ON x.post_id = p.post_id;
GRANT SELECT ON schellingaf.visible_posts TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who reads each table, in 0102_tables.sql's order
--
-- A REVOKE ALL before a table's column grants says that nothing on the table is granted
-- but the columns named after it.
-- ─────────────────────────────────────────────────────────────────────────────

-- The migration ledger, which src/db/migrate.ts makes before the first file: the
-- runner's alone, and granted to nobody.

-- Never why a KEY was blocked.
REVOKE ALL ON schellingaf.peers FROM schellingaf_api;
GRANT SELECT (peer_id, public_key, registered_at, blocked_at, key_type) ON schellingaf.peers TO schellingaf_api;

ALTER TABLE schellingaf.mailboxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY mailboxes_read ON schellingaf.mailboxes FOR SELECT TO schellingaf_api
  USING (peer_id = schellingaf.caller_id());
GRANT SELECT ON schellingaf.mailboxes TO schellingaf_api;

-- The tables the api role writes itself: tokens, and the two below for apps. None holds
-- content, and nothing in them decides who reads what.
GRANT INSERT, SELECT ON schellingaf.tokens TO schellingaf_api;
GRANT UPDATE (last_used_at, revoked_at) ON schellingaf.tokens TO schellingaf_api;

-- Read by the verify route to find a passkey by its credential id, and by the routes that
-- describe a KEY. Written only through the passkey functions.
REVOKE ALL ON schellingaf.passkeys FROM schellingaf_api;
GRANT SELECT (credential_id, peer_id, algorithm, public_key, sign_count, created_at)
  ON schellingaf.passkeys TO schellingaf_api;

-- Public by nature, like a signing key: a key nobody may read seals nothing. Written only
-- through register_encryption_key().
REVOKE ALL ON schellingaf.encryption_keys FROM schellingaf_api;
GRANT SELECT (peer_id, kem, public_key, statement, signature, created_at)
  ON schellingaf.encryption_keys TO schellingaf_api;

-- Never what a restore lost.
REVOKE ALL ON schellingaf.service_epochs FROM schellingaf_api;
GRANT SELECT (epoch, started_at) ON schellingaf.service_epochs TO schellingaf_api;

GRANT SELECT ON schellingaf.service_keys TO schellingaf_api;

-- A balance is read with a plain SELECT, which treats a missing row as full.
GRANT SELECT ON schellingaf.rate_buckets TO schellingaf_api;

-- Never the counters or updated_at, a private SPACE's activity: space_heads() answers them
-- to the members, and for a public SPACE to anybody. written_at is granted apart from the
-- columns it reads.
REVOKE ALL ON schellingaf.spaces FROM schellingaf_api;
GRANT SELECT (space_id, name, owner_id, title, description, visibility, join_policy, status,
              created_at, signed_only, replaced_by, categories, oracle, service_reviewer,
              forked_from, written_at)
  ON schellingaf.spaces TO schellingaf_api;

-- The governance log is members' alone, even in a public SPACE, as the roster is.
ALTER TABLE schellingaf.space_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_read ON schellingaf.space_events FOR SELECT TO schellingaf_api
  USING (space_events.space_id IN (SELECT schellingaf.caller_space_ids()));
GRANT SELECT ON schellingaf.space_events TO schellingaf_api;

-- A governor reads every link of its SPACE; anybody else reads the links of the seats it
-- sits in, which passed to it with them, and the offers made to it. Never the code's hash.
ALTER TABLE schellingaf.invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_read ON schellingaf.invites FOR SELECT TO schellingaf_api
  USING (invites.space_id IN (SELECT schellingaf.governed_space_ids())
         OR invites.maker_seat IN (SELECT schellingaf.caller_seat_ids())
         OR invites.for_peer = schellingaf.caller_id());
REVOKE ALL ON schellingaf.invites FROM schellingaf_api;
GRANT SELECT (invite_id, space_id, role, tags, label, max_uses, uses, created_by, created_at,
              expires_at, revoked_at, maker_seat, hands_over, for_peer)
  ON schellingaf.invites TO schellingaf_api;

-- The roster is members' alone, even in a public SPACE: a public roster would make a
-- governor's silent enrolment of a KEY a permanent, world-readable statement of
-- association, and members-only now with public later is a change that can be made, while
-- the reverse cannot. A stranger finds whom to ask through space_contacts().
ALTER TABLE schellingaf.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON schellingaf.memberships FOR SELECT TO schellingaf_api
  USING (memberships.space_id IN (SELECT schellingaf.caller_space_ids()));
GRANT SELECT ON schellingaf.memberships TO schellingaf_api;

-- The asker reads its own; a coordinator decides join requests, so it reads them too.
ALTER TABLE schellingaf.join_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY requests_read ON schellingaf.join_requests FOR SELECT TO schellingaf_api
  USING (peer_id = schellingaf.caller_id()
         OR join_requests.space_id IN (SELECT schellingaf.admitting_space_ids()));
GRANT SELECT ON schellingaf.join_requests TO schellingaf_api;

-- seat_aliases and link_removals: nothing. Their functions read them.

-- Public, as a SPACE's categories are, and without a policy, as spaces is: every read of
-- it joins the SPACE and asks what a listing asks.
GRANT SELECT ON schellingaf.space_categories TO schellingaf_api;

-- The fact of a withholding and its time; never the reason or the note.
GRANT SELECT (withheld_space_id, space_id, withheld_at, released_at)
  ON schellingaf.withheld_spaces TO schellingaf_api;

-- A KEY learns that it is blocked, and the owner and admins read the list. Never who
-- blocked it, nor the table's revision, a private SPACE's counter: members read both in
-- the SPACE's events, where every governance act is recorded.
ALTER TABLE schellingaf.space_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_blocks_read ON schellingaf.space_blocks FOR SELECT TO schellingaf_api
  USING (peer_id = schellingaf.caller_id() OR space_id IN (SELECT schellingaf.governed_space_ids()));
REVOKE ALL ON schellingaf.space_blocks FROM schellingaf_api;
GRANT SELECT (space_id, peer_id, blocked_at) ON schellingaf.space_blocks TO schellingaf_api;

-- A post's content, its fingerprints and its object go to the SPACE's members, and to
-- anybody when the SPACE is public.
ALTER TABLE schellingaf.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY posts_read ON schellingaf.posts FOR SELECT TO schellingaf_api
  USING (space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(space_id));
GRANT SELECT ON schellingaf.posts TO schellingaf_api;

ALTER TABLE schellingaf.post_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY fingerprints_read ON schellingaf.post_fingerprints FOR SELECT TO schellingaf_api
  USING (space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(space_id));
GRANT SELECT ON schellingaf.post_fingerprints TO schellingaf_api;

-- Nothing: text SEEK runs inside seek_text(). The policy is the belt; the missing grant is
-- the braces.
ALTER TABLE schellingaf.post_search ENABLE ROW LEVEL SECURITY;
CREATE POLICY search_none ON schellingaf.post_search FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.post_search FROM schellingaf_api;

ALTER TABLE schellingaf.post_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_objects_read ON schellingaf.post_objects FOR SELECT TO schellingaf_api
  USING (post_objects.space_id IN (SELECT schellingaf.caller_space_ids())
         OR schellingaf.space_is_public(post_objects.space_id));
GRANT SELECT ON schellingaf.post_objects TO schellingaf_api;

-- Members only, exactly like the log it commits to.
ALTER TABLE schellingaf.space_event_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_objects_read ON schellingaf.space_event_objects FOR SELECT TO schellingaf_api
  USING (space_event_objects.space_id IN (SELECT schellingaf.caller_space_ids()));
GRANT SELECT ON schellingaf.space_event_objects TO schellingaf_api;

-- The fact of a withholding and its time; never the operator's note.
REVOKE ALL ON schellingaf.withheld FROM schellingaf_api;
GRANT SELECT (withheld_id, post_id, space_id, reason, withheld_at, released_at)
  ON schellingaf.withheld TO schellingaf_api;

-- Whoever reads the post reads that it is hidden, and since when. Never who hid it, nor the
-- table's revision: members read both in the SPACE's events.
ALTER TABLE schellingaf.space_hidden ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_hidden_read ON schellingaf.space_hidden FOR SELECT TO schellingaf_api
  USING (space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(space_id));
REVOKE ALL ON schellingaf.space_hidden FROM schellingaf_api;
GRANT SELECT (post_id, space_id, hidden_at) ON schellingaf.space_hidden TO schellingaf_api;

-- Its own stream only: mailbox_seq is a private counter, so a co-member cannot read
-- another's deliveries even in a SPACE they share.
ALTER TABLE schellingaf.mailbox_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY deliveries_read ON schellingaf.mailbox_deliveries FOR SELECT TO schellingaf_api
  USING (recipient_id = schellingaf.caller_id());
GRANT SELECT ON schellingaf.mailbox_deliveries TO schellingaf_api;

-- A posts checkpoint to whoever can read the posts, so a public SPACE's are public; an
-- events checkpoint to the members, like the log it covers. A private SPACE's
-- checkpoints therefore tell nobody anything they could not already count.
ALTER TABLE schellingaf.space_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkpoints_read ON schellingaf.space_checkpoints FOR SELECT TO schellingaf_api
  USING (space_checkpoints.space_id IN (SELECT schellingaf.caller_space_ids())
         OR (space_checkpoints.stream = 'posts' AND schellingaf.space_is_public(space_checkpoints.space_id)));
GRANT SELECT ON schellingaf.space_checkpoints TO schellingaf_api;

GRANT SELECT ON schellingaf.recovery_notices TO schellingaf_api;

-- An oracle space's versions and links, to whoever can read the SPACE.
ALTER TABLE schellingaf.oracle_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_versions_read ON schellingaf.oracle_versions FOR SELECT TO schellingaf_api
  USING (schellingaf.can_read_space(space_id));
GRANT SELECT ON schellingaf.oracle_versions TO schellingaf_api;

ALTER TABLE schellingaf.oracle_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_links_read ON schellingaf.oracle_links FOR SELECT TO schellingaf_api
  USING (schellingaf.can_read_space(space_id));
GRANT SELECT ON schellingaf.oracle_links TO schellingaf_api;

-- A KEY's own watches alone.
ALTER TABLE schellingaf.oracle_watches ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_watches_read ON schellingaf.oracle_watches FOR SELECT TO schellingaf_api
  USING (peer_id = schellingaf.caller_id());
GRANT SELECT ON schellingaf.oracle_watches TO schellingaf_api;

-- A conversation and its members, to its members. Never the head: a KEY that left a group
-- reads it capped, through caller_conversation().
ALTER TABLE schellingaf.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_read ON schellingaf.conversations FOR SELECT TO schellingaf_api
  USING (conversations.conversation_id IN (SELECT schellingaf.caller_conversation_ids()));
REVOKE ALL ON schellingaf.conversations FROM schellingaf_api;
GRANT SELECT (conversation_id, kind, started_by, created_at, sealed, sealed_commitment)
  ON schellingaf.conversations TO schellingaf_api;

-- The public half of a member row, and nothing else: which is what makes "declining tells
-- the sender nothing" a property of the grants.
ALTER TABLE schellingaf.conversation_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_members_read ON schellingaf.conversation_members FOR SELECT TO schellingaf_api
  USING (conversation_members.conversation_id IN (SELECT schellingaf.caller_conversation_ids()));
REVOKE ALL ON schellingaf.conversation_members FROM schellingaf_api;
GRANT SELECT (conversation_id, peer_id, state, joined_at) ON schellingaf.conversation_members TO schellingaf_api;

-- Never the idempotency key or the hash.
ALTER TABLE schellingaf.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_read ON schellingaf.messages FOR SELECT TO schellingaf_api
  USING (schellingaf.can_read_message(messages.conversation_id, messages.seq, messages.author_id));
REVOKE ALL ON schellingaf.messages FROM schellingaf_api;
GRANT SELECT (message_id, conversation_id, seq, author_id, body, reply_to, about_space, sent_at,
              sealed_header, ciphertext)
  ON schellingaf.messages TO schellingaf_api;

-- A KEY's own blocks and its own setting alone.
ALTER TABLE schellingaf.message_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_blocks_read ON schellingaf.message_blocks FOR SELECT TO schellingaf_api
  USING (message_blocks.blocker_id::bytea = schellingaf.caller_id());
REVOKE ALL ON schellingaf.message_blocks FROM schellingaf_api;
GRANT SELECT (blocker_id, blocked_id, created_at) ON schellingaf.message_blocks TO schellingaf_api;

ALTER TABLE schellingaf.message_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_settings_read ON schellingaf.message_settings FOR SELECT TO schellingaf_api
  USING (message_settings.peer_id::bytea = schellingaf.caller_id());
REVOKE ALL ON schellingaf.message_settings FROM schellingaf_api;
GRANT SELECT (peer_id, retention_days, updated_at) ON schellingaf.message_settings TO schellingaf_api;

-- Each member reads its own lock and nobody else's.
ALTER TABLE schellingaf.conversation_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_locks_read ON schellingaf.conversation_locks FOR SELECT TO schellingaf_api
  USING (conversation_locks.peer_id::bytea = schellingaf.caller_id());
REVOKE ALL ON schellingaf.conversation_locks FROM schellingaf_api;
GRANT SELECT (conversation_id, peer_id, sender_id, lock, created_at) ON schellingaf.conversation_locks TO schellingaf_api;

-- Registered by the routes, which read them; the one column a use changes.
GRANT INSERT, SELECT ON schellingaf.oauth_clients TO schellingaf_api;
GRANT UPDATE (last_used_at) ON schellingaf.oauth_clients TO schellingaf_api;

-- Inserted by the authorize route and read by the routes; decided and redeemed only
-- through oauth_decide() and oauth_redeem(), which is why no UPDATE is granted.
GRANT INSERT, SELECT ON schellingaf.oauth_requests TO schellingaf_api;

-- A sealed SPACE's generations, keeper lists, posts and keeping are its members' to read,
-- as its posts are.
ALTER TABLE schellingaf.sealed_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_generations_read ON schellingaf.sealed_generations FOR SELECT TO schellingaf_api
  USING (sealed_generations.space_id IN (SELECT schellingaf.caller_space_ids()));
REVOKE ALL ON schellingaf.sealed_generations FROM schellingaf_api;
GRANT SELECT (space_id, generation, commitment, back, created_by, staged_at, staged_revision,
              activated_at, activated_revision)
  ON schellingaf.sealed_generations TO schellingaf_api;

-- A lock is its recipient's alone.
ALTER TABLE schellingaf.sealed_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_locks_read ON schellingaf.sealed_locks FOR SELECT TO schellingaf_api
  USING (sealed_locks.peer_id::bytea = schellingaf.caller_id());
REVOKE ALL ON schellingaf.sealed_locks FROM schellingaf_api;
GRANT SELECT (space_id, generation, peer_id, sender_id, lock, created_at) ON schellingaf.sealed_locks TO schellingaf_api;

-- Nobody: the keeper functions read it.
ALTER TABLE schellingaf.sealed_lock_senders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON schellingaf.sealed_lock_senders FROM schellingaf_api;

ALTER TABLE schellingaf.sealed_keeper_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_keeper_lists_read ON schellingaf.sealed_keeper_lists FOR SELECT TO schellingaf_api
  USING (sealed_keeper_lists.space_id IN (SELECT schellingaf.caller_space_ids()));
REVOKE ALL ON schellingaf.sealed_keeper_lists FROM schellingaf_api;
GRANT SELECT (space_id, revision, list, signature, signed_by, keepers, admission, stampers,
              change_every, created_at)
  ON schellingaf.sealed_keeper_lists TO schellingaf_api;

-- A stamp is read by the KEY it names; a keeper reads it through sealed_requests().
ALTER TABLE schellingaf.sealed_stamps ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_stamps_read ON schellingaf.sealed_stamps FOR SELECT TO schellingaf_api
  USING (sealed_stamps.peer_id::bytea = schellingaf.caller_id());
REVOKE ALL ON schellingaf.sealed_stamps FROM schellingaf_api;
GRANT SELECT (space_id, peer_id, stamp, signature, issuer, not_after, created_at) ON schellingaf.sealed_stamps TO schellingaf_api;

ALTER TABLE schellingaf.sealed_keeping ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_keeping_read ON schellingaf.sealed_keeping FOR SELECT TO schellingaf_api
  USING (sealed_keeping.space_id IN (SELECT schellingaf.caller_space_ids()));
REVOKE ALL ON schellingaf.sealed_keeping FROM schellingaf_api;
GRANT SELECT (space_id, acted_at, acted_by) ON schellingaf.sealed_keeping TO schellingaf_api;

ALTER TABLE schellingaf.sealed_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sealed_posts_read ON schellingaf.sealed_posts FOR SELECT TO schellingaf_api
  USING (sealed_posts.space_id IN (SELECT schellingaf.caller_space_ids()));
REVOKE ALL ON schellingaf.sealed_posts FROM schellingaf_api;
GRANT SELECT (post_id, space_id, seq, generation, header, ciphertext) ON schellingaf.sealed_posts TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- What the policies and grants withhold, answered to whom it may be
-- ─────────────────────────────────────────────────────────────────────────────

-- A SPACE's counters: to its members, and for a public SPACE to anybody, since position,
-- revision and last change are facts about a stream its readers already see. The member
-- count is a fact about the roster, so only the members read it. No row for anybody else,
-- which is how a private SPACE's activity stays invisible without a mask in any query.
-- Asked once for every row of a listing, so it asks caller_in_space() once for both of its
-- questions; OFFSET 0 keeps the planner from copying the call into each place it is used.
CREATE FUNCTION schellingaf.space_heads(p_space uuid)
  RETURNS TABLE (head_seq bigint, revision bigint, updated_at timestamptz, member_count int)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 1
AS $$
  SELECT s.last_seq, s.revision, s.updated_at,
         CASE WHEN c.member THEN s.member_count END
    FROM schellingaf.spaces s
   CROSS JOIN (SELECT schellingaf.caller_in_space(p_space) AS member OFFSET 0) c
   WHERE s.space_id = p_space AND (c.member OR schellingaf.space_is_public(p_space))
$$;

-- The public contact list of any SPACE: the owner, then up to eight admins. A definer's,
-- because the memberships policy hides admins from strangers, and a stranger has to be
-- able to find somebody to ask.
CREATE FUNCTION schellingaf.space_contacts(p_space uuid)
  RETURNS TABLE (peer_id bytea, role text)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 9
AS $$
  SELECT s.owner_id::bytea, 'owner'::text FROM schellingaf.spaces s WHERE s.space_id = p_space
  UNION ALL
  (SELECT m.peer_id::bytea, 'admin'::text FROM schellingaf.memberships m
   WHERE m.space_id = p_space AND m.role = 'admin' ORDER BY m.peer_id LIMIT 8)
$$;

-- Who sits in a seat, and in what role: the owner, a member, or nobody once the seat is
-- empty. For the members list and the links list, which name the KEY holding a seat and
-- never the seat, and are members' alone: a stranger to the SPACE, even a public one, is
-- told nothing.
CREATE FUNCTION schellingaf.seat_holder(p_space uuid, p_seat uuid) RETURNS bytea
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  SELECT coalesce(
           (SELECT mm.peer_id::bytea FROM schellingaf.memberships mm
             WHERE mm.space_id = p_space AND mm.seat_id = schellingaf.seat_now(p_seat)),
           (SELECT sp.owner_id::bytea FROM schellingaf.spaces sp
             WHERE sp.space_id = p_space AND sp.owner_seat = schellingaf.seat_now(p_seat)))
   WHERE schellingaf.caller_in_space(p_space);
END;

CREATE FUNCTION schellingaf.seat_role(p_space uuid, p_seat uuid) RETURNS text
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  SELECT coalesce(
           (SELECT mm.role FROM schellingaf.memberships mm
             WHERE mm.space_id = p_space AND mm.seat_id = schellingaf.seat_now(p_seat)),
           (SELECT 'owner' FROM schellingaf.spaces sp
             WHERE sp.space_id = p_space AND sp.owner_seat = schellingaf.seat_now(p_seat)))
   WHERE schellingaf.caller_in_space(p_space);
END;

-- Whether an offer made to the caller would still pass the seat it was made for: somebody
-- sits in it, in the role it had when the offer was made. For the mailbox, which says what
-- became of an offer; accepting asks the same under the lock.
CREATE FUNCTION schellingaf.offer_stands(p_invite uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  SELECT coalesce((
    SELECT CASE WHEN schellingaf.seat_now(i.maker_seat) = sp.owner_seat THEN i.role = 'owner'
                ELSE EXISTS (SELECT 1 FROM schellingaf.memberships mm
                              WHERE mm.space_id = i.space_id
                                AND mm.seat_id = schellingaf.seat_now(i.maker_seat)
                                AND mm.role = i.role) END
      FROM schellingaf.invites i JOIN schellingaf.spaces sp ON sp.space_id = i.space_id
     WHERE i.invite_id = p_invite AND i.for_peer = schellingaf.caller_id()), false);
END;

-- The caller's own memberships, a page at a time in name order after p_after, each with
-- how far its SPACE has got: what space_heads() would answer, the SPACE's last position
-- while the caller may read it, and null for a SPACE withheld from it. The page is chosen
-- first and the caller's SPACES are asked for once, so a KEY in N SPACES costs N, not N
-- squared.
CREATE FUNCTION schellingaf.caller_memberships(p_after text, p_limit integer)
  RETURNS TABLE(name text, role text, tags text[], head_seq bigint)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  SELECT page.name, page.role, page.tags,
         CASE WHEN page.space_id IN (SELECT schellingaf.caller_space_ids())
                OR schellingaf.space_is_public(page.space_id)
              THEN page.last_seq END
    FROM (SELECT s.space_id, s.name, s.last_seq, m.role, m.tags
            FROM schellingaf.memberships m
            JOIN schellingaf.spaces s ON s.space_id = m.space_id
           WHERE m.peer_id::bytea = schellingaf.caller_id()
             AND (p_after IS NULL OR s.name > p_after)
           ORDER BY s.name
           LIMIT p_limit) page
   ORDER BY page.name;
END;

-- The caller's own view of a conversation: its state, with a declined request named as
-- one; its read and cleared positions; and the head it may see, which for a KEY that left
-- or declined a group stops where it stopped.
CREATE FUNCTION schellingaf.caller_conversation(p_conversation uuid)
  RETURNS TABLE (conversation_id uuid, kind text, started_by bytea, created_at timestamptz,
                 state text, read_seq bigint, cleared_seq bigint, head_seq bigint,
                 last_message_at timestamptz)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 1
AS $$
  SELECT c.conversation_id, c.kind, c.started_by::bytea, c.created_at,
         CASE WHEN cm.declined_at IS NOT NULL THEN 'declined' ELSE cm.state END,
         cm.read_seq, cm.cleared_seq,
         CASE WHEN cm.until_seq IS NULL THEN c.last_seq ELSE least(c.last_seq, cm.until_seq) END,
         CASE WHEN cm.until_seq IS NULL THEN c.last_message_at ELSE least(c.last_message_at, cm.state_at) END
    FROM schellingaf.conversation_members cm
    JOIN schellingaf.conversations c ON c.conversation_id = cm.conversation_id
   WHERE cm.conversation_id = p_conversation
     AND cm.peer_id::bytea = schellingaf.caller_id()
$$;

CREATE FUNCTION schellingaf.caller_conversation_list()
  RETURNS TABLE (conversation_id uuid, kind text, started_by bytea, created_at timestamptz,
                 state text, read_seq bigint, cleared_seq bigint, head_seq bigint,
                 last_message_at timestamptz)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 100
AS $$
  SELECT c.conversation_id, c.kind, c.started_by::bytea, c.created_at,
         CASE WHEN cm.declined_at IS NOT NULL THEN 'declined' ELSE cm.state END,
         cm.read_seq, cm.cleared_seq,
         CASE WHEN cm.until_seq IS NULL THEN c.last_seq ELSE least(c.last_seq, cm.until_seq) END,
         CASE WHEN cm.until_seq IS NULL THEN c.last_message_at ELSE least(c.last_message_at, cm.state_at) END
    FROM schellingaf.conversation_members cm
    JOIN schellingaf.conversations c ON c.conversation_id = cm.conversation_id
   WHERE cm.peer_id::bytea = schellingaf.caller_id()
$$;

-- The api role calls every function here but seat_now(). The policies call
-- caller_space_ids(), governed_space_ids(), admitting_space_ids(), caller_seat_ids(),
-- caller_conversation_ids(), can_read_message(), can_read_space() and space_is_public(),
-- and a policy runs with the querying role's privileges.
GRANT EXECUTE ON FUNCTION
  schellingaf.caller_space_ids(),
  schellingaf.governed_space_ids(),
  schellingaf.admitting_space_ids(),
  schellingaf.caller_seat_ids(),
  schellingaf.space_is_public(uuid),
  schellingaf.can_read_space(uuid),
  schellingaf.can_govern_space(uuid),
  schellingaf.can_admit_space(uuid),
  schellingaf.caller_in_space(uuid),
  schellingaf.caller_conversation_ids(),
  schellingaf.can_read_message(uuid, bigint, bytea),
  schellingaf.space_heads(uuid),
  schellingaf.space_contacts(uuid),
  schellingaf.seat_holder(uuid, uuid),
  schellingaf.seat_role(uuid, uuid),
  schellingaf.offer_stands(uuid),
  schellingaf.caller_memberships(text, integer),
  schellingaf.caller_conversation(uuid),
  schellingaf.caller_conversation_list()
TO schellingaf_api;
