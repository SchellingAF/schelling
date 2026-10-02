-- Direct messages: a KEY writes to another KEY, or to a fixed group of them.
--
--   * A conversation is a pair, one per pair of KEYS and reused whenever either starts it
--     again, or a group: the starter and up to fifteen others, fixed at the start. Nobody
--     is added or removed; anyone can leave.
--   * Anyone may message anyone, but a KEY that does not know the sender gets the first
--     message as a request, and the sender can send nothing more until it is accepted
--     (knows_key()).
--   * A blocked KEY cannot start a conversation with the blocker or put it in a group, its
--     requests are declined, and its messages are hidden from the blocker. It is told only
--     that its messages are not accepted. A declined sender is told nothing.
--   * A message is deleted once it is older than its sender's retention setting now: 1 to
--     720 days, 720 until the KEY changes it (prune_messages()). Retention is a promise to
--     the sender, not housekeeping.
--   * The KEYS in a conversation can read it, and so can the operator.
--   * Two KEYS that know each other may also hold a sealed pair beside their ordinary one:
--     its messages are a header and a ciphertext, and nothing the service holds opens
--     them. The formats are content/sealed.md.
--
-- The tables are 0102_tables.sql's, where their lock order is, and who reads what is
-- 0103_access.sql's.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal rules, granted to nobody
-- ─────────────────────────────────────────────────────────────────────────────

-- Whether p_recipient knows p_sender, so that a first message goes straight in rather than
-- waiting as a request: a SPACE they share, an accepted pair, or a conversation the
-- recipient started. The welcome SPACE does not count: every KEY is given it, so counting
-- it would make every KEY known to every other. Posting in an open work space makes no
-- membership, so it makes no KEY known.
CREATE FUNCTION schellingaf.knows_key(p_recipient bytea, p_sender bytea, p_welcome_space text)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM schellingaf.memberships m
       WHERE m.peer_id = p_recipient
         AND NOT EXISTS (SELECT 1 FROM schellingaf.spaces w
                          WHERE w.space_id = m.space_id AND w.name = p_welcome_space)
         AND (EXISTS (SELECT 1 FROM schellingaf.memberships m2
                       WHERE m2.space_id = m.space_id AND m2.peer_id = p_sender)
              OR EXISTS (SELECT 1 FROM schellingaf.spaces s
                          WHERE s.space_id = m.space_id AND s.owner_id = p_sender)))
    OR EXISTS (
      SELECT 1 FROM schellingaf.spaces s
       WHERE s.owner_id = p_recipient
         AND s.name IS DISTINCT FROM p_welcome_space
         AND EXISTS (SELECT 1 FROM schellingaf.memberships m2
                      WHERE m2.space_id = s.space_id AND m2.peer_id = p_sender))
    OR EXISTS (
      SELECT 1 FROM schellingaf.conversations c
        JOIN schellingaf.conversation_members cm ON cm.conversation_id = c.conversation_id
       WHERE c.kind = 'pair'
         AND c.pair_low = least(p_recipient, p_sender) AND c.pair_high = greatest(p_recipient, p_sender)
         AND cm.peer_id = p_recipient AND cm.state = 'accepted')
    OR EXISTS (
      SELECT 1 FROM schellingaf.conversations c
        JOIN schellingaf.conversation_members cm ON cm.conversation_id = c.conversation_id
       WHERE c.started_by = p_recipient AND cm.peer_id = p_sender)
$$;

-- A KEY holds at most 200 requests waiting on it. Past that the oldest lapse, exactly as if
-- declined: a flood of strangers cannot bury the requests that arrived first, and cannot
-- grow what one KEY is made to hold.
CREATE FUNCTION schellingaf.make_room_for_request(p_peer bytea)
  RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_waiting int; v_oldest record;
BEGIN
  SELECT count(*)::int INTO v_waiting FROM conversation_members cm
   WHERE cm.peer_id = p_peer AND cm.state = 'requested' AND cm.declined_at IS NULL;
  IF v_waiting < 200 THEN RETURN; END IF;

  FOR v_oldest IN
    SELECT cm.conversation_id, c.kind, c.last_seq
      FROM conversation_members cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
     WHERE cm.peer_id = p_peer AND cm.state = 'requested' AND cm.declined_at IS NULL
     ORDER BY cm.joined_at, cm.conversation_id
     LIMIT v_waiting - 199
     FOR UPDATE OF cm
  LOOP
    UPDATE conversation_members cm
       SET declined_at = now(), state_at = now(),
           until_seq = CASE WHEN v_oldest.kind = 'group' THEN v_oldest.last_seq END
     WHERE cm.conversation_id = v_oldest.conversation_id AND cm.peer_id = p_peer;
  END LOOP;
END $$;

-- A sealed message's header, as far as the database can check it. The api has already read
-- it strictly as canonical JSON of the message shape; this is the part of the check that
-- must hold for every writer: it names the pair, its author, generation 1, and the reply
-- and SPACE the message itself names.
CREATE FUNCTION schellingaf.check_message_header(
  p_header bytea, p_author bytea, p_low bytea, p_high bytea, p_reply_to uuid, p_about text)
  RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE h jsonb;
BEGIN
  BEGIN
    h := convert_from(p_header, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SEALED_HEADER_MISMATCH';
  END;
  IF jsonb_typeof(h) <> 'object'
     OR h->>'type' IS DISTINCT FROM 'message'
     OR h->>'author' IS DISTINCT FROM encode(p_author, 'hex')
     OR h->'generation' IS DISTINCT FROM '1'::jsonb
     OR h->'pair' IS DISTINCT FROM jsonb_build_array(encode(p_low, 'hex'), encode(p_high, 'hex'))
     OR h->>'reply_to' IS DISTINCT FROM p_reply_to::text
     OR h->>'about' IS DISTINCT FROM p_about THEN
    RAISE EXCEPTION 'SEALED_HEADER_MISMATCH';
  END IF;
END $$;

-- One message into a conversation that exists, by the rules every message follows: a
-- sealed conversation takes no plain body and an ordinary one no sealed parts, and the
-- content hash's preimage strips nulls, so every ordinary message and every replay of one
-- hashes the same. Called by send_message(), and by start_conversation() when the pair
-- already exists; the caller has checked that the author is not blocked by the operator.
CREATE FUNCTION schellingaf.send_into_conversation(
  p_conversation uuid, p_author bytea, p_body text, p_reply_to uuid, p_about uuid,
  p_idempotency_key text, p_hash bytea, p_welcome_space text,
  p_about_name text DEFAULT NULL, p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_conv conversations%ROWTYPE; v_me conversation_members%ROWTYPE; v_prior messages%ROWTYPE;
  v_other record; v_recipients bytea[] := '{}'; r bytea;
  v_seq bigint; v_ts timestamptz; v_mid uuid; m bigint; v_delivered jsonb := '[]';
BEGIN
  -- Serialises this conversation. Everything below is under the lock.
  SELECT * INTO v_conv FROM conversations c WHERE c.conversation_id = p_conversation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND'; END IF;

  SELECT * INTO v_me FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_author;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND'; END IF;
  -- Nobody writes in a group it left or declined. A declined pair is different: its
  -- decliner writing again is changing its mind, which accepts it below.
  IF v_me.state = 'left' OR (v_conv.kind = 'group' AND v_me.declined_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CONVERSATION_LEFT';
  END IF;

  -- Replay check after the membership check, so a KEY that left is refused, never replayed.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_prior FROM messages mm
     WHERE mm.author_id = p_author AND mm.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_prior.content_hash <> p_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
      RETURN jsonb_build_object('conversation_id', v_prior.conversation_id, 'kind', v_conv.kind,
                                'created', false, 'message_id', v_prior.message_id,
                                'seq', v_prior.seq::text, 'sent_at', v_prior.sent_at,
                                'replayed', true, 'delivered', '[]'::jsonb);
    END IF;
  END IF;

  -- A sealed conversation takes sealed parts and nothing else; an ordinary one never does.
  IF v_conv.sealed THEN
    IF p_body IS NOT NULL OR p_sealed_header IS NULL OR p_ciphertext IS NULL THEN
      RAISE EXCEPTION 'CONVERSATION_SEALED';
    END IF;
    PERFORM check_message_header(p_sealed_header, p_author, v_conv.pair_low, v_conv.pair_high,
                                 p_reply_to, p_about_name);
  ELSIF p_sealed_header IS NOT NULL OR p_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_SEALED';
  END IF;

  IF p_reply_to IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM messages mm
        WHERE mm.message_id = p_reply_to AND mm.conversation_id = p_conversation) THEN
    RAISE EXCEPTION 'MESSAGE_NOT_FOUND';
  END IF;

  -- Ascending peer id, so the mailboxes below are locked in the one order.
  FOR v_other IN
    SELECT cm.peer_id::bytea AS peer_id, cm.state, cm.declined_at
      FROM conversation_members cm
     WHERE cm.conversation_id = p_conversation AND cm.peer_id <> p_author
     ORDER BY cm.peer_id
  LOOP
    IF v_conv.kind = 'pair' THEN
      IF EXISTS (SELECT 1 FROM message_blocks b
                  WHERE b.blocker_id = v_other.peer_id AND b.blocked_id = p_author) THEN
        RAISE EXCEPTION 'MESSAGES_NOT_ACCEPTED' USING DETAIL = encode(v_other.peer_id, 'hex');
      END IF;
      IF EXISTS (SELECT 1 FROM message_blocks b
                  WHERE b.blocker_id = p_author AND b.blocked_id = v_other.peer_id) THEN
        RAISE EXCEPTION 'BLOCKED_BY_YOU' USING DETAIL = encode(v_other.peer_id, 'hex');
      END IF;
      IF v_other.state = 'requested' THEN
        -- A request still waiting on the other KEY. If the two have come to know
        -- each other since, it would not be a request today, so it no longer
        -- waits. A declined one stays declined: that was an answer.
        IF v_other.declined_at IS NULL AND knows_key(v_other.peer_id, p_author, p_welcome_space) THEN
          UPDATE conversation_members cm
             SET state = 'accepted', state_at = now()
           WHERE cm.conversation_id = p_conversation AND cm.peer_id = v_other.peer_id;
          v_other.state := 'accepted';
        ELSE
          RAISE EXCEPTION 'MESSAGE_REQUEST_WAITING' USING DETAIL = encode(v_other.peer_id, 'hex');
        END IF;
      END IF;
    END IF;

    -- A member still deciding hears nothing more until it accepts, and a KEY
    -- that blocks the author never hears from it.
    IF v_other.state = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM message_blocks b
                        WHERE b.blocker_id = v_other.peer_id AND b.blocked_id = p_author) THEN
      v_recipients := v_recipients || v_other.peer_id;
    END IF;
  END LOOP;

  -- Writing in a conversation accepts it.
  IF v_me.state = 'requested' THEN
    UPDATE conversation_members cm
       SET state = 'accepted', declined_at = NULL, state_at = now()
     WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_author;
  END IF;

  UPDATE conversations c
     SET last_seq = c.last_seq + 1, last_message_at = clock_timestamp()
   WHERE c.conversation_id = p_conversation
  RETURNING c.last_seq, c.last_message_at INTO v_seq, v_ts;

  INSERT INTO messages (conversation_id, seq, author_id, body, reply_to, about_space,
                        idempotency_key, content_hash, sent_at, sealed_header, ciphertext)
  VALUES (p_conversation, v_seq, p_author, p_body, p_reply_to, p_about,
          p_idempotency_key, p_hash, v_ts, p_sealed_header, p_ciphertext)
  RETURNING messages.message_id INTO v_mid;

  -- Your own message is read by you.
  UPDATE conversation_members cm SET read_seq = v_seq
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_author;

  FOREACH r IN ARRAY v_recipients LOOP
    UPDATE mailboxes mb SET last_seq = mb.last_seq + 1 WHERE mb.peer_id = r
    RETURNING mb.last_seq INTO m;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECIPIENT_NOT_REGISTERED' USING DETAIL = encode(r, 'hex');
    END IF;
    INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, message_id, reason)
    VALUES (r, m, v_mid, 'message');
    v_delivered := v_delivered || jsonb_build_object('recipient', encode(r, 'hex'),
                                                     'mailbox_seq', m::text);
  END LOOP;

  RETURN jsonb_build_object('conversation_id', p_conversation, 'kind', v_conv.kind,
                            'created', false, 'message_id', v_mid, 'seq', v_seq::text,
                            'sent_at', v_ts, 'replayed', false, 'delivered', v_delivered);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- What the api calls
-- ─────────────────────────────────────────────────────────────────────────────

-- A conversation with one KEY (a pair) or with two to fifteen (a group), and its first
-- message. A pair that exists already is written into instead. A sealed pair comes with its
-- commitment, its two locks and a sealed first message, and only between KEYS that already
-- know each other, because a stranger's sealed first message could not be read by anybody
-- deciding whether to accept it.
CREATE FUNCTION schellingaf.start_conversation(
  p_starter bytea, p_to bytea[], p_body text, p_about text, p_idempotency_key text,
  p_welcome_space text, p_requests_per_day integer, p_first_day_requests integer,
  p_sealed_commitment bytea DEFAULT NULL, p_lock_peers bytea[] DEFAULT NULL, p_locks bytea[] DEFAULT NULL,
  p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_to bytea[]; h bytea; v_prior messages%ROWTYPE; v_about uuid; r bytea;
  v_conv_id uuid; v_kind text; v_receipt jsonb; v_sealed boolean;
  v_requested bytea[] := '{}'; v_registered timestamptz; v_new_key boolean;
  v_capacity integer; v_take jsonb; v_ts timestamptz; v_mid uuid; m bigint;
  v_delivered jsonb := '[]'; v_existing uuid; i int;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_starter AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;

  -- The api sorts, dedupes and bounds these; checked again because this is the
  -- function that decides.
  v_to := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_to, '{}'::bytea[])) x ORDER BY x);
  IF cardinality(v_to) < 1 OR cardinality(v_to) > 15 OR p_starter = ANY(v_to) THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  v_sealed := p_sealed_header IS NOT NULL;
  IF v_sealed THEN
    -- A sealed start is a pair, with its commitment, a lock for each of the two and
    -- a sealed message, and no plain body.
    IF cardinality(v_to) <> 1 OR p_body IS NOT NULL OR p_ciphertext IS NULL
       OR octet_length(p_sealed_commitment) IS DISTINCT FROM 32
       OR cardinality(p_lock_peers) IS DISTINCT FROM 2 OR cardinality(p_locks) IS DISTINCT FROM 2
       OR NOT (p_starter = ANY(p_lock_peers) AND v_to[1] = ANY(p_lock_peers)) THEN
      RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
  ELSIF p_ciphertext IS NOT NULL OR p_sealed_commitment IS NOT NULL OR p_locks IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- The frozen preimage: nulls stripped, so a later DEFAULT NULL parameter never
  -- changes a stored hash. A sealed start adds its parts, which an ordinary one never has.
  h := sha256(convert_to((
        SELECT coalesce(jsonb_object_agg(k, v), '{}')
          FROM jsonb_each(jsonb_build_object(
                 'to', (SELECT coalesce(jsonb_agg(encode(x, 'hex') ORDER BY x), '[]') FROM unnest(v_to) x),
                 'body', p_body, 'about', p_about,
                 'sealed_commitment', encode(p_sealed_commitment, 'hex'),
                 'locks', CASE WHEN v_sealed THEN (
                            SELECT jsonb_object_agg(encode(p_lock_peers[j], 'hex'), encode(p_locks[j], 'hex'))
                              FROM generate_subscripts(p_lock_peers, 1) j) END,
                 'sealed_header', encode(p_sealed_header, 'hex'),
                 'ciphertext', encode(p_ciphertext, 'hex'))) AS e(k, v)
         WHERE v <> 'null'::jsonb)::text, 'UTF8'));

  -- A retry of a start must find the first attempt, and two retries at once must
  -- not both make a group, so the key is held while it is looked for.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'message:' || encode(p_starter, 'hex') || ':' || p_idempotency_key, 0));
    SELECT * INTO v_prior FROM messages mm
     WHERE mm.author_id = p_starter AND mm.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_prior.content_hash <> h THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
      RETURN jsonb_build_object('conversation_id', v_prior.conversation_id,
                                'kind', (SELECT c.kind FROM conversations c
                                          WHERE c.conversation_id = v_prior.conversation_id),
                                'sealed', (SELECT c.sealed FROM conversations c
                                            WHERE c.conversation_id = v_prior.conversation_id),
                                'created', false, 'message_id', v_prior.message_id,
                                'seq', v_prior.seq::text, 'sent_at', v_prior.sent_at,
                                'replayed', true, 'delivered', '[]'::jsonb);
    END IF;
  END IF;

  FOREACH r IN ARRAY v_to LOOP
    IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = r) THEN
      RAISE EXCEPTION 'RECIPIENT_NOT_REGISTERED' USING DETAIL = encode(r, 'hex');
    END IF;
  END LOOP;

  IF p_about IS NOT NULL THEN
    SELECT sp.space_id INTO v_about FROM spaces sp WHERE sp.name = p_about;
    IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  END IF;

  FOREACH r IN ARRAY v_to LOOP
    IF EXISTS (SELECT 1 FROM message_blocks b WHERE b.blocker_id = r AND b.blocked_id = p_starter) THEN
      RAISE EXCEPTION 'MESSAGES_NOT_ACCEPTED' USING DETAIL = encode(r, 'hex');
    END IF;
    IF EXISTS (SELECT 1 FROM message_blocks b WHERE b.blocker_id = p_starter AND b.blocked_id = r) THEN
      RAISE EXCEPTION 'BLOCKED_BY_YOU' USING DETAIL = encode(r, 'hex');
    END IF;
  END LOOP;

  IF v_sealed THEN
    -- Both KEYS need an encryption key, or nothing could ever be locked for them.
    IF NOT EXISTS (SELECT 1 FROM encryption_keys ek WHERE ek.peer_id = p_starter) THEN
      RAISE EXCEPTION 'ENCRYPTION_KEY_MISSING' USING DETAIL = encode(p_starter, 'hex');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM encryption_keys ek WHERE ek.peer_id = v_to[1]) THEN
      RAISE EXCEPTION 'ENCRYPTION_KEY_MISSING' USING DETAIL = encode(v_to[1], 'hex');
    END IF;
    -- Only between KEYS that already know each other: a stranger starts with an
    -- ordinary message request, which the recipient can read before deciding.
    IF NOT knows_key(v_to[1], p_starter, p_welcome_space) THEN
      RAISE EXCEPTION 'SEALED_NEEDS_ACQUAINTANCE' USING DETAIL = encode(v_to[1], 'hex');
    END IF;
    PERFORM check_message_header(p_sealed_header, p_starter, least(p_starter, v_to[1]),
                                 greatest(p_starter, v_to[1]), NULL, p_about);
    -- The secret was made for this start; a pair that already has one keeps it.
    SELECT c.conversation_id INTO v_existing FROM conversations c
     WHERE c.kind = 'pair' AND c.sealed
       AND c.pair_low = least(p_starter, v_to[1]) AND c.pair_high = greatest(p_starter, v_to[1]);
    IF FOUND THEN
      RAISE EXCEPTION 'SEALED_CONVERSATION_EXISTS' USING DETAIL = v_existing::text;
    END IF;
  END IF;

  IF cardinality(v_to) = 1 THEN
    v_kind := 'pair';
    INSERT INTO conversations (kind, started_by, pair_low, pair_high, last_seq, last_message_at,
                               sealed, sealed_commitment)
    VALUES ('pair', p_starter, least(p_starter, v_to[1]), greatest(p_starter, v_to[1]), 1, clock_timestamp(),
            v_sealed, p_sealed_commitment)
    ON CONFLICT (pair_low, pair_high, sealed) WHERE kind = 'pair' DO NOTHING
    RETURNING conversations.conversation_id, conversations.last_message_at INTO v_conv_id, v_ts;

    IF v_conv_id IS NULL THEN
      -- A sealed pair started by two at once: the second finds the first's.
      IF v_sealed THEN
        SELECT c.conversation_id INTO v_existing FROM conversations c
         WHERE c.kind = 'pair' AND c.sealed
           AND c.pair_low = least(p_starter, v_to[1]) AND c.pair_high = greatest(p_starter, v_to[1]);
        RAISE EXCEPTION 'SEALED_CONVERSATION_EXISTS' USING DETAIL = v_existing::text;
      END IF;
      SELECT c.conversation_id INTO v_conv_id FROM conversations c
       WHERE c.kind = 'pair' AND NOT c.sealed
         AND c.pair_low = least(p_starter, v_to[1]) AND c.pair_high = greatest(p_starter, v_to[1]);
      v_receipt := send_into_conversation(v_conv_id, p_starter, p_body, NULL, v_about,
                                          p_idempotency_key, h, p_welcome_space);
      RETURN v_receipt || jsonb_build_object('sealed', false, 'members', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('peer_id', encode(cm.peer_id, 'hex'),
                                                     'state', cm.state) ORDER BY cm.peer_id), '[]')
          FROM conversation_members cm WHERE cm.conversation_id = v_conv_id));
    END IF;
  ELSE
    v_kind := 'group';
    INSERT INTO conversations (kind, started_by, last_seq, last_message_at)
    VALUES ('group', p_starter, 1, clock_timestamp())
    RETURNING conversations.conversation_id, conversations.last_message_at INTO v_conv_id, v_ts;
  END IF;

  -- Who gets this as a request: every recipient that does not know the starter. A
  -- starter with a request still waiting on a KEY sends it nothing more, in any
  -- conversation, until that KEY accepts. A declined request is still waiting, as
  -- far as the starter can ever tell. A sealed pair never has one: its recipient
  -- knows the starter, as checked above.
  FOREACH r IN ARRAY v_to LOOP
    IF NOT knows_key(r, p_starter, p_welcome_space) THEN
      IF EXISTS (SELECT 1 FROM conversation_members cm
                   JOIN conversations c ON c.conversation_id = cm.conversation_id
                  WHERE c.started_by = p_starter AND cm.peer_id = r AND cm.state = 'requested'
                    AND c.conversation_id <> v_conv_id) THEN
        RAISE EXCEPTION 'MESSAGE_REQUEST_WAITING' USING DETAIL = encode(r, 'hex');
      END IF;
      v_requested := v_requested || r;
    END IF;
  END LOOP;

  -- Requests are the starter's own allowance, a day's and a new KEY's first day's
  -- (MESSAGE_REQUESTS_PER_DAY and FIRST_DAY_MESSAGE_REQUESTS in src/http/messages.ts),
  -- charged only for requests this call actually makes, and rolled back with
  -- everything else when anything below refuses.
  IF cardinality(v_requested) > 0 THEN
    SELECT pe.registered_at INTO v_registered FROM peers pe WHERE pe.peer_id = p_starter;
    v_new_key := v_registered > now() - interval '1 day';
    v_capacity := CASE WHEN v_new_key THEN p_first_day_requests ELSE p_requests_per_day END;
    IF cardinality(v_requested) > v_capacity THEN
      RAISE EXCEPTION 'MESSAGE_REQUEST_LIMIT' USING DETAIL = '86400';
    END IF;
    v_take := take_tokens('msgreq:' || encode(p_starter, 'hex'), v_capacity,
                          CASE WHEN v_new_key THEN 0 ELSE p_requests_per_day / 86400.0 END,
                          cardinality(v_requested));
    IF NOT (v_take->>'allowed')::boolean THEN
      RAISE EXCEPTION 'MESSAGE_REQUEST_LIMIT' USING DETAIL = (
        CASE WHEN v_new_key
             THEN greatest(1, ceil(extract(epoch FROM (v_registered + interval '1 day' - now())))::int)
             ELSE greatest(1, (v_take->>'retry_after_s')::int) END)::text;
    END IF;
  END IF;

  INSERT INTO conversation_members (conversation_id, peer_id, state, read_seq)
  VALUES (v_conv_id, p_starter, 'accepted', 1);
  FOREACH r IN ARRAY v_to LOOP
    IF r = ANY(v_requested) THEN
      PERFORM make_room_for_request(r);
      INSERT INTO conversation_members (conversation_id, peer_id, state)
      VALUES (v_conv_id, r, 'requested');
    ELSE
      INSERT INTO conversation_members (conversation_id, peer_id, state)
      VALUES (v_conv_id, r, 'accepted');
    END IF;
  END LOOP;

  IF v_sealed THEN
    FOR i IN 1 .. 2 LOOP
      INSERT INTO conversation_locks (conversation_id, peer_id, sender_id, lock)
      VALUES (v_conv_id, p_lock_peers[i], p_starter, p_locks[i]);
    END LOOP;
  END IF;

  INSERT INTO messages (conversation_id, seq, author_id, body, reply_to, about_space,
                        idempotency_key, content_hash, sent_at, sealed_header, ciphertext)
  VALUES (v_conv_id, 1, p_starter, p_body, NULL, v_about, p_idempotency_key, h, v_ts,
          p_sealed_header, p_ciphertext)
  RETURNING messages.message_id INTO v_mid;

  -- v_to is ascending, which is the order mailboxes are locked in.
  FOREACH r IN ARRAY v_to LOOP
    UPDATE mailboxes mb SET last_seq = mb.last_seq + 1 WHERE mb.peer_id = r
    RETURNING mb.last_seq INTO m;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECIPIENT_NOT_REGISTERED' USING DETAIL = encode(r, 'hex');
    END IF;
    INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, message_id, reason)
    VALUES (r, m, v_mid, CASE WHEN r = ANY(v_requested) THEN 'message_request' ELSE 'message' END);
    v_delivered := v_delivered || jsonb_build_object('recipient', encode(r, 'hex'),
                                                     'mailbox_seq', m::text);
  END LOOP;

  RETURN jsonb_build_object(
    'conversation_id', v_conv_id, 'kind', v_kind, 'sealed', v_sealed, 'created', true,
    'message_id', v_mid, 'seq', '1', 'sent_at', v_ts, 'replayed', false,
    'members', (SELECT coalesce(jsonb_agg(jsonb_build_object('peer_id', encode(cm.peer_id, 'hex'),
                                                             'state', cm.state) ORDER BY cm.peer_id), '[]')
                  FROM conversation_members cm WHERE cm.conversation_id = v_conv_id),
    'delivered', v_delivered);
END $$;

CREATE FUNCTION schellingaf.send_message(
  p_conversation uuid, p_author bytea, p_body text, p_reply_to uuid, p_about text,
  p_idempotency_key text, p_welcome_space text,
  p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_about uuid; h bytea;
BEGIN
  -- Unlocked pre-check: a KEY that is not in the conversation is refused without
  -- waiting behind the ones that are, so its latency says nothing about them.
  IF NOT EXISTS (SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_author) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_author AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF p_about IS NOT NULL THEN
    SELECT sp.space_id INTO v_about FROM spaces sp WHERE sp.name = p_about;
    IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  END IF;

  h := sha256(convert_to((
        SELECT coalesce(jsonb_object_agg(k, v), '{}')
          FROM jsonb_each(jsonb_build_object(
                 'conversation_id', p_conversation, 'body', p_body,
                 'reply_to', p_reply_to, 'about', p_about,
                 'sealed_header', encode(p_sealed_header, 'hex'),
                 'ciphertext', encode(p_ciphertext, 'hex'))) AS e(k, v)
         WHERE v <> 'null'::jsonb)::text, 'UTF8'));

  RETURN send_into_conversation(p_conversation, p_author, p_body, p_reply_to, v_about,
                                p_idempotency_key, h, p_welcome_space,
                                p_about, p_sealed_header, p_ciphertext);
END $$;

CREATE FUNCTION schellingaf.accept_conversation(p_conversation uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_conv conversations%ROWTYPE; v_me conversation_members%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_conv FROM conversations c WHERE c.conversation_id = p_conversation FOR UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  SELECT * INTO v_me FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;

  IF v_me.state = 'accepted' THEN
    RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'accepted', 'changed', false);
  END IF;
  IF v_me.state = 'left' OR (v_conv.kind = 'group' AND v_me.declined_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CONVERSATION_LEFT';
  END IF;

  -- A request, or a pair this KEY declined and has changed its mind about.
  UPDATE conversation_members cm
     SET state = 'accepted', declined_at = NULL, state_at = now()
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;
  RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'accepted', 'changed', true);
END $$;

-- Declining tells nobody: the request stays 'requested' to everyone else.
CREATE FUNCTION schellingaf.decline_conversation(p_conversation uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_conv conversations%ROWTYPE; v_me conversation_members%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_conv FROM conversations c WHERE c.conversation_id = p_conversation FOR UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  SELECT * INTO v_me FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;

  IF v_me.state <> 'requested' THEN RAISE EXCEPTION 'NOT_A_REQUEST'; END IF;
  IF v_me.declined_at IS NOT NULL THEN
    RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'declined', 'changed', false);
  END IF;

  UPDATE conversation_members cm
     SET declined_at = now(), state_at = now(),
         until_seq = CASE WHEN v_conv.kind = 'group' THEN v_conv.last_seq END
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;
  RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'declined', 'changed', true);
END $$;

CREATE FUNCTION schellingaf.leave_conversation(p_conversation uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_conv conversations%ROWTYPE; v_me conversation_members%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_conv FROM conversations c WHERE c.conversation_id = p_conversation FOR UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF v_conv.kind = 'pair' THEN RAISE EXCEPTION 'PAIR_CANNOT_BE_LEFT'; END IF;
  SELECT * INTO v_me FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;

  IF v_me.state = 'left' THEN
    RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'left', 'changed', false);
  END IF;

  -- Leaving after declining is the decliner's own choice to be seen leaving.
  UPDATE conversation_members cm
     SET state = 'left', declined_at = NULL, state_at = now(),
         until_seq = coalesce(cm.until_seq, v_conv.last_seq)
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;
  RETURN jsonb_build_object('conversation_id', p_conversation, 'state', 'left', 'changed', true);
END $$;

-- Delete from my list: for this KEY alone, everything so far.
CREATE FUNCTION schellingaf.clear_conversation(p_conversation uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_conv conversations%ROWTYPE; v_me conversation_members%ROWTYPE; v_through bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_conv FROM conversations c WHERE c.conversation_id = p_conversation FOR UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  SELECT * INTO v_me FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;

  v_through := CASE WHEN v_me.until_seq IS NULL THEN v_conv.last_seq
                    ELSE least(v_conv.last_seq, v_me.until_seq) END;
  UPDATE conversation_members cm
     SET cleared_seq = greatest(cm.cleared_seq, v_through),
         read_seq = greatest(cm.read_seq, v_through)
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;
  RETURN jsonb_build_object('conversation_id', p_conversation,
                            'cleared_through', greatest(v_me.cleared_seq, v_through)::text,
                            'changed', v_through > v_me.cleared_seq);
END $$;

-- A read position moves forwards, on purpose, and never past what the member may read.
CREATE FUNCTION schellingaf.mark_conversation_read(p_conversation uuid, p_peer bytea, p_seq bigint)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_head bigint; v_until bigint; v_read bigint;
BEGIN
  SELECT c.last_seq, cm.until_seq INTO v_head, v_until
    FROM conversation_members cm
    JOIN conversations c ON c.conversation_id = cm.conversation_id
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;

  IF v_until IS NOT NULL THEN v_head := least(v_head, v_until); END IF;
  UPDATE conversation_members cm
     SET read_seq = greatest(cm.read_seq, CASE WHEN p_seq IS NULL THEN v_head ELSE least(p_seq, v_head) END)
   WHERE cm.conversation_id = p_conversation AND cm.peer_id = p_peer
  RETURNING cm.read_seq INTO v_read;
  RETURN jsonb_build_object('conversation_id', p_conversation, 'read_seq', v_read::text);
END $$;

CREATE FUNCTION schellingaf.set_message_block(p_blocker bytea, p_blocked bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_changed boolean; v_request record;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_blocker AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF p_blocker = p_blocked THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_blocked) THEN
    RAISE EXCEPTION 'PEER_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM message_blocks b WHERE b.blocker_id = p_blocker AND b.blocked_id = p_blocked)
     AND (SELECT count(*) FROM message_blocks b WHERE b.blocker_id = p_blocker) >= 10000 THEN
    RAISE EXCEPTION 'BLOCK_LIMIT';
  END IF;

  INSERT INTO message_blocks (blocker_id, blocked_id) VALUES (p_blocker, p_blocked)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING
  RETURNING true INTO v_changed;

  -- Its requests to you are declined, oldest conversation first, so two blocks at
  -- once take these rows in the one order.
  FOR v_request IN
    SELECT cm.conversation_id, c.kind, c.last_seq
      FROM conversation_members cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
     WHERE cm.peer_id = p_blocker AND cm.state = 'requested' AND cm.declined_at IS NULL
       AND c.started_by = p_blocked
     ORDER BY cm.conversation_id
     FOR UPDATE OF cm
  LOOP
    UPDATE conversation_members cm
       SET declined_at = now(), state_at = now(),
           until_seq = CASE WHEN v_request.kind = 'group' THEN v_request.last_seq END
     WHERE cm.conversation_id = v_request.conversation_id AND cm.peer_id = p_blocker;
  END LOOP;

  RETURN jsonb_build_object('peer_id', encode(p_blocked, 'hex'), 'blocked', true,
                            'changed', coalesce(v_changed, false));
END $$;

CREATE FUNCTION schellingaf.remove_message_block(p_blocker bytea, p_blocked bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_blocker AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  DELETE FROM message_blocks b WHERE b.blocker_id = p_blocker AND b.blocked_id = p_blocked;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('peer_id', encode(p_blocked, 'hex'), 'blocked', false, 'changed', n > 0);
END $$;

CREATE FUNCTION schellingaf.set_message_retention(p_peer bytea, p_days integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 720 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  INSERT INTO message_settings (peer_id, retention_days) VALUES (p_peer, p_days)
  ON CONFLICT (peer_id) DO UPDATE SET retention_days = EXCLUDED.retention_days, updated_at = now();
  RETURN jsonb_build_object('retention_days', p_days);
END $$;

-- Every message older than its sender's setting, run by src/db/prune.ts at start and
-- hourly. A pass is bounded, because the api role's statement timeout is five seconds and a
-- pass cut short catches up an hour later. Then a conversation idle for longer than any
-- message is kept goes too, with its members and a sealed pair's locks, once nothing is
-- left in it to read: they would be the last record of who wrote to whom. A change here is
-- a change to what the capability document and the primer tell every sender.
CREATE FUNCTION schellingaf.prune_messages() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n int := 0; k int; v_setting record;
BEGIN
  DELETE FROM messages mm WHERE mm.message_id IN (
    SELECT x.message_id FROM messages x WHERE x.sent_at < now() - interval '720 days' LIMIT 20000);
  GET DIAGNOSTICS k = ROW_COUNT;
  n := n + k;

  FOR v_setting IN
    SELECT ms.peer_id, ms.retention_days FROM message_settings ms WHERE ms.retention_days < 720
  LOOP
    DELETE FROM messages mm WHERE mm.message_id IN (
      SELECT x.message_id FROM messages x
       WHERE x.author_id = v_setting.peer_id
         AND x.sent_at < now() - make_interval(days => v_setting.retention_days)
       LIMIT 20000);
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;
  END LOOP;

  -- An idle sealed pair's locks go before its members and itself, and only when
  -- there is nothing left in it for them to open.
  DELETE FROM conversation_locks cl WHERE cl.conversation_id IN (
    SELECT c.conversation_id FROM conversations c
     WHERE c.sealed AND c.last_message_at < now() - interval '720 days'
       AND NOT EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.conversation_id)
     LIMIT 5000);
  DELETE FROM conversation_members cm WHERE cm.conversation_id IN (
    SELECT c.conversation_id FROM conversations c
     WHERE c.last_message_at < now() - interval '720 days'
       AND NOT EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.conversation_id)
       AND NOT EXISTS (SELECT 1 FROM conversation_locks cl WHERE cl.conversation_id = c.conversation_id)
     LIMIT 5000);
  DELETE FROM conversations c
   WHERE c.last_message_at < now() - interval '720 days'
     AND NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM conversation_locks cl WHERE cl.conversation_id = c.conversation_id);

  RETURN n;
END $$;

-- Internal, and never granted: knows_key(), make_room_for_request(),
-- check_message_header() and send_into_conversation().
GRANT EXECUTE ON FUNCTION
  schellingaf.start_conversation(bytea, bytea[], text, text, text, text, integer, integer, bytea, bytea[], bytea[], bytea, bytea),
  schellingaf.send_message(uuid, bytea, text, uuid, text, text, text, bytea, bytea),
  schellingaf.accept_conversation(uuid, bytea),
  schellingaf.decline_conversation(uuid, bytea),
  schellingaf.leave_conversation(uuid, bytea),
  schellingaf.clear_conversation(uuid, bytea),
  schellingaf.mark_conversation_read(uuid, bytea, bigint),
  schellingaf.set_message_block(bytea, bytea),
  schellingaf.remove_message_block(bytea, bytea),
  schellingaf.set_message_retention(bytea, integer),
  schellingaf.prune_messages()
TO schellingaf_api;
