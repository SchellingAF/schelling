-- A task says which task numbers it waits for.
--
-- A task's after holds the task_ids of the tasks it waits for, and a reader had to map each
-- uuid to a number by hand to see that task 8 waits for task 1. task_item() now answers
-- after_numbers beside it: the numbers of the same tasks, in the order after has them. after
-- is unchanged. Every answer that shows a task shows it through task_item(), so every one
-- carries the numbers; the list's compact view adds them in src/http/tasks.ts.
--
-- Nothing a reader could not read already: a task waits only for tasks of its own SPACE
-- (add_tasks() refuses another's), and the lookup asks for the same SPACE again, so it can
-- never answer a number of another SPACE's task. The list calls task_item() as the caller,
-- so the lookup passes the tasks policy, which answers for a SPACE as it does for the task
-- being shown; the write functions call it as the owner. A task is never deleted, so each
-- id names a row; an id that finds none (or none of this SPACE) is answered as null, so
-- after_numbers always has after's length and order and a client may pair them by position.
--
-- Written as a scalar subquery for each id, a probe of the tasks' primary key, so that no
-- plan reads the SPACE's tasks. As 0125_task_progress.sql made it in every other way:
-- invoker rights, STABLE, qualified names (a SQL-standard body is resolved here, not when
-- it runs), and the execute grant kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION schellingaf.task_item(t schellingaf.tasks, p_required integer)
  RETURNS jsonb
  LANGUAGE sql STABLE
  RETURN jsonb_build_object(
      'task_id', t.task_id, 'number', t.number, 'title', t.title, 'body', t.body, 'tag', t.tag,
      'after', to_jsonb(t.waits_for),
      'after_numbers', (SELECT coalesce(jsonb_agg(w.number ORDER BY w.ord), '[]'::jsonb)
                          FROM (SELECT o.ord,
                                       (SELECT k.number FROM schellingaf.tasks k
                                         WHERE k.task_id = o.task_id AND k.space_id = t.space_id) AS number
                                  FROM unnest(t.waits_for) WITH ORDINALITY o(task_id, ord)) w),
      'state', CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END,
      'cycle', t.cycle,
      'created_by', encode(t.created_by, 'hex'), 'created_at', t.created_at,
      'claimed_by', encode(t.claimed_by, 'hex'), 'claimed_until', t.claimed_until,
      'done_post_id', t.done_post_id, 'done_at', t.done_at, 'accepted_at', t.accepted_at,
      'confirmations', jsonb_build_object(
        'required', p_required,
        'given', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                    FROM schellingaf.task_checks c
                   WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm')))
    || CASE WHEN t.state = 'claimed' AND t.claimed_until <= now()
            THEN jsonb_build_object('claim_expired', true) ELSE '{}'::jsonb END
    || coalesce((SELECT jsonb_build_object('rejected', jsonb_build_object(
                          'by', encode(r.peer_id, 'hex'), 'reason', r.reason, 'at', r.checked_at))
                   FROM schellingaf.task_checks r
                  WHERE r.task_id = t.task_id AND r.cycle = t.cycle - 1 AND r.verdict = 'reject'), '{}'::jsonb)
    || coalesce((SELECT jsonb_build_object('progress', jsonb_build_object(
                          'post_id', v.post_id, 'title', v.title, 'by', encode(v.author_id, 'hex'), 'at', t.progress_at))
                   FROM schellingaf.visible_posts v
                  WHERE v.post_id = t.progress_post_id), '{}'::jsonb);
