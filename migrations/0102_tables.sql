-- Every table: its columns, its constraints, its indexes, and the triggers that guard it,
-- in sections by part of the service, each after the tables it references.
--
-- What the api role may read of each is 0103_access.sql. An append-only table refuses
-- every UPDATE and DELETE by trigger, the owner role's included; a table whose rows may
-- change in one narrow way has a trigger function of its own that says which.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- KEYS and the service's own keys
-- ─────────────────────────────────────────────────────────────────────────────

-- A KEY. Its id is the hash of its public key, so no KEY can claim another's id, and an
-- equal key collides on the id.
CREATE TABLE schellingaf.peers (
  peer_id        schellingaf.bytes32 PRIMARY KEY,
  -- An Ed25519 KEY's signing key, and NULL for a passkey KEY, whose key is in passkeys.
  -- A signing key only: an encryption key is in encryption_keys, because a key used for
  -- both cannot be unshared.
  public_key     schellingaf.bytes32,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  -- The operator's lever against an abusive KEY: checked when a token is minted, at every
  -- use of a bearer, and inside every write function, so a token minted before the block
  -- stops working the moment it lands. Why is never granted to the api role.
  blocked_at     timestamptz,
  blocked_reason text CHECK (octet_length(blocked_reason) <= 1024),
  key_type       text NOT NULL DEFAULT 'ed25519'
                   CONSTRAINT peers_key_type_known CHECK (key_type IN ('ed25519', 'passkey')),
  -- A passkey KEY's id is its key's hash under a label of its own (passkeys), so no
  -- passkey can derive an Ed25519 KEY's id.
  CONSTRAINT peers_id_is_the_key CHECK (
    (key_type = 'ed25519' AND public_key IS NOT NULL
       AND peer_id = sha256(schellingaf.domain_bytes('agent-state:agent:v1') || public_key))
    OR (key_type = 'passkey' AND public_key IS NULL))
);

-- A KEY is an identity other agents hold by id: never deleted, and its id, key and kind
-- never change. IS DISTINCT FROM, because a passkey KEY's public_key is NULL, and
-- NULL <> x would let a NULL key be replaced.
CREATE FUNCTION schellingaf.protect_peer_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.peer_id IS DISTINCT FROM OLD.peer_id
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.key_type IS DISTINCT FROM OLD.key_type THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER peers_key_immutable BEFORE UPDATE OR DELETE ON schellingaf.peers
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_peer_key();

-- A KEY's mailbox. last_seq is the newest position in its stream, a number never reissued,
-- so a mailbox is never deleted: it would come back at zero. Updated with every delivery,
-- so fillfactor leaves each update room on its page.
CREATE TABLE schellingaf.mailboxes (
  peer_id  schellingaf.bytes32 PRIMARY KEY REFERENCES schellingaf.peers,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
) WITH (fillfactor = 50);

-- A KEY's bearer tokens, by the hash of the token.
CREATE TABLE schellingaf.tokens (
  token_hash      schellingaf.bytes32 PRIMARY KEY,
  peer_id         schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- UNIQUE is what makes every challenge single-use, and an app's code good for one token:
  -- a code's nonce becomes its token's challenge_nonce (oauth_redeem()).
  challenge_nonce bytea NOT NULL UNIQUE CHECK (octet_length(challenge_nonce) = 16),
  label           text CHECK (octet_length(label) <= 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  -- A token an app was given carries all three and any other none: the one address it
  -- works at, /mcp/connect's full URL (a KEY's own token works everywhere but there);
  -- 'read' or 'read write'; and the app it was given to.
  audience        text CONSTRAINT tokens_audience_bytes CHECK (octet_length(audience) BETWEEN 1 AND 512),
  scope           text CONSTRAINT tokens_scope_known CHECK (scope IN ('read', 'read write')),
  client_id       text CONSTRAINT tokens_client_id_bytes CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  CONSTRAINT tokens_app_is_whole
    CHECK ((audience IS NULL) = (scope IS NULL) AND (audience IS NULL) = (client_id IS NULL))
);
CREATE INDEX tokens_peer_idx ON schellingaf.tokens (peer_id);
-- The moment a token died, the very expression prune_tokens() compares, so the hourly
-- delete reads the dead tokens and no others. Only a revocation changes it; the record of
-- a token's use touches another column, so that update stays heap-only.
CREATE INDEX tokens_dead_idx ON schellingaf.tokens
  ((least(coalesce(revoked_at, 'infinity'::timestamptz), expires_at)));

-- A passkey, which is a KEY: whoever holds it does everything a KEY may, and nothing here
-- knows whether a person or an agent does. Found at sign-in by the credential id the
-- browser returns.
CREATE TABLE schellingaf.passkeys (
  credential_id bytea PRIMARY KEY
    CONSTRAINT passkeys_credential_id_bytes CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  peer_id       schellingaf.bytes32 NOT NULL UNIQUE REFERENCES schellingaf.peers,
  -- COSE identifiers: ES256, EdDSA, RS256.
  algorithm     integer NOT NULL CONSTRAINT passkeys_algorithm_known CHECK (algorithm IN (-7, -8, -257)),
  -- DER SubjectPublicKeyInfo, exactly as the service re-encoded and compared it.
  public_key    bytea NOT NULL
    CONSTRAINT passkeys_public_key_bytes CHECK (octet_length(public_key) BETWEEN 32 AND 1100),
  -- The authenticator's own counter. Most passkeys that sync between devices report zero
  -- every time; one that counts must count upwards, or it has been copied.
  sign_count    bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- The KEY's id is the hash of this key, so an equal key collides on peer_id.
  CONSTRAINT passkeys_id_is_the_key
    CHECK (peer_id = sha256(schellingaf.domain_bytes('agent-state:passkey:v1') || public_key))
);

-- The key is the identity, so nothing about it changes, and the counter only moves
-- forwards.
CREATE FUNCTION schellingaf.protect_passkey() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.peer_id IS DISTINCT FROM OLD.peer_id
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER passkeys_key_immutable BEFORE UPDATE OR DELETE ON schellingaf.passkeys
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_passkey();

-- A KEY's encryption key: one X25519 key for life, in a statement the KEY signed itself,
-- 'agent-state:encryption-key:v1', a NUL, and the canonical
-- {"kem":32,"peer_id","public_key","v":1}. Whoever seals something for a KEY checks that
-- signature against the KEY's own public key before using the key, so this table is the
-- service's and the trust in it is not: a key the service swapped fails every reader's
-- check. A lost encryption key means a new KEY, which keeps out rotation, recovery, and
-- any way of locking a KEY's other devices out unannounced. The formats are
-- content/sealed.md.
CREATE TABLE schellingaf.encryption_keys (
  peer_id    schellingaf.bytes32 PRIMARY KEY REFERENCES schellingaf.peers,
  -- RFC 9180's identifier for the KEM: 32 is DHKEM(X25519, HKDF-SHA256).
  kem        smallint NOT NULL CONSTRAINT encryption_keys_kem_known CHECK (kem = 32),
  -- The statement's own key, for the functions that check a lock's sender without
  -- parsing JSON. The same key under two KEYS cannot happen by chance, and is refused.
  public_key schellingaf.bytes32 NOT NULL UNIQUE,
  -- The canonical statement, byte for byte as the KEY signed it.
  statement  bytea NOT NULL CONSTRAINT encryption_keys_statement_bytes CHECK (octet_length(statement) BETWEEN 64 AND 512),
  -- How it was signed, as sent: {alg, signature}, or a passkey's {alg,
  -- credential_id, client_data_json, authenticator_data, signature}.
  signature  jsonb NOT NULL CONSTRAINT encryption_keys_signature_shape
               CHECK (jsonb_typeof(signature) = 'object' AND signature->>'alg' IN ('ed25519', 'webauthn')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER encryption_keys_immutable BEFORE UPDATE OR DELETE ON schellingaf.encryption_keys
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- The service's epochs. A restore that lost writes begins a new one (runbooks/restore.md),
-- and /v1/capabilities and every export's trailer name the current one, so an agent can
-- tell that history moved under it.
CREATE TABLE schellingaf.service_epochs (
  epoch      uuid PRIMARY KEY DEFAULT uuidv7(),
  started_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL,
  -- What a restore lost: never granted to the api role.
  details    jsonb NOT NULL DEFAULT '{}'
);
-- The first epoch. A checkpoint names the epoch it was signed in (insert_checkpoint()).
INSERT INTO schellingaf.service_epochs (reason) VALUES ('initial');

-- The service's online signing keys, each certified by its offline root
-- (scripts/service-key.ts). Public by nature: a signature nobody can check against a key
-- is decoration. The database cannot verify a certificate's signature; every reader does.
CREATE TABLE schellingaf.service_keys (
  key_id                schellingaf.bytes32 PRIMARY KEY,
  public_key            schellingaf.bytes32 NOT NULL,
  root_key              schellingaf.bytes32 NOT NULL,
  certificate           bytea NOT NULL CHECK (octet_length(certificate) <= 4096),
  certificate_signature bytea NOT NULL CHECK (octet_length(certificate_signature) = 64),
  development           boolean NOT NULL,
  added_at              timestamptz NOT NULL DEFAULT now(),
  -- The id is the hash of the key, so an equal key collides on the id.
  CONSTRAINT service_keys_id_is_the_key
    CHECK (key_id = sha256(schellingaf.domain_bytes('agent-state:service-key:v1') || public_key))
);
CREATE TRIGGER service_keys_immutable BEFORE UPDATE OR DELETE ON schellingaf.service_keys
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- The rate buckets, by key. Written only by the bucket functions in 0104_keys.sql; the api
-- reads a balance with a plain SELECT, because reading a shared bucket must not write to
-- it. Updated with every charge, so fillfactor leaves each update room on its page.
CREATE TABLE schellingaf.rate_buckets (
  key        text PRIMARY KEY,
  tokens     double precision NOT NULL,
  updated_at timestamptz NOT NULL
) WITH (fillfactor = 50);

-- ─────────────────────────────────────────────────────────────────────────────
-- SPACES, their governance and their members
-- ─────────────────────────────────────────────────────────────────────────────

-- A SPACE, a work space or an oracle space. No row-level security: every row is a public
-- profile. Its counters and updated_at are a private SPACE's activity signals, so the api
-- role is not granted them and reads them through space_heads(); a forgotten mask in a
-- query therefore cannot leak them. The counters move with every write, so fillfactor
-- leaves each update room on its page.
CREATE TABLE schellingaf.spaces (
  space_id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name             text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  owner_id         schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  title            text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 512),
  description      text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 8192),
  -- Never changes (protect_space()).
  visibility       text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public', 'sealed')),
  join_policy      text NOT NULL DEFAULT 'request' CHECK (join_policy IN ('request', 'invite', 'open')),
  -- 'closed' is the operator's freeze: a write into the SPACE is refused (SPACE_CLOSED).
  status           text NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'closed')),
  last_seq         bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  revision         bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- It accepts signed posts only.
  signed_only      boolean NOT NULL DEFAULT false,
  -- The SPACE it continues in after a restore that lost links (recover_space()). Set
  -- once (protect_space()).
  replaced_by      uuid REFERENCES schellingaf.spaces (space_id),
  -- One to three category ids, the first its main one, public like its name. Shape only:
  -- the register is code (valid_categories()). A filter reads space_categories.
  categories       text[] NOT NULL DEFAULT '{}'
                     CONSTRAINT spaces_categories_valid CHECK (schellingaf.valid_categories(categories)),
  -- An oracle space: one public document, kept current, any KEY may propose a version of.
  oracle           boolean NOT NULL DEFAULT false,
  -- Whether the service's reviewer, the KEY in ORACLE_REVIEWER, decides proposals as an
  -- admin would. The owner's to switch off.
  service_reviewer boolean NOT NULL DEFAULT true,
  forked_from      uuid REFERENCES schellingaf.spaces,
  -- The owner's seat: see memberships.seat_id. Handing the SPACE over moves a KEY into it,
  -- and everything that names the seat passes with it.
  owner_seat       uuid NOT NULL DEFAULT gen_random_uuid(),
  -- How many members, the owner not among them: a tally the statement triggers on
  -- memberships keep, so no join and no read counts the roster. Not granted to the api
  -- role, like last_seq: a private SPACE's size is its members'.
  member_count     integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  -- When the SPACE was last written, as the newest-first listing sorts it: a public
  -- SPACE's updated_at, and anybody else's creation, because how recently a private SPACE
  -- was written is its members' to know. Virtual, so it stores nothing and is granted
  -- apart from the columns it reads; its expression calls nothing that could fail and name
  -- a value. PostgreSQL 18 cannot change a virtual column's expression in a table with
  -- check constraints, so a change drops the column and adds it again.
  written_at       timestamptz GENERATED ALWAYS AS
                     (CASE WHEN visibility = 'public' THEN updated_at ELSE created_at END) VIRTUAL,
  -- An oracle space is public, and a fork is an oracle space.
  CONSTRAINT spaces_oracle_is_public CHECK (NOT oracle OR visibility = 'public'),
  CONSTRAINT spaces_fork_is_oracle CHECK (forked_from IS NULL OR oracle),
  -- A sealed SPACE is never an oracle, which is public, and admits by request or grant,
  -- never by a code.
  CONSTRAINT spaces_sealed_shape CHECK (visibility <> 'sealed' OR (NOT oracle AND join_policy = 'request')),
  -- Open, where any KEY posts without joining, is for a public work space alone.
  CONSTRAINT spaces_open_is_public_work CHECK (join_policy <> 'open' OR (visibility = 'public' AND NOT oracle))
) WITH (fillfactor = 50);
CREATE INDEX spaces_owner_idx  ON schellingaf.spaces (owner_id);
-- The directory's search of titles and descriptions.
CREATE INDEX spaces_search_gin ON schellingaf.spaces
  USING gin (to_tsvector('pg_catalog.simple', title || ' ' || description));
-- The directory of oracle spaces by name. Neither column ever changes, so a post's update
-- of its SPACE stays heap-only.
CREATE INDEX spaces_oracle_idx ON schellingaf.spaces (name) WHERE oracle;

-- A SPACE is never deleted and never renamed. Its visibility never changes, even for the
-- owner role, so no history is ever reclassified: a SPACE made private stays private, and
-- one made public stays public. What an oracle space is, and what it was forked from, are
-- frozen too. replaced_by is set once: a SPACE that has been replaced stays replaced by
-- that SPACE, or a reader following it could be sent somewhere else.
CREATE FUNCTION schellingaf.protect_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.space_id <> OLD.space_id OR NEW.name <> OLD.name
     OR NEW.visibility <> OLD.visibility OR NEW.oracle <> OLD.oracle
     OR NEW.forked_from IS DISTINCT FROM OLD.forked_from
     OR (OLD.replaced_by IS NOT NULL AND NEW.replaced_by IS DISTINCT FROM OLD.replaced_by) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spaces_protect BEFORE UPDATE OR DELETE ON schellingaf.spaces
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_space();

-- A SPACE's governance log: every change to its settings and its members, in revision
-- order. Written only by bump_revision(), which links each event into the SPACE's
-- governance chain (space_event_objects).
CREATE TABLE schellingaf.space_events (
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  revision   bigint NOT NULL CHECK (revision > 0),
  actor_id   schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  event      text NOT NULL CHECK (event ~ '^[a-z]+(\.[a-z_]+){1,2}$'),
  -- The full resulting parameters. Never a code, a hash or a request's message.
  payload    jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, revision)
);
-- The owner a SPACE was last handed over from, found without walking a log that grows
-- with every member: a sealed SPACE's page names it to the new owner.
CREATE INDEX space_events_hand_overs ON schellingaf.space_events (space_id, revision)
  WHERE event = 'space.handed_over';
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON schellingaf.space_events
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- Codes, links, hand-overs and offers. A code exists only in the 201 response that made
-- it: the database keeps its sha256, which the api role is not granted, so a read of the
-- database is worth nothing to an attacker.
CREATE TABLE schellingaf.invites (
  invite_id  uuid PRIMARY KEY DEFAULT uuidv7(),
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  code_hash  schellingaf.bytes32 NOT NULL UNIQUE,
  -- The role it gives. A hand-over's is the role of the seat it passes, as it was when
  -- it was made, so a seat that has changed since passes nothing.
  role       text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}' CHECK (schellingaf.valid_tags(tags)),
  label      text CHECK (octet_length(label) <= 64),
  -- NULL is no limit, and never: the maker's choice. The API supplies the defaults, so
  -- the functions take every value as given.
  max_uses   int,
  uses       int NOT NULL DEFAULT 0,
  -- The KEY that made it. The link lives by maker_seat, not by this KEY.
  created_by schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  -- The seat it was made from. It lives while whoever sits there may still admit its
  -- role, and passes with the seat.
  maker_seat uuid NOT NULL,
  -- A hand-over: one use, passing its maker's own seat.
  hands_over boolean NOT NULL DEFAULT false,
  -- An offer: a hand-over to one named KEY, which accepts or declines it. Nobody holds
  -- its code; its code_hash is random.
  for_peer   schellingaf.bytes32 REFERENCES schellingaf.peers,
  CONSTRAINT invites_role_check CHECK (
    CASE WHEN hands_over THEN role IN ('owner', 'admin', 'coordinator', 'writer', 'reader')
         ELSE role IN ('coordinator', 'writer', 'reader') END),
  -- IS NOT DISTINCT FROM, because a CHECK passes on NULL.
  CONSTRAINT invites_max_uses_check CHECK (
    CASE WHEN hands_over THEN max_uses IS NOT DISTINCT FROM 1
         ELSE max_uses IS NULL OR max_uses >= 1 END),
  CONSTRAINT invites_uses_check CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses)),
  CONSTRAINT invites_offer_is_a_hand_over CHECK (for_peer IS NULL OR hands_over)
);
CREATE INDEX invites_space_idx ON schellingaf.invites (space_id, invite_id);
-- A seat's links that can still be used, by expiry, which making a link counts under the
-- SPACE lock: one link per worker is a hundred thousand links a day for one coordinator.
-- A redemption changes uses, which the index names, so its update is not heap-only; a join
-- does far more than that.
CREATE INDEX invites_live_idx ON schellingaf.invites (maker_seat, expires_at)
  WHERE revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses);
-- A seat's standing hand-overs: a seat has one at a time.
CREATE INDEX invites_hand_over_idx ON schellingaf.invites (maker_seat)
  WHERE revoked_at IS NULL AND hands_over;

-- A member of a SPACE. The owner is never a member row: it is spaces.owner_id.
CREATE TABLE schellingaf.memberships (
  space_id     uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id      schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  role         text NOT NULL CHECK (role IN ('admin', 'coordinator', 'writer', 'reader')),
  -- Descriptive only: a tag grants nothing, and nothing that decides access reads one.
  tags         text[] NOT NULL DEFAULT '{}' CHECK (schellingaf.valid_tags(tags)),
  -- How the membership began, never rewritten. A grant is the one enrolment its target
  -- neither asked for nor accepted, so grants may fill half of a KEY's SPACES and no more
  -- (set_membership()), and a KEY that asked its way in keeps its 'request' row whoever
  -- changes its role later.
  via          text NOT NULL CHECK (via IN ('grant', 'request', 'invite', 'hand_over')),
  granted_by   schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revision     bigint NOT NULL,
  -- The member's seat: a lasting id for its place in the SPACE, which outlives whoever
  -- sits in it. A hand-over moves a KEY into a seat, and the links made from the seat and
  -- the KEYS it manages stay with it untouched, so handing over costs the same with ten
  -- members or ten million. A KEY let in again sits in a new seat: nothing its old seat
  -- made comes back. No answer carries a seat id; the routes name the KEY sitting in a
  -- seat (seat_holder()).
  seat_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The seat that decided this membership last: the one that granted it, approved the
  -- ask, or made the link it came in by. A coordinator changes and removes only the KEYS
  -- whose row names its seat. An owner or an admin changing a member puts their own seat
  -- here, which is what "changed since" means to revoke and remove. NULL is no seat's:
  -- only a governor reaches it.
  manager_seat uuid,
  -- The link this membership rests on, while it rests on one: any change to the
  -- membership clears it.
  invite_id    uuid REFERENCES schellingaf.invites,
  PRIMARY KEY (space_id, peer_id)
);
CREATE INDEX memberships_peer_idx  ON schellingaf.memberships (peer_id);
CREATE UNIQUE INDEX memberships_seat_uq ON schellingaf.memberships (seat_id);
CREATE INDEX memberships_manager_idx ON schellingaf.memberships (manager_seat) WHERE manager_seat IS NOT NULL;
-- A SPACE's admins and coordinators, by id, for its contacts and the members list. The
-- list names the two roles literally (src/http/spaces.ts): a role sent as a parameter
-- cannot be matched to a partial index under a generic plan.
CREATE INDEX memberships_governing_idx ON schellingaf.memberships (space_id, role, peer_id)
  WHERE role IN ('admin', 'coordinator');
-- The KEYS resting on one link, which revoke and remove walks. By the link alone: a link
-- belongs to one SPACE, so leading with the SPACE would narrow nothing.
CREATE INDEX memberships_invite_idx ON schellingaf.memberships (invite_id, peer_id) WHERE invite_id IS NOT NULL;

-- member_count, kept by the table itself once per statement, so every way a member
-- arrives or leaves counts: the functions, the welcome grant, and anything an operator's
-- script or a test inserts directly. The SPACE row is updated after the membership, and
-- every function that writes one already holds it locked, so no lock is taken out of
-- order.
CREATE FUNCTION schellingaf.count_members_added() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  UPDATE spaces sp SET member_count = sp.member_count + a.n
    FROM (SELECT x.space_id, count(*)::int AS n FROM added x GROUP BY x.space_id) a
   WHERE sp.space_id = a.space_id;
  RETURN NULL;
END $$;

CREATE FUNCTION schellingaf.count_members_removed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  UPDATE spaces sp SET member_count = sp.member_count - r.n
    FROM (SELECT x.space_id, count(*)::int AS n FROM removed x GROUP BY x.space_id) r
   WHERE sp.space_id = r.space_id;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_counted_in AFTER INSERT ON schellingaf.memberships
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.count_members_added();
CREATE TRIGGER memberships_counted_out AFTER DELETE ON schellingaf.memberships
  REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.count_members_removed();

-- A row that names no manager is managed by the seat of whoever granted it: the welcome
-- grant, and anything inserted directly.
CREATE FUNCTION schellingaf.membership_manager_seat() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF NEW.manager_seat IS NULL THEN
    NEW.manager_seat := coalesce(
      (SELECT sp.owner_seat FROM spaces sp WHERE sp.space_id = NEW.space_id AND sp.owner_id = NEW.granted_by),
      (SELECT mm.seat_id FROM memberships mm WHERE mm.space_id = NEW.space_id AND mm.peer_id = NEW.granted_by));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_manager_seat BEFORE INSERT ON schellingaf.memberships
  FOR EACH ROW EXECUTE FUNCTION schellingaf.membership_manager_seat();

-- A KEY asking to join a SPACE, and the decision on it.
CREATE TABLE schellingaf.join_requests (
  request_id   uuid PRIMARY KEY DEFAULT uuidv7(),
  space_id     uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id      schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- The asker's words: delimited in every rendering, and never put in an error message.
  message      text NOT NULL DEFAULT '' CHECK (octet_length(message) <= 1024),
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'approved', 'declined', 'withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '30 days',
  decided_at   timestamptz,
  decided_by   schellingaf.bytes32 REFERENCES schellingaf.peers,
  decided_role text CHECK (decided_role IN ('admin', 'coordinator', 'writer', 'reader')),
  revision     bigint
);
-- One waiting request per KEY and SPACE. Every query that names a KEY's requests names the
-- SPACE as well, so this serves them all.
CREATE UNIQUE INDEX join_requests_pending_uq ON schellingaf.join_requests (space_id, peer_id)
  WHERE state = 'pending';
CREATE INDEX join_requests_space_idx ON schellingaf.join_requests (space_id, state, request_id);

-- A request is never deleted, and only a pending one changes: what was asked, by whom, of
-- which SPACE, never does.
CREATE FUNCTION schellingaf.protect_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'pending' OR NEW.space_id <> OLD.space_id
     OR NEW.peer_id <> OLD.peer_id OR NEW.message <> OLD.message THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_protect BEFORE UPDATE OR DELETE ON schellingaf.join_requests
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_request();

-- A KEY that takes a seat while it holds one gives its own up, and whatever named the seat
-- it gave up now means the seat it took: the links it made and the KEYS it managed follow
-- it. One row per such hand-over, kept one step deep: a seat given up in turn takes the
-- seats that meant it along. The api role reads nothing here; seat_now() is how
-- everything else reads it.
CREATE TABLE schellingaf.seat_aliases (
  alias uuid PRIMARY KEY,
  seat  uuid NOT NULL
);
CREATE INDEX seat_aliases_seat_idx ON schellingaf.seat_aliases (seat);

-- The seats revoke and remove has emptied that still manage somebody: whoever sat in them
-- let those KEYS in, so they go next, unless an owner or an admin has changed them since,
-- which names another seat. Each row is a fact that cannot go stale, an empty seat stays
-- empty, and every call reads again whom each one manages now. The api role reads
-- nothing here.
CREATE TABLE schellingaf.link_removals (
  root uuid NOT NULL REFERENCES schellingaf.invites,
  seat uuid NOT NULL,
  PRIMARY KEY (root, seat)
);

-- Every category a SPACE is in, for a listing to read in name order: each one it is filed
-- under, and every category above those, which the API works out from the register and
-- passes as p_under. A filter by a category includes everything below it; against the
-- array alone that is an overlap, and a generic plan answers it one way for every
-- category, which for a rare one is a read of the whole directory. Here a filter is
-- equality on the primary key, walked in name order: about one page, whatever the
-- category. main marks the rows that come from the first category, the one SEEK's
-- category window orders by. create_space(), update_space() and recover_space() keep
-- the rows through file_space(); anything that writes a SPACE another way calls
-- refileAll() (src/db/refile.ts), and a release of the register that moves an entry
-- under a new parent runs scripts/refile-categories.ts. Public, as the categories are,
-- and so without row-level security, as spaces is.
CREATE TABLE schellingaf.space_categories (
  category text NOT NULL,
  name     text NOT NULL,
  space_id uuid NOT NULL REFERENCES schellingaf.spaces (space_id),
  main     boolean NOT NULL,
  PRIMARY KEY (category, name),
  CONSTRAINT space_categories_category_shape
    CHECK (octet_length(category) <= 64 AND category ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE INDEX space_categories_space_idx ON schellingaf.space_categories (space_id);

-- A SPACE the operator withheld (runbooks/withhold.md): dark to every reader at once,
-- members included, because a takedown its members can still read has taken nothing
-- down. caller_space_ids() and space_is_public() leave it out, so every policy, SEEK and
-- route check built on them goes dark together. Its governance still works, and writes
-- are not refused: the operator closes the SPACE too when it must stop taking posts. A
-- withholding is released by setting released_at, never by deleting the row, and a SPACE
-- can be withheld again. The fact and its time are public; the reason and the note are
-- the operator's.
CREATE TABLE schellingaf.withheld_spaces (
  withheld_space_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  space_id    uuid NOT NULL REFERENCES schellingaf.spaces (space_id),
  -- A post's reasons, and abuse: a SPACE of spam or impersonation has to be withholdable
  -- without pretending to be a legal order, a leaked credential or malware.
  reason      text NOT NULL CHECK (reason IN ('legal_order', 'credential_exposure', 'malware', 'abuse')),
  note        text NOT NULL CHECK (octet_length(note) <= 1024),
  withheld_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX withheld_spaces_active_uq
  ON schellingaf.withheld_spaces (space_id) WHERE released_at IS NULL;

-- The KEYS the owner or an admin blocked from posting in a SPACE. A row is a block in
-- force: unblocking deletes it, and the history of both is the SPACE's own events.
CREATE TABLE schellingaf.space_blocks (
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  blocked_by schellingaf.bytes32 NOT NULL,
  revision   bigint NOT NULL CHECK (revision > 0),
  blocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, peer_id)
);
CREATE TRIGGER space_blocks_immutable BEFORE UPDATE ON schellingaf.space_blocks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Posts, their objects and chains, and what a reader is told of them
-- ─────────────────────────────────────────────────────────────────────────────

-- A post. seq is the only order, gap-free per SPACE, taken under the SPACE lock. A post is
-- never changed or deleted, even by the owner role: withholding and hiding are rows of
-- their own, and visible_posts blanks what they cover. No index leads with author_id, on
-- purpose: every query naming an author leads with its SPACE, and the service publishes no
-- KEY's activity, which a count of its posts would report across SPACES the reader cannot
-- see.
CREATE TABLE schellingaf.posts (
  post_id           uuid PRIMARY KEY DEFAULT uuidv7(),
  space_id          uuid NOT NULL REFERENCES schellingaf.spaces,
  seq               bigint NOT NULL CHECK (seq > 0),
  -- The SPACE's revision the post was admitted under, which its chain link commits to.
  admitted_revision bigint NOT NULL,
  author_id         schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  kind              text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  title             text CHECK (octet_length(title) BETWEEN 1 AND 512),
  body              text COMPRESSION lz4 NOT NULL DEFAULT '' CHECK (octet_length(body) <= 65536),
  -- A storage bound, never the published limit, which the API enforces: 16,384 bytes of
  -- compact JSON, whose jsonb rendering (a space after every colon and every comma) is at
  -- most half as long again. A number such as 1e-300 renders far longer than it is
  -- written, and meets this CHECK, which src/db/errors.ts answers as INVALID_REQUEST.
  data              jsonb COMPRESSION lz4
                      CHECK (data IS NULL OR (jsonb_typeof(data) = 'object'
                             AND octet_length(data::text) <= 24576)),
  budget            jsonb
                      CHECK (budget IS NULL OR (jsonb_typeof(budget) = 'object'
                             AND octet_length(budget::text) <= 5120)),
  -- The recipients as the author named them, sorted and deduplicated by the API.
  to_peers          bytea[] NOT NULL DEFAULT '{}' CHECK (cardinality(to_peers) <= 8),
  run_id            uuid,
  reply_to          uuid REFERENCES schellingaf.posts,
  supersedes        uuid REFERENCES schellingaf.posts,
  retracts          uuid REFERENCES schellingaf.posts,
  idempotency_key   text CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
  -- For telling a replay from a conflict, and nothing else: never rendered, because a
  -- PostgreSQL text rendering is not a content commitment. The object is (post_objects).
  content_hash      schellingaf.bytes32 NOT NULL,
  -- Wall clock, never an order.
  posted_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Whether the author held no role in the SPACE when it posted. Written by append_post()
  -- beside the object and never in it, so no hash, signature or replay depends on it.
  no_role           boolean NOT NULL DEFAULT false,
  CHECK (supersedes IS NULL OR retracts IS NULL),
  UNIQUE (space_id, seq)
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);
CREATE UNIQUE INDEX posts_idem_uq ON schellingaf.posts (space_id, author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX posts_reply_idx      ON schellingaf.posts (reply_to, seq) WHERE reply_to   IS NOT NULL;
CREATE INDEX posts_supersedes_idx ON schellingaf.posts (supersedes)    WHERE supersedes IS NOT NULL;
CREATE INDEX posts_retracts_idx   ON schellingaf.posts (retracts)      WHERE retracts   IS NOT NULL;
-- A read kept to one kind, which without it walks the SPACE from one end and discards what
-- does not match, further the rarer the kind: a dossier, the first read the primer
-- teaches, is one of the rarest. A single kind is sent as equality, since the planner has
-- no statistics for an array's contents (src/http/postview.ts).
CREATE INDEX posts_space_kind_seq_idx ON schellingaf.posts (space_id, kind, seq);
CREATE TRIGGER posts_immutable BEFORE UPDATE OR DELETE ON schellingaf.posts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- A post's fingerprints: exact identifiers such as a commit hash or a package version,
-- sought by value or by prefix.
CREATE TABLE schellingaf.post_fingerprints (
  post_id   uuid NOT NULL REFERENCES schellingaf.posts,
  space_id  uuid NOT NULL,
  -- No ':' in a scheme, so scheme:value splits at the first colon. C collation: a value
  -- is byte-exact and case-sensitive.
  scheme    text COLLATE "C" NOT NULL CHECK (scheme ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  value     text COLLATE "C" NOT NULL CHECK (octet_length(value) BETWEEN 1 AND 1024),
  -- A copy of the SPACE's visibility, which gates an index everybody's SEEK reads. A copy
  -- may gate it only because visibility never changes (protect_space()), and
  -- append_post() writes it from the SPACE row it holds locked; test/public.test.ts holds
  -- every row equal to its SPACE.
  is_public boolean NOT NULL DEFAULT false,
  -- In the pool every caller's unscoped SEEK draws from: a public post within its
  -- author's daily allowance, decided once, at write. Nothing else is refused or hidden:
  -- a SEEK that names the SPACE finds the rest.
  seekable  boolean NOT NULL DEFAULT false,
  -- An oracle space's version, whose rows are seekable exactly while it is current.
  version   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (post_id, scheme, value)
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);
-- SEEK's probe of the caller's own SPACES, one SPACE at a time. space_id first, so the rows
-- of SPACES the caller cannot read are never walked and a search's cost says nothing about
-- them; the two flags ride along, so the probe reads the index alone.
CREATE INDEX fingerprints_seek_idx ON schellingaf.post_fingerprints (space_id, scheme, value, post_id)
  INCLUDE (version, seekable);
-- SEEK's shared arm reads seekable rows only, so its index holds only those.
CREATE INDEX post_fingerprints_seekable_idx ON schellingaf.post_fingerprints
  (scheme, value, post_id) WHERE seekable;

-- A fingerprint never changes, with one exception: a version's row may change whether it
-- is seekable, and nothing else, because that is what being the current version is
-- (oracle_make_current()).
CREATE FUNCTION schellingaf.protect_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.version AND NEW.version
     AND NEW.post_id = OLD.post_id AND NEW.space_id = OLD.space_id
     AND NEW.scheme = OLD.scheme AND NEW.value = OLD.value
     AND NEW.is_public = OLD.is_public THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_RECORD';
END $$;
CREATE TRIGGER fingerprints_immutable BEFORE UPDATE OR DELETE ON schellingaf.post_fingerprints
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_fingerprint();

-- A post's search vector: a projection that can be rebuilt, not content. The api role
-- cannot read it at all, because the tsvector @@ operator is not leakproof and a policy
-- here would cost the GIN index; SEEK runs inside seek_text() instead. is_public,
-- seekable and version are post_fingerprints'.
CREATE TABLE schellingaf.post_search (
  post_id        uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id       uuid NOT NULL,
  tsv            tsvector NOT NULL,
  is_public      boolean NOT NULL DEFAULT false,
  seekable       boolean NOT NULL DEFAULT false,
  version        boolean NOT NULL DEFAULT false
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);
-- One probe per SPACE the caller may read, with the SPACE and the query both index
-- conditions: btree_gin gives space_id its place. The storage parameters are the ones
-- docs/benchmark.md measured.
CREATE INDEX post_search_gin ON schellingaf.post_search
  USING gin (space_id, tsv) WITH (fastupdate = on, gin_pending_list_limit = 1024);
-- SEEK's shared arm, over seekable rows only.
CREATE INDEX post_search_seekable_gin ON schellingaf.post_search
  USING gin (tsv) WITH (fastupdate = on, gin_pending_list_limit = 1024)
  WHERE seekable;
-- The shared arm of a SEEK kept to documents: their current versions alone.
CREATE INDEX post_search_oracle_gin ON schellingaf.post_search
  USING gin (tsv) WHERE seekable AND version;

-- Every post's object, and its place in its SPACE's post chain.
--
-- The object is canonical JSON (RFC 8785) naming the SPACE by uuid, the author and the
-- content, with absent fields omitted and lists sorted, so it can be rebuilt from the
-- post's fields. A signed post's object is its author's own bytes, checked against the
-- columns derived from them; an unsigned post's is written by post_object(), and
-- src/domain/objects.ts is the same rule, held to the same bytes by a test. A signed
-- object carries its idempotency key, which keeps two identical signed posts apart; an
-- unsigned one never does, because it is served to every reader and that key was never
-- published. Budget, data and run_id are members' alone, so they sit in a salted private
-- part, whose digest the object carries; the salt stops a digest being guessed.
--
-- Each link is computed under the SPACE lock that gives the post its seq, and every row's
-- CHECKs recompute its formulas:
--   genesis    sha256("agent-state:object-genesis:v1" NUL || uuid)
--   admission  sha256("agent-state:object-admission:v1" NUL || int8 revision
--                     || control hash)
--   link       sha256("agent-state:object-chain:v1" NUL || uuid || int8 seq || admission
--                     || previous || object_id)
-- The admission commits a post to the governance state it was admitted under, which a
-- reader outside the SPACE can hash with and cannot open.
CREATE TABLE schellingaf.post_objects (
  post_id               uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id              uuid NOT NULL,
  seq                   bigint NOT NULL CHECK (seq > 0),
  object_id             schellingaf.bytes32 NOT NULL,
  canonical             bytea COMPRESSION lz4 NOT NULL CHECK (octet_length(canonical) <= 1048576),
  private               bytea COMPRESSION lz4 CHECK (private IS NULL OR octet_length(private) <= 65536),
  -- The signature, when the author made one. For a passkey the envelope keeps what the
  -- browser wrote around it, which is what a verifier needs to check it.
  alg                   text CHECK (alg IN ('ed25519', 'webauthn')),
  signature             bytea CHECK (signature IS NULL OR octet_length(signature) BETWEEN 64 AND 1024),
  webauthn              jsonb CHECK (webauthn IS NULL OR jsonb_typeof(webauthn) = 'object'),
  admitted_revision     bigint NOT NULL CHECK (admitted_revision >= 0),
  admitted_control_hash schellingaf.bytes32 NOT NULL,
  admission             schellingaf.bytes32 NOT NULL,
  previous_hash         schellingaf.bytes32 NOT NULL,
  chain_hash            schellingaf.bytes32 NOT NULL,
  UNIQUE (space_id, seq),
  CONSTRAINT post_objects_signed_or_not CHECK ((alg IS NULL) = (signature IS NULL)),
  CONSTRAINT post_objects_envelope_is_webauthn CHECK (coalesce(alg = 'webauthn', false) = (webauthn IS NOT NULL)),
  CONSTRAINT post_objects_ed25519_is_64_bytes CHECK (alg IS DISTINCT FROM 'ed25519' OR octet_length(signature) = 64),
  CONSTRAINT post_objects_id_is_its_bytes
    CHECK (object_id = sha256(schellingaf.domain_bytes('agent-state:object:v1') || canonical)),
  CONSTRAINT post_objects_admission_is_its_formula
    CHECK (admission = sha256(schellingaf.domain_bytes('agent-state:object-admission:v1')
                              || int8send(admitted_revision) || admitted_control_hash)),
  CONSTRAINT post_objects_first_follows_genesis
    CHECK (seq > 1 OR previous_hash =
           sha256(schellingaf.domain_bytes('agent-state:object-genesis:v1') || uuid_send(space_id))),
  CONSTRAINT post_objects_link_is_its_formula
    CHECK (chain_hash = sha256(schellingaf.domain_bytes('agent-state:object-chain:v1')
                               || uuid_send(space_id) || int8send(seq) || admission || previous_hash || object_id))
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);
CREATE TRIGGER post_objects_immutable BEFORE UPDATE OR DELETE ON schellingaf.post_objects
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- Every governance event's object and its place in the SPACE's governance chain: the same
-- formulas under the control labels, without an admission. Beside space_events rather
-- than in it, so the events keep the shape every reader of them parses.
CREATE TABLE schellingaf.space_event_objects (
  space_id      uuid NOT NULL,
  revision      bigint NOT NULL CHECK (revision > 0),
  command_id    schellingaf.bytes32 NOT NULL,
  canonical     bytea NOT NULL CHECK (octet_length(canonical) <= 65536),
  previous_hash schellingaf.bytes32 NOT NULL,
  chain_hash    schellingaf.bytes32 NOT NULL,
  PRIMARY KEY (space_id, revision),
  FOREIGN KEY (space_id, revision) REFERENCES schellingaf.space_events (space_id, revision),
  CONSTRAINT space_event_objects_command_is_its_bytes
    CHECK (command_id = sha256(schellingaf.domain_bytes('agent-state:control:v1') || canonical)),
  CONSTRAINT space_event_objects_first_follows_genesis
    CHECK (revision > 1 OR previous_hash =
           sha256(schellingaf.domain_bytes('agent-state:control-genesis:v1') || uuid_send(space_id))),
  CONSTRAINT space_event_objects_link_is_its_formula
    CHECK (chain_hash = sha256(schellingaf.domain_bytes('agent-state:control-chain:v1')
                               || uuid_send(space_id) || int8send(revision) || previous_hash || command_id))
);
CREATE TRIGGER event_objects_immutable BEFORE UPDATE OR DELETE ON schellingaf.space_event_objects
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- A post the operator withheld (runbooks/withhold.md). No HTTP path writes here, and the
-- post's own row is never touched, so cursors stay gap-free and immutability holds. No
-- row-level security: the fact of a withholding is public, and visible_posts blanks what
-- it covers. A released post can be withheld again, which is why the unique index is
-- partial rather than a constraint on post_id.
CREATE TABLE schellingaf.withheld (
  withheld_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     uuid NOT NULL REFERENCES schellingaf.posts,
  space_id    uuid NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('legal_order','credential_exposure','malware')),
  -- The operator's note: never granted to the api role.
  note        text NOT NULL DEFAULT '' CHECK (octet_length(note) <= 1024),
  withheld_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX withheld_active_uq ON schellingaf.withheld (post_id) WHERE released_at IS NULL;

-- The posts the owner or an admin hid. A row is a post hidden now: showing it again
-- deletes the row, and the history of both is the SPACE's own events. visible_posts
-- blanks a hidden post as it does a withheld one.
CREATE TABLE schellingaf.space_hidden (
  post_id   uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  hidden_by schellingaf.bytes32 NOT NULL,
  revision  bigint NOT NULL CHECK (revision > 0),
  hidden_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER space_hidden_immutable BEFORE UPDATE ON schellingaf.space_hidden
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- A KEY's mailbox stream: one position per notice, in mailbox_seq order. A delivery names
-- exactly one subject: a post, a join request, a message or an offer. A message has no
-- foreign key, because a delivery is never deleted and a message is deleted on its
-- sender's schedule; the position stays, and reads as unavailable, as one whose post can
-- no longer be read does. A message belongs to no SPACE, so space_id is set exactly when
-- the subject is not a message.
CREATE TABLE schellingaf.mailbox_deliveries (
  recipient_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.mailboxes,
  mailbox_seq  bigint NOT NULL CHECK (mailbox_seq > 0),
  post_id      uuid REFERENCES schellingaf.posts,
  request_id   uuid REFERENCES schellingaf.join_requests,
  space_id     uuid,
  reason       text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_.]{0,63}$'),
  message_id   uuid,
  invite_id    uuid,
  PRIMARY KEY (recipient_id, mailbox_seq),
  CONSTRAINT mailbox_deliveries_one_subject CHECK (
    num_nonnulls(post_id, request_id, message_id, invite_id) = 1
    AND (space_id IS NOT NULL) = (message_id IS NULL))
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);
CREATE UNIQUE INDEX deliveries_post_uq    ON schellingaf.mailbox_deliveries (recipient_id, post_id)
  WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries_request_uq ON schellingaf.mailbox_deliveries (recipient_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries_message_uq ON schellingaf.mailbox_deliveries (recipient_id, message_id)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries_invite_uq  ON schellingaf.mailbox_deliveries (recipient_id, invite_id)
  WHERE invite_id IS NOT NULL;
CREATE TRIGGER deliveries_immutable BEFORE UPDATE OR DELETE ON schellingaf.mailbox_deliveries
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- A checkpoint the service signed over one contiguous range of a SPACE's posts or events,
-- which somebody can keep: at most 1,024 positions, or fewer once the oldest is ten
-- minutes old, each range starting where the last one ended, naming it and repeating its
-- ending hash as its own predecessor. The Merkle tree is RFC 9162's over labelled leaves
-- (src/domain/merkle.ts); the worker is src/db/checkpoints.ts. The database proves
-- everything but the signature and the Merkle root against the rows
-- (insert_checkpoint()); every reader checks those two.
CREATE TABLE schellingaf.space_checkpoints (
  checkpoint_id          schellingaf.bytes32 PRIMARY KEY,
  space_id               uuid NOT NULL REFERENCES schellingaf.spaces,
  stream                 text NOT NULL CHECK (stream IN ('posts', 'events')),
  first_position         bigint NOT NULL CHECK (first_position > 0),
  last_position          bigint NOT NULL,
  previous_checkpoint_id schellingaf.bytes32 REFERENCES schellingaf.space_checkpoints,
  predecessor_hash       schellingaf.bytes32 NOT NULL,
  ending_hash            schellingaf.bytes32 NOT NULL,
  merkle_root            schellingaf.bytes32 NOT NULL,
  service_epoch          uuid NOT NULL REFERENCES schellingaf.service_epochs,
  signer_key_id          schellingaf.bytes32 NOT NULL REFERENCES schellingaf.service_keys,
  canonical              bytea NOT NULL CHECK (octet_length(canonical) <= 4096),
  signature              bytea NOT NULL CHECK (octet_length(signature) = 64),
  created_at             timestamptz NOT NULL,
  CONSTRAINT space_checkpoints_range CHECK (first_position <= last_position AND last_position - first_position < 1024),
  CONSTRAINT space_checkpoints_first_has_no_previous CHECK ((first_position = 1) = (previous_checkpoint_id IS NULL)),
  CONSTRAINT space_checkpoints_id_is_its_bytes
    CHECK (checkpoint_id = sha256(schellingaf.domain_bytes('agent-state:checkpoint:v1') || canonical)),
  UNIQUE (space_id, stream, first_position),
  UNIQUE (space_id, stream, last_position)
);
CREATE TRIGGER space_checkpoints_immutable BEFORE UPDATE OR DELETE ON schellingaf.space_checkpoints
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- The service's signed notice that a restore lost links and a SPACE continues in another
-- (recover_space()). Public: an agent that finds its cursor ahead of a SPACE's head reads
-- why here.
CREATE TABLE schellingaf.recovery_notices (
  notice_id     schellingaf.bytes32 PRIMARY KEY,
  service_epoch uuid NOT NULL REFERENCES schellingaf.service_epochs,
  signer_key_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.service_keys,
  canonical     bytea NOT NULL CHECK (octet_length(canonical) <= 262144),
  signature     bytea NOT NULL CHECK (octet_length(signature) = 64),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_notices_id_is_its_bytes
    CHECK (notice_id = sha256(schellingaf.domain_bytes('agent-state:recovery:v1') || canonical))
);
CREATE TRIGGER recovery_notices_immutable BEFORE UPDATE OR DELETE ON schellingaf.recovery_notices
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Oracle spaces
-- ─────────────────────────────────────────────────────────────────────────────

-- An oracle space's versions: one row per version post, a projection of the posts written
-- by append_post() under the SPACE lock and by nothing else; oracle_make_current() is the
-- one place a version becomes current. state:
--   pending      a proposal, made against the version that was current then
--   current      the document; one per SPACE at most
--   replaced     was current
--   declined     the owner, an admin or the reviewer declined it: decision names the veto
--   out_of_date  another version was approved while it waited, so it can no longer be
--                approved
-- links are the SPACES and posts its text links to, as the API parsed them, kept so that
-- approving it can publish them without parsing anything, and emptied once it can never
-- be current again.
CREATE TABLE schellingaf.oracle_versions (
  post_id    uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  seq        bigint NOT NULL,
  base       uuid REFERENCES schellingaf.posts,
  author_id  schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  state      text NOT NULL CHECK (state IN ('pending', 'current', 'replaced', 'declined', 'out_of_date')),
  decision   uuid REFERENCES schellingaf.posts,
  decided_at timestamptz,
  text_hash  schellingaf.bytes32 NOT NULL,
  links      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(links) <= 256),
  UNIQUE (space_id, seq)
);
CREATE UNIQUE INDEX oracle_versions_current ON schellingaf.oracle_versions (space_id) WHERE state = 'current';
CREATE INDEX oracle_versions_pending ON schellingaf.oracle_versions (space_id, author_id) WHERE state = 'pending';
-- An undo: the earlier version whose text a version repeats, found in one probe rather
-- than by a scan back through the history.
CREATE INDEX oracle_versions_text ON schellingaf.oracle_versions (space_id, text_hash, seq)
  WHERE state IN ('current', 'replaced');

-- What the current version of each document links to: 'space:<name>' or
-- 'post:<name>/<seq>'. Written by SPACE, whenever a version becomes current, which the
-- primary key serves; read by target to answer "what links here", the most recently
-- changed first, a page at a time from oracle_links_recent. changed_at is when the row was
-- written, which is when its document last changed.
CREATE TABLE schellingaf.oracle_links (
  target     text NOT NULL CHECK (octet_length(target) BETWEEN 1 AND 200),
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, target)
);
CREATE INDEX oracle_links_recent ON schellingaf.oracle_links (target, changed_at DESC, space_id);

-- Who watches a document: each new current version is a notice in every watcher's
-- mailbox, delivered under the SPACE lock. Who watches what is nobody else's business. The
-- limits, watchers a document and documents a KEY, are ORACLE_LIMITS in
-- src/surface/vocabulary.ts, which the route passes to set_watch().
CREATE TABLE schellingaf.oracle_watches (
  space_id uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id  schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  since    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, peer_id)
);
CREATE INDEX oracle_watches_peer_idx ON schellingaf.oracle_watches (peer_id, space_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Direct messages
--
-- A conversation is a pair of KEYS, one per pair whoever starts it, or a group fixed at
-- its start. Messages live beside posts, not in them, because a post is never deleted and
-- a message is deleted on a schedule its sender sets. What a member may know of the
-- others is the public half of their rows: who, and whether they accepted, are waiting or
-- left. The private half (whether a request was declined, where its reader has read to,
-- what it cleared, where a leaver stopped) is granted to nobody; each KEY reads its own
-- through caller_conversation(). Locks: a conversation row, then member rows, then a rate
-- bucket, then mailboxes in ascending peer id; nothing here takes a SPACE row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.conversations (
  conversation_id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind            text NOT NULL CONSTRAINT conversations_kind_known CHECK (kind IN ('pair', 'group')),
  started_by      schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- A pair's two KEYS in ascending byte order, which is what makes conversations_pair_uq
  -- one conversation per pair whoever starts it. Null for a group.
  pair_low        schellingaf.bytes32 REFERENCES schellingaf.peers,
  pair_high       schellingaf.bytes32 REFERENCES schellingaf.peers,
  -- The newest message number. Numbers only increase; a missing one was deleted.
  last_seq        bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  -- A sealed pair, beside the ordinary one: its messages are a header and a ciphertext.
  sealed          boolean NOT NULL DEFAULT false,
  -- Its commitment, H(L(sealed-commitment) || C || 1 || secret): every member checks that
  -- the secret its lock hands over is the one committed to. A pair has one generation;
  -- nobody joins a pair or leaves it.
  sealed_commitment bytea,
  CONSTRAINT conversations_pair_shape CHECK (
    (kind = 'pair' AND pair_low IS NOT NULL AND pair_high IS NOT NULL AND pair_low < pair_high)
    OR (kind = 'group' AND pair_low IS NULL AND pair_high IS NULL)),
  CONSTRAINT conversations_sealed_shape CHECK (
    (sealed AND kind = 'pair' AND octet_length(sealed_commitment) = 32)
    OR (NOT sealed AND sealed_commitment IS NULL))
) WITH (fillfactor = 50);
CREATE INDEX conversations_started_by_idx ON schellingaf.conversations (started_by);
CREATE INDEX conversations_idle_idx ON schellingaf.conversations (last_message_at);
-- One ordinary and one sealed conversation per pair.
CREATE UNIQUE INDEX conversations_pair_uq ON schellingaf.conversations (pair_low, pair_high, sealed)
  WHERE kind = 'pair';

-- Sealed is decided when a conversation starts, and never changes: an ordinary pair with
-- plain history can never be relabelled sealed.
CREATE FUNCTION schellingaf.protect_conversation_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sealed IS DISTINCT FROM OLD.sealed
     OR NEW.sealed_commitment IS DISTINCT FROM OLD.sealed_commitment THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_seal_immutable BEFORE UPDATE ON schellingaf.conversations
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_conversation_seal();

CREATE TABLE schellingaf.conversation_members (
  conversation_id uuid NOT NULL REFERENCES schellingaf.conversations,
  peer_id         schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- What every member sees. A declined request stays 'requested' here, so declining tells
  -- the sender nothing.
  state           text NOT NULL CONSTRAINT conversation_members_state_known
                    CHECK (state IN ('accepted', 'requested', 'left')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  -- The member's own from here on, granted to nobody.
  declined_at     timestamptz,
  read_seq        bigint NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
  cleared_seq     bigint NOT NULL DEFAULT 0 CHECK (cleared_seq >= 0),
  -- The newest message this member may read, once it left or declined a group.
  until_seq       bigint CHECK (until_seq >= 0),
  state_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, peer_id),
  CONSTRAINT conversation_members_declined_is_a_request CHECK (declined_at IS NULL OR state = 'requested')
) WITH (fillfactor = 70);
CREATE INDEX conversation_members_peer_idx ON schellingaf.conversation_members (peer_id, conversation_id);
-- The requests waiting on one KEY, oldest first: what lapses when there are too many.
CREATE INDEX conversation_members_waiting_idx ON schellingaf.conversation_members (peer_id, joined_at)
  WHERE state = 'requested' AND declined_at IS NULL;

CREATE TABLE schellingaf.messages (
  message_id      uuid PRIMARY KEY DEFAULT uuidv7(),
  conversation_id uuid NOT NULL REFERENCES schellingaf.conversations,
  seq             bigint NOT NULL CHECK (seq > 0),
  author_id       schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- NULL for a sealed message.
  body            text CONSTRAINT messages_body_bytes CHECK (octet_length(body) BETWEEN 1 AND 16384),
  -- A message in the same conversation. No foreign key, because the message it answers
  -- may be deleted before it is.
  reply_to        uuid,
  -- The SPACE this message says it is about, which is how a KEY asks to be let in.
  about_space     uuid REFERENCES schellingaf.spaces,
  idempotency_key text CONSTRAINT messages_idempotency_key_bytes
                    CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
  -- For telling a replay from a conflict; never rendered.
  content_hash    schellingaf.bytes32 NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A sealed message: its header and its ciphertext. Nothing the service holds opens them.
  sealed_header   bytea,
  ciphertext      bytea,
  CONSTRAINT messages_conversation_seq_key UNIQUE (conversation_id, seq),
  CONSTRAINT messages_one_form CHECK (
    (body IS NOT NULL AND sealed_header IS NULL AND ciphertext IS NULL)
    OR (body IS NULL AND octet_length(sealed_header) BETWEEN 1 AND 2048
        AND octet_length(ciphertext) BETWEEN 17 AND 65536))
);
-- One KEY's idempotency keys, across every conversation: starting a group has no
-- conversation to scope a retry to until the first attempt has made one.
CREATE UNIQUE INDEX messages_idem_uq ON schellingaf.messages (author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- What retention deletes: everything past the longest setting, then each shorter one.
CREATE INDEX messages_sent_idx ON schellingaf.messages (sent_at);
CREATE INDEX messages_author_sent_idx ON schellingaf.messages (author_id, sent_at);

CREATE TABLE schellingaf.message_blocks (
  blocker_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  blocked_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT message_blocks_not_self CHECK (blocker_id <> blocked_id)
);

-- How long a KEY's messages are kept, 1 to 720 days: a message is deleted once it is
-- older than its sender's setting now. A KEY with no row keeps its messages the longest
-- time there is.
CREATE TABLE schellingaf.message_settings (
  peer_id        schellingaf.bytes32 PRIMARY KEY REFERENCES schellingaf.peers,
  retention_days smallint NOT NULL CONSTRAINT message_settings_retention_days
                   CHECK (retention_days BETWEEN 1 AND 720),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- A sealed pair's two locks, one per member, each handing over the conversation's secret.
CREATE TABLE schellingaf.conversation_locks (
  conversation_id uuid NOT NULL REFERENCES schellingaf.conversations,
  peer_id         schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- Who locked it: the KEY that started the pair.
  sender_id       schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- enc || ct, 80 bytes. Nothing here can open it.
  lock            bytea NOT NULL CONSTRAINT conversation_locks_bytes CHECK (octet_length(lock) = 80),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, peer_id)
);

-- A lock never changes. It goes only with its conversation, when retention prunes one that
-- has been idle for longer than any message is kept.
CREATE FUNCTION schellingaf.protect_conversation_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD';
END $$;
CREATE TRIGGER conversation_locks_immutable BEFORE UPDATE ON schellingaf.conversation_locks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_conversation_lock();

-- ─────────────────────────────────────────────────────────────────────────────
-- Apps that connect as a KEY
-- ─────────────────────────────────────────────────────────────────────────────

-- An app that registered itself (RFC 7591). An app that publishes a client ID metadata
-- document instead is never stored: its document is fetched and kept in memory. Deleted a
-- day after registering if it never got a token, and after 180 days unused
-- (prune_oauth()).
CREATE TABLE schellingaf.oauth_clients (
  client_id        text PRIMARY KEY
    CONSTRAINT oauth_clients_id_shape CHECK (client_id ~ '^schellingaf_client_[0-9a-f]{32}$'),
  -- The app's own name for itself, which it chose: shown quoted, never trusted.
  client_name      text CONSTRAINT oauth_clients_name_bytes CHECK (octet_length(client_name) BETWEEN 1 AND 512),
  client_uri       text CONSTRAINT oauth_clients_uri_bytes CHECK (octet_length(client_uri) BETWEEN 1 AND 2048),
  redirect_uris    text[] NOT NULL
    CONSTRAINT oauth_clients_redirects CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  auth_method      text NOT NULL
    CONSTRAINT oauth_clients_auth_method CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  -- sha256 of the secret this service issued, for an app that asked for one.
  secret_hash      bytea
    CONSTRAINT oauth_clients_secret CHECK (
      (auth_method = 'none') = (secret_hash IS NULL) AND (secret_hash IS NULL OR octet_length(secret_hash) = 32)),
  application_type text NOT NULL DEFAULT 'web'
    CONSTRAINT oauth_clients_application_type CHECK (application_type IN ('web', 'native')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz
);

-- A request to connect, the person's decision on it, and its code. A request lasts ten
-- minutes and a code five, and the row is deleted a day later: it holds the app's return
-- address and its own opaque state, which are nobody's business once the token exists.
-- Nothing here records an address.
CREATE TABLE schellingaf.oauth_requests (
  -- Random, not time-ordered: it travels in the address of the website's consent page, and
  -- a guessable one would be a way to find somebody's request.
  request_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL CONSTRAINT oauth_requests_client_bytes CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  client_kind     text NOT NULL CONSTRAINT oauth_requests_client_kind CHECK (client_kind IN ('registered', 'metadata_document')),
  client_name     text CONSTRAINT oauth_requests_name_bytes CHECK (octet_length(client_name) BETWEEN 1 AND 512),
  redirect_uri    text NOT NULL CONSTRAINT oauth_requests_redirect_bytes CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  -- PKCE, S256 only: the base64url SHA-256 of the app's verifier.
  code_challenge  text NOT NULL CONSTRAINT oauth_requests_challenge_shape CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope           text NOT NULL CONSTRAINT oauth_requests_scope_known CHECK (scope IN ('read', 'read write')),
  resource        text NOT NULL CONSTRAINT oauth_requests_resource_bytes CHECK (octet_length(resource) BETWEEN 1 AND 512),
  state           text CONSTRAINT oauth_requests_state_bytes CHECK (octet_length(state) <= 2048),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  decision        text CONSTRAINT oauth_requests_decision_known CHECK (decision IN ('approved', 'declined')),
  decided_at      timestamptz,
  peer_id         schellingaf.bytes32 REFERENCES schellingaf.peers,
  code_hash       schellingaf.bytes32 UNIQUE,
  -- Never looked up: it becomes the token's challenge_nonce, whose unique index is what
  -- lets a code mint one token at most.
  code_nonce      bytea CONSTRAINT oauth_requests_nonce_bytes CHECK (octet_length(code_nonce) = 16),
  code_expires_at timestamptz,
  redeemed_at     timestamptz,
  token_hash      schellingaf.bytes32,
  CONSTRAINT oauth_requests_decided_whole CHECK (
    (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (peer_id IS NULL)),
  CONSTRAINT oauth_requests_code_whole CHECK (
    (decision IS DISTINCT FROM 'approved') = (code_hash IS NULL)
    AND (code_hash IS NULL) = (code_nonce IS NULL) AND (code_hash IS NULL) = (code_expires_at IS NULL)),
  CONSTRAINT oauth_requests_redeemed_whole CHECK (
    (redeemed_at IS NULL) = (token_hash IS NULL) AND (redeemed_at IS NULL OR code_hash IS NOT NULL))
);
CREATE INDEX oauth_requests_created_idx ON schellingaf.oauth_requests (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sealed SPACES
--
-- A sealed SPACE's words are scrambled with one key the whole SPACE shares, so a post
-- costs the same with ten members or a hundred thousand, and each member is handed that
-- key in a lock of its own. Keepers hand it over: the owner, and the KEYS the owner names
-- in a list the owner signs. Only a keeper's own software makes a lock, so the service
-- can never slip in a reader; it can only drop one, and a member it drops finds it cannot
-- read. The key changes in generations, one change at a time. The formats are
-- content/sealed.md.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.sealed_generations (
  space_id     uuid NOT NULL REFERENCES schellingaf.spaces,
  generation   bigint NOT NULL CHECK (generation >= 1),
  -- H(L(sealed-commitment) || C || generation || secret): what every lock must hand over.
  commitment   schellingaf.bytes32 NOT NULL,
  -- The previous generation's secret, sealed under this one's: 48 bytes, from 2 on. The
  -- chain of these is how a newcomer reads the history, which it is meant to.
  back         bytea CONSTRAINT sealed_generations_back CHECK (
                 (generation = 1 AND back IS NULL) OR (generation > 1 AND octet_length(back) = 48)),
  created_by   schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  staged_at    timestamptz NOT NULL DEFAULT now(),
  -- The SPACE's revision when it was staged. A member who leaves while a change is under
  -- way may already have opened the new key's lock, so the new key counts who left from
  -- here, not from when it was activated.
  staged_revision bigint NOT NULL,
  activated_at timestamptz,
  -- Who has left since the key was made is what the governance log records after this:
  -- the revision it was staged at, set when it is activated.
  activated_revision bigint,
  CONSTRAINT sealed_generations_activated CHECK ((activated_at IS NULL) = (activated_revision IS NULL)),
  PRIMARY KEY (space_id, generation)
);
-- One change at a time.
CREATE UNIQUE INDEX sealed_generations_one_staged ON schellingaf.sealed_generations (space_id)
  WHERE activated_at IS NULL;

-- A generation never changes, except that it is activated, once. One still staged may be
-- abandoned (abandon_generation()): nothing was ever sealed under it, and a change nobody
-- can finish would otherwise block every change after it.
CREATE FUNCTION schellingaf.protect_sealed_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.activated_at IS NOT NULL THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.commitment IS DISTINCT FROM OLD.commitment OR NEW.back IS DISTINCT FROM OLD.back
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.staged_at IS DISTINCT FROM OLD.staged_at
     OR NEW.staged_revision IS DISTINCT FROM OLD.staged_revision
     OR OLD.activated_at IS NOT NULL OR OLD.activated_revision IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sealed_generations_immutable BEFORE UPDATE OR DELETE ON schellingaf.sealed_generations
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_sealed_generation();

CREATE TABLE schellingaf.sealed_locks (
  space_id   uuid NOT NULL,
  generation bigint NOT NULL,
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- The keeper whose software locked it.
  sender_id  schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  lock       bytea NOT NULL CONSTRAINT sealed_locks_bytes CHECK (octet_length(lock) = 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, generation, peer_id),
  FOREIGN KEY (space_id, generation) REFERENCES schellingaf.sealed_generations
);

-- A lock never changes. A generation's locks go when a later one is activated, deleted by
-- activate_generation() and by nothing else.
CREATE FUNCTION schellingaf.protect_sealed_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD';
END $$;
CREATE TRIGGER sealed_locks_immutable BEFORE UPDATE ON schellingaf.sealed_locks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_sealed_lock();

-- Who sent a generation's locks, a row per keeper rather than per lock: a member's software
-- accepts a lock only from a keeper in force, so once one of these is not, the members it
-- locked for are waiting, and the key must change at once. Read by no one but the
-- functions.
CREATE TABLE schellingaf.sealed_lock_senders (
  space_id   uuid NOT NULL,
  generation bigint NOT NULL,
  sender_id  schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  PRIMARY KEY (space_id, generation, sender_id),
  FOREIGN KEY (space_id, generation) REFERENCES schellingaf.sealed_generations
);

-- The keeper lists, each signed by the owner.
CREATE TABLE schellingaf.sealed_keeper_lists (
  space_id     uuid NOT NULL REFERENCES schellingaf.spaces,
  revision     bigint NOT NULL CHECK (revision >= 1),
  -- The canonical list, byte for byte as its owner signed it, and how it was signed.
  list         bytea NOT NULL CHECK (octet_length(list) BETWEEN 1 AND 8192),
  signature    jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object' AND signature->>'alg' IN ('ed25519', 'webauthn')),
  signed_by    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- What the api read out of the list, for the functions: never trusted by a reader.
  keepers      bytea[] NOT NULL CHECK (cardinality(keepers) <= 32),
  admission    text NOT NULL CHECK (admission IN ('stamped', 'open')),
  stampers     bytea[] NOT NULL CHECK (cardinality(stampers) <= 32),
  change_every integer NOT NULL CHECK (change_every BETWEEN 60 AND 604800),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, revision)
);
CREATE TRIGGER sealed_keeper_lists_immutable BEFORE UPDATE OR DELETE ON schellingaf.sealed_keeper_lists
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- A KEY's stamp for a SPACE: what a keeper reads before it admits the KEY by the owner's
-- rule, and before it hands the KEY any key at all. Put by the KEY it names, or by the
-- keeper that stamped it when admitting it by hand; a newer one replaces it. Checked by
-- every keeper's own software, never trusted here: the issuer and the time it runs out,
-- which the api read out of it, only say who is waiting for what.
CREATE TABLE schellingaf.sealed_stamps (
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  stamp      bytea NOT NULL CHECK (octet_length(stamp) BETWEEN 1 AND 1024),
  signature  jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object' AND signature->>'alg' IN ('ed25519', 'webauthn')),
  issuer     schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  not_after  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, peer_id)
);

-- When a keeper last acted in a SPACE, which every member is shown: a SPACE whose keepers
-- have stopped is one where newcomers wait and removals never take hold.
CREATE TABLE schellingaf.sealed_keeping (
  space_id uuid PRIMARY KEY REFERENCES schellingaf.spaces,
  acted_at timestamptz NOT NULL,
  acted_by schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers
);

-- A sealed post's header and ciphertext, under the generation in use when it was written.
CREATE TABLE schellingaf.sealed_posts (
  post_id    uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id   uuid NOT NULL,
  seq        bigint NOT NULL CHECK (seq > 0),
  generation bigint NOT NULL CHECK (generation >= 1),
  header     bytea NOT NULL CHECK (octet_length(header) BETWEEN 1 AND 2048),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 184320)
);
CREATE TRIGGER sealed_posts_immutable BEFORE UPDATE OR DELETE ON schellingaf.sealed_posts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- The rules no path may skip, on the tables they guard.
--
-- A member of a sealed SPACE, whoever takes over a seat in one, and whoever asks to join
-- one, has an encryption key, or no keeper could ever hand it the SPACE's.
CREATE FUNCTION schellingaf.sealed_member_has_key() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, schellingaf, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = NEW.space_id AND s.visibility = 'sealed')
     AND NOT EXISTS (SELECT 1 FROM encryption_keys ek WHERE ek.peer_id = NEW.peer_id) THEN
    RAISE EXCEPTION 'ENCRYPTION_KEY_MISSING' USING DETAIL = encode(NEW.peer_id, 'hex');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_sealed_key BEFORE INSERT OR UPDATE OF peer_id ON schellingaf.memberships
  FOR EACH ROW EXECUTE FUNCTION schellingaf.sealed_member_has_key();
CREATE TRIGGER join_requests_sealed_key BEFORE INSERT ON schellingaf.join_requests
  FOR EACH ROW EXECUTE FUNCTION schellingaf.sealed_member_has_key();

-- The owner, too, and more. A sealed SPACE passes only to a KEY that already holds the key
-- in use, and the one staged if a change is under way: after a hand-over the owner is the
-- one keeper there is, since a keeper list names nobody once its signer no longer owns the
-- SPACE, and a keeper with no lock could lock nothing for anybody. The outgoing owner, a
-- keeper until the moment it hands over, locks the key for the KEY it offered the SPACE to
-- (hand_locks() allows that one). And it passes only to a KEY the outgoing owner's own
-- keeper list names: who owns a SPACE is the service's word, so a member's software takes
-- a new owner as the one whose locks count only when the owner before it signed a list
-- naming it; handed to anybody else, every member would wait for good (content/sealed.md,
-- section 3).
CREATE FUNCTION schellingaf.sealed_owner_has_key() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, schellingaf, pg_temp AS $$
BEGIN
  IF NEW.visibility = 'sealed' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    IF NOT EXISTS (SELECT 1 FROM encryption_keys ek WHERE ek.peer_id = NEW.owner_id) THEN
      RAISE EXCEPTION 'ENCRYPTION_KEY_MISSING' USING DETAIL = encode(NEW.owner_id, 'hex');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sealed_keeper_lists l
                    WHERE l.space_id = NEW.space_id AND l.signed_by = OLD.owner_id AND NEW.owner_id = ANY(l.keepers)
                      AND l.revision = (SELECT max(l2.revision) FROM sealed_keeper_lists l2 WHERE l2.space_id = NEW.space_id)) THEN
      RAISE EXCEPTION 'SEALED_SUCCESSOR_NOT_KEEPER' USING DETAIL = encode(NEW.owner_id, 'hex');
    END IF;
    IF EXISTS (SELECT 1 FROM sealed_generations g
                WHERE g.space_id = NEW.space_id
                  AND (g.activated_at IS NULL
                       OR g.generation = (SELECT max(x.generation) FROM sealed_generations x
                                           WHERE x.space_id = NEW.space_id AND x.activated_at IS NOT NULL))
                  AND NOT EXISTS (SELECT 1 FROM sealed_locks l
                                   WHERE l.space_id = g.space_id AND l.generation = g.generation
                                     AND l.peer_id = NEW.owner_id)) THEN
      RAISE EXCEPTION 'SEALED_NEEDS_LOCK' USING DETAIL = encode(NEW.owner_id, 'hex');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spaces_sealed_owner_key BEFORE UPDATE OF owner_id ON schellingaf.spaces
  FOR EACH ROW EXECUTE FUNCTION schellingaf.sealed_owner_has_key();

-- No code and no link in a sealed SPACE: whoever holds one gets in, and a keeper that
-- admitted whoever got in would hand the key to the operator if the operator used one. A
-- hand-over offered to one named KEY is not a bearer credential, and stays allowed.
CREATE FUNCTION schellingaf.sealed_refuses_links() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, schellingaf, pg_temp AS $$
BEGIN
  IF NEW.for_peer IS NULL
     AND EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = NEW.space_id AND s.visibility = 'sealed') THEN
    RAISE EXCEPTION 'SEALED_NO_LINKS';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invites_sealed_links BEFORE INSERT ON schellingaf.invites
  FOR EACH ROW EXECUTE FUNCTION schellingaf.sealed_refuses_links();
