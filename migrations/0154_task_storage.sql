-- A task's words count as its SPACE's storage: the title and body of every row of tasks,
-- whatever its state, kept as a third counter, space_storage.task_bytes, beside the post
-- bytes of 0148 and the file total of 0121. An upkeep task counts. A deleted task counts
-- 0: delete_task() empties its words. Earlier words kept in task_revisions do not count.
--
-- One AFTER trigger on tasks, on INSERT and on UPDATE OF title, body, adds the change in
-- bytes. It takes no SPACE lock: every writer of a task's words holds the SPACE's row
-- first, as 0147 left them:
--   insert_tasks(), from add_tasks() (add, a batch, a SPACE created with tasks) and from
--     retire_task() (its replacements);
--   next_job(), whose upkeep insert follows its SPACE lock;
--   change_task(), which lists title and body in every UPDATE, so a change of anything
--     else is a delta of 0 and writes nothing;
--   delete_task(), which sets both empty.
-- retire_task()'s update of its dependents names neither column, so the trigger does not
-- fire for it. Rows of tasks are never deleted (protect_task()), so there is no DELETE
-- branch. The nightly recount (src/db/storage.ts) counts tasks too.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- Every lock this file needs, taken up front. space_storage first: a POST with a task part
-- writes space_storage (append_post's trigger) and then updates tasks (task_done()) in one
-- transaction, so taking tasks first could deadlock with it. From here to commit no task's
-- words are written and no counter moves, so the backfill below misses none. 1.5 s at most,
-- under the api role's 2 s, as 0148 waits; a timeout fails the deploy, and the next one
-- tries again.
SET LOCAL lock_timeout = '1500ms';
LOCK TABLE schellingaf.space_storage IN ACCESS EXCLUSIVE MODE;
LOCK TABLE schellingaf.tasks IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE schellingaf.space_storage
  ADD COLUMN task_bytes bigint NOT NULL DEFAULT 0 CONSTRAINT space_storage_task_bytes CHECK (task_bytes >= 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- One definition of what a task stores
-- ─────────────────────────────────────────────────────────────────────────────

-- The bytes a task's words store: its title and its body, 0 for either missing.
CREATE FUNCTION schellingaf.task_stored_bytes(p_title text, p_body text) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT octet_length(coalesce(p_title, ''))::bigint + octet_length(coalesce(p_body, ''))
$$;

-- The true task bytes of one SPACE, every task whatever its state. The backfill below and
-- both phases of the recount read this one definition.
CREATE FUNCTION schellingaf.space_task_bytes_true(p_space uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(sum(task_stored_bytes(k.title, k.body)), 0)::bigint
    FROM tasks k
   WHERE k.space_id = p_space
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The counter follows each task's words
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION schellingaf.storage_count_task() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_delta bigint;
BEGIN
  v_delta := task_stored_bytes(NEW.title, NEW.body);
  IF TG_OP = 'UPDATE' THEN
    v_delta := v_delta - task_stored_bytes(OLD.title, OLD.body);
  END IF;
  IF v_delta = 0 THEN RETURN NULL; END IF;
  IF v_delta > 0 THEN
    INSERT INTO space_storage AS t (space_id, task_bytes) VALUES (NEW.space_id, v_delta)
    ON CONFLICT (space_id) DO UPDATE SET task_bytes = t.task_bytes + excluded.task_bytes;
  ELSE
    UPDATE space_storage t SET task_bytes = greatest(0, t.task_bytes + v_delta)
     WHERE t.space_id = NEW.space_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER tasks_storage AFTER INSERT OR UPDATE OF title, body ON schellingaf.tasks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.storage_count_task();

-- ─────────────────────────────────────────────────────────────────────────────
-- The recount counts tasks too
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION schellingaf.storage_recount_drift(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT space_post_bytes_true(p_space) <> coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
      OR space_file_bytes_true(p_space) <> coalesce((SELECT ft.attached_bytes FROM space_file_totals ft WHERE ft.space_id = p_space), 0)
      OR space_task_bytes_true(p_space) <> coalesce((SELECT t.task_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
$$;

-- The return type gains task_delta, so the function is made again. Under the SPACE lock,
-- as 0148's: the three true values, each set where it differs.
DROP FUNCTION schellingaf.storage_recount(uuid);
CREATE FUNCTION schellingaf.storage_recount(p_space uuid) RETURNS TABLE (post_delta bigint, file_delta bigint, task_delta bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_posts bigint; v_files bigint; v_tasks bigint; v_had_posts bigint; v_had_files bigint; v_had_tasks bigint;
BEGIN
  PERFORM 1 FROM spaces sp WHERE sp.space_id = p_space FOR NO KEY UPDATE;
  SELECT space_post_bytes_true(p_space), space_file_bytes_true(p_space), space_task_bytes_true(p_space),
         coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         coalesce((SELECT ft.attached_bytes FROM space_file_totals ft WHERE ft.space_id = p_space), 0),
         coalesce((SELECT t.task_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
    INTO v_posts, v_files, v_tasks, v_had_posts, v_had_files, v_had_tasks;
  IF v_posts <> v_had_posts THEN
    INSERT INTO space_storage AS t (space_id, post_bytes) VALUES (p_space, v_posts)
    ON CONFLICT (space_id) DO UPDATE SET post_bytes = excluded.post_bytes;
  END IF;
  IF v_files <> v_had_files THEN
    INSERT INTO space_file_totals AS ft (space_id, attached_bytes) VALUES (p_space, v_files)
    ON CONFLICT (space_id) DO UPDATE SET attached_bytes = excluded.attached_bytes;
  END IF;
  IF v_tasks <> v_had_tasks THEN
    INSERT INTO space_storage AS t (space_id, task_bytes) VALUES (p_space, v_tasks)
    ON CONFLICT (space_id) DO UPDATE SET task_bytes = excluded.task_bytes;
  END IF;
  post_delta := v_posts - v_had_posts;
  file_delta := v_files - v_had_files;
  task_delta := v_tasks - v_had_tasks;
  RETURN NEXT;
END $$;

-- The SPACES with a post or a task, by space_id, after the cursor, at most a thousand a
-- call. The task probe reads the unique index on tasks (space_id, number).
CREATE OR REPLACE FUNCTION schellingaf.storage_recount_spaces(p_after uuid, p_limit int) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(array_agg(x.space_id ORDER BY x.space_id), '{}'::uuid[])
    FROM (SELECT s.space_id FROM spaces s
           WHERE s.space_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
             AND s.space_id IS DISTINCT FROM p_after
             AND (s.last_seq > 0 OR EXISTS (SELECT 1 FROM tasks k WHERE k.space_id = s.space_id))
           ORDER BY s.space_id
           LIMIT least(p_limit, 1000)) x
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.task_stored_bytes(text, text),
  schellingaf.space_task_bytes_true(uuid),
  schellingaf.storage_count_task(),
  schellingaf.storage_recount(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.storage_recount(uuid) TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- The backfill: every SPACE with a task
-- ─────────────────────────────────────────────────────────────────────────────

-- After the trigger, in this file's one transaction, under the locks taken at the top.
-- backfill begin
INSERT INTO schellingaf.space_storage (space_id, task_bytes) SELECT k.space_id, sum(schellingaf.task_stored_bytes(k.title, k.body))::bigint FROM schellingaf.tasks k GROUP BY k.space_id ON CONFLICT (space_id) DO UPDATE SET task_bytes = excluded.task_bytes;
-- backfill end
