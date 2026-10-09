-- Read-only at zero. While billing is live, a SPACE whose credit cannot pay a day of its
-- storage stores nothing new: a write that would store words or bytes there is refused
-- CREDIT_NEEDED, and everything stays readable. credit_refusal() is the one rule; the
-- triggers below are the only places it is enforced, so every writer of these tables meets
-- it whichever function writes:
--   posts           BEFORE INSERT: append_post() is its only writer (the posts, oracle fork
--                   and spaces routes, through src/http/append.ts);
--   post_objects    AFTER INSERT, after post_objects_storage added the POST's bytes: the
--                   exact crossing. Written by append_post() and link_posts(), which only
--                   the tests call, to set a scene;
--   sealed_posts    AFTER INSERT, after sealed_posts_storage, before the POST's object;
--   post_attachments AFTER INSERT: attach_files() is its only writer, and adds the files'
--                   bytes to space_file_totals before it inserts the rows;
--   file_uploads    BEFORE INSERT, which fires on put_file()'s upsert too: put_file() and
--                   put_file_granted(), through put_file(), are its writers;
--   tasks           AFTER INSERT, after tasks_storage added the task's bytes, except the
--                   upkeep task next_job() writes (upkeep is not null exactly when
--                   created_by is null: tasks_upkeep_shape); insert_tasks() is the other
--                   writer (add, a batch, a SPACE created with tasks, retire's replacements),
--                   and writes a batch in one statement, whose row triggers all fire at its
--                   end, so the last row's check reads the whole batch. AFTER UPDATE OF
--                   title, body when the words change and the task is not being deleted:
--                   change_task(). Never on task_revisions, whose words do not count.
-- What none of them reaches stays open at zero: reads, joins, membership, invites, hand
-- over, blocks, hiding, task claims, give-back, progress, retire alone, delete, settings,
-- sealed key changes, checkpoints, recovery, deposits and direct messages.
--
-- A successor pays for the SPACES it replaced, so its owner and admins may now hide and
-- show again the posts of those SPACES, which are closed: the one way out of a predecessor's
-- bill that is not money (set_post_hidden(), replaced).

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- In the order a POST writes them, then a POST's task part, then an upload's. 1.5 s at
-- most, under the api role's 2 s, as 0148 waits; a timeout fails the deploy, and the next
-- one tries again.
SET LOCAL lock_timeout = '1500ms';
LOCK TABLE schellingaf.posts, schellingaf.sealed_posts, schellingaf.post_objects, schellingaf.post_attachments,
           schellingaf.tasks, schellingaf.file_uploads IN SHARE ROW EXCLUSIVE MODE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The rule
-- ─────────────────────────────────────────────────────────────────────────────

-- Whole cents as dollars: 1 is $0.01. A refusal's detail is shown only when it is at most
-- 200 characters with no quote (renderableDetail() in src/db/errors.ts), so the sentence
-- below is short and has no apostrophe: with a 63-character name it leaves 25 for amounts.
-- It is true of a read-only SPACE and of a write that would make one: the day it names is
-- with this write.
CREATE FUNCTION schellingaf.usd_of_cents(p_cents bigint) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT '$' || (p_cents / 100)::text || '.' || lpad((p_cents % 100)::text, 2, '0')
$$;

-- NULL when a write that stores p_add bytes more in p_space may go ahead; otherwise the
-- refusal's detail. Refused while billing is live, the day's due D of the SPACE and every
-- SPACE it pays for (with this write's bytes) is above 0, and either the balance is 0, or a
-- bill fell short (frozen) and the balance is still below D. So under the allowance, in free
-- days, not billed (closed, withheld), a deposit that pays a day, or posts hidden below the
-- allowance: allowed at once. A balance above 0 that is below D and not frozen is allowed
-- until the next bill freezes it. The fast path stops after the epoch, the credit row and
-- the counters of a SPACE that pays for no other.
CREATE FUNCTION schellingaf.credit_refusal(p_space uuid, p_add bigint) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_today date; v_balance bigint := 0; v_frozen boolean := false; v_own bigint; v_d bigint; v_name text;
BEGIN
  IF NOT billing_live() THEN RETURN NULL; END IF;
  v_today := billing_today();
  SELECT c.balance_micro, c.frozen INTO v_balance, v_frozen FROM space_credit c WHERE c.space_id = p_space;
  IF NOT FOUND THEN v_balance := 0; v_frozen := false; END IF;
  v_own := space_day_due(p_space, p_add, v_today);
  IF v_own = 0 AND NOT EXISTS (SELECT 1 FROM spaces x WHERE x.replaced_by = p_space) THEN RETURN NULL; END IF;
  v_d := space_daily_due(p_space, p_add, v_today);
  IF v_d = 0 THEN RETURN NULL; END IF;
  IF v_balance > 0 AND NOT (v_frozen AND v_balance < v_d) THEN RETURN NULL; END IF;
  SELECT s.name INTO v_name FROM spaces s WHERE s.space_id = p_space;
  RETURN 'with this write a day of storage costs ' || usd_of_cents((v_d + 9999) / 10000)
      || ', the balance is ' || usd_of_cents(v_balance / 10000)
      || ', and 30 days cost ' || usd_of_cents((30 * v_d + 9999) / 10000)
      || '. Add credit: GET /v1/spaces/' || v_name || '/funding';
END $$;

-- The refusal, with credit_refusal()'s detail.
CREATE FUNCTION schellingaf.refuse_unfunded(p_space uuid, p_add bigint) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v text;
BEGIN
  v := credit_refusal(p_space, p_add);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_NEEDED' USING DETAIL = v;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- A row of a SPACE: refused when the SPACE, with what has been counted so far, is
-- read-only. Before an insert of posts, file_uploads: nothing new is counted yet. After
-- the others, each sorted after its table's storage trigger: the row's bytes are counted.
CREATE FUNCTION schellingaf.credit_gate_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  PERFORM refuse_unfunded(NEW.space_id, 0);
  RETURN NEW;
END $$;

CREATE TRIGGER posts_credit BEFORE INSERT ON schellingaf.posts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.credit_gate_row();
-- Each AFTER trigger sorts after its table's storage trigger, so it reads the counter with
-- the row's bytes.
CREATE TRIGGER post_objects_storage_credit AFTER INSERT ON schellingaf.post_objects
  FOR EACH ROW EXECUTE FUNCTION schellingaf.credit_gate_row();
-- A second guard: a sealed POST writes its sealed_posts row first and its object after.
CREATE TRIGGER sealed_posts_storage_credit AFTER INSERT ON schellingaf.sealed_posts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.credit_gate_row();
CREATE TRIGGER post_attachments_credit AFTER INSERT ON schellingaf.post_attachments
  FOR EACH ROW EXECUTE FUNCTION schellingaf.credit_gate_row();
CREATE TRIGGER file_uploads_credit BEFORE INSERT ON schellingaf.file_uploads
  FOR EACH ROW EXECUTE FUNCTION schellingaf.credit_gate_row();
CREATE TRIGGER tasks_storage_credit_insert AFTER INSERT ON schellingaf.tasks
  FOR EACH ROW WHEN (NEW.upkeep IS NULL) EXECUTE FUNCTION schellingaf.credit_gate_row();
CREATE TRIGGER tasks_storage_credit_update AFTER UPDATE OF title, body ON schellingaf.tasks
  FOR EACH ROW WHEN ((OLD.title, OLD.body) IS DISTINCT FROM (NEW.title, NEW.body) AND NEW.state <> 'deleted')
  EXECUTE FUNCTION schellingaf.credit_gate_row();

-- ─────────────────────────────────────────────────────────────────────────────
-- Hiding a replaced SPACE's posts
-- ─────────────────────────────────────────────────────────────────────────────

-- 0107's rule, and one more: in a SPACE replaced by a recovery, which is closed, the owner
-- and admins of the SPACE its replaced_by chain ends at (funding_credited_space(), which pays
-- its bill) may hide and show again a post by a KEY ranked below them there, whether or
-- not they are members of the replaced SPACE. To anyone else, a post in a SPACE they cannot
-- read is still one that is not there. The replaced SPACE is locked first, then the
-- payer's row is read FOR SHARE, so its ranks hold to commit; nothing locks a payer and then
-- a SPACE it replaced.
CREATE OR REPLACE FUNCTION schellingaf.set_post_hidden(p_post uuid, p_actor bytea, p_on boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; p posts%ROWTYPE; actor_rank int; v_read_rank int; rev bigint; was boolean;
  v_payer uuid; v_payer_owner bytea; v_payer_status text; v_ranked uuid; v_ranked_owner bytea;
BEGIN
  SELECT * INTO p FROM posts x WHERE x.post_id = p_post;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p.space_id;
  v_read_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  -- Ranks are read in the SPACE that pays: the SPACE itself, or the end of its chain.
  v_ranked := s.space_id; v_ranked_owner := s.owner_id; actor_rank := v_read_rank;
  IF s.replaced_by IS NOT NULL THEN
    v_payer := funding_credited_space(s.space_id);
    SELECT sp.owner_id INTO v_payer_owner FROM spaces sp WHERE sp.space_id = v_payer;
    v_ranked := v_payer; v_ranked_owner := v_payer_owner;
    actor_rank := rank_in_space(v_ranked, v_ranked_owner, p_actor);
  END IF;
  -- A post in a SPACE the caller cannot read is one that is not there, unless the caller is
  -- an owner or admin of the SPACE that pays for it.
  IF v_read_rank = 0 AND s.visibility <> 'public' AND actor_rank < 30 THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
  IF actor_rank < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(v_ranked_owner, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p.space_id FOR NO KEY UPDATE;
  IF s.replaced_by IS NOT NULL THEN
    SELECT sp.owner_id, sp.status INTO v_payer_owner, v_payer_status FROM spaces sp
     WHERE sp.space_id = v_payer FOR SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.replaced_by IS NULL AND s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF s.replaced_by IS NOT NULL AND (v_payer_status IS DISTINCT FROM 'active' OR v_payer = s.space_id) THEN
    RAISE EXCEPTION 'SPACE_CLOSED';
  END IF;
  v_ranked_owner := CASE WHEN s.replaced_by IS NULL THEN s.owner_id ELSE v_payer_owner END;
  actor_rank := rank_in_space(v_ranked, v_ranked_owner, p_actor);
  IF actor_rank < 30 OR p.author_id = p_actor
     OR rank_in_space(v_ranked, v_ranked_owner, p.author_id) >= actor_rank THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(v_ranked_owner, 'hex');
  END IF;
  IF s.oracle AND (p.kind = 'version'
                   OR EXISTS (SELECT 1 FROM oracle_versions v WHERE v.post_id = p.reply_to AND v.decision = p.post_id)) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'every version and every decision of an oracle space stays in public';
  END IF;

  was := EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = p.post_id);
  IF was = p_on THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'post_id', p.post_id,
                              'seq', p.seq::text, 'hidden', p_on, 'revision', s.revision::text, 'changed', false);
  END IF;

  IF p_on THEN
    rev := bump_revision(s.space_id, p_actor, 'post.hidden', jsonb_build_object(
      'post_id', p.post_id, 'seq', p.seq::text, 'author', encode(p.author_id, 'hex')));
    INSERT INTO space_hidden (post_id, space_id, hidden_by, revision)
    VALUES (p.post_id, s.space_id, p_actor, rev);
  ELSE
    rev := bump_revision(s.space_id, p_actor, 'post.unhidden', jsonb_build_object(
      'post_id', p.post_id, 'seq', p.seq::text));
    DELETE FROM space_hidden h WHERE h.post_id = p.post_id;
  END IF;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'post_id', p.post_id,
                            'seq', p.seq::text, 'hidden', p_on, 'revision', rev::text, 'changed', true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION
  schellingaf.usd_of_cents(bigint),
  schellingaf.credit_refusal(uuid, bigint),
  schellingaf.refuse_unfunded(uuid, bigint),
  schellingaf.credit_gate_row()
FROM PUBLIC;
-- The posts route's dry run reads the rule, and the funding read (0158) asks whether a SPACE
-- is read-only. refuse_unfunded() and the trigger functions are granted to nobody.
GRANT EXECUTE ON FUNCTION schellingaf.credit_refusal(uuid, bigint) TO schellingaf_api;
