// What contests a finding: the mark the service sets beside its author's status, from what
// was posted, never a judgement of the claim.
//
// A post X is contested by a check's reject of X as a task's result, while that task has
// not accepted X since (accepted is final: retire and change refuse it), one cause per post
// and task naming the newest reject; and by a member's warn or fail citing X in
// data.sources (post_objections, migrations/0137_contested_findings.sql) that stands: not
// replaced, retracted, withheld or hidden. A finding is contested by every cause on its own
// post and on each post it rests on. Nothing passes further: a finding resting on a
// contested finding is not marked by that finding's causes.
//
// Read at read time, so a mark clears with its cause. Every alias inside a builder starts
// with c, so none can capture an alias of the query it is put into, and the plan test can
// tell these probes from resultOf()'s. A caller passes only the target column and a mode.

import type { Sql } from "postgres";
import { FINDING_LIMITS } from "../surface/vocabulary.ts";

/** How many causes one finding shows: rejects first, then the newest. */
const CAUSES = FINDING_LIMITS.causes;

/** The column a builder asks about: a finding's post, a post, or a source of one. */
type Target = "f.post_id" | "p.post_id" | "s.source_id";

/**
 * The warn or fail of the `post_objections` row `co`, while its words are available: one
 * probe of the posts' key through `visible_posts`, as a lateral with a limit so it stays a
 * probe a row.
 */
function warnOf(sql: Sql) {
  return sql`(select cv.kind, cv.author_id, cv.seq, cv.title, cv.posted_at
                from schellingaf.visible_posts cv
               where cv.post_id = co.post_id and cv.unavailable is null
               limit 1)`;
}

/**
 * The causes on the posts in `cx` (column id), a row each, for a query that has `cx` in
 * scope: cause, task, by_id, post_seq, title, at, rank, and why in the mailbox.
 */
function causeRows(sql: Sql, mailbox: boolean) {
  return sql`
    cross join lateral (
        -- A check's reject of cx.id as a task's result, the newest of each task, that task
        -- not accepted with cx.id since. Probes of task_checks_result_idx and tasks_pkey;
        -- the newest is an anti-join probe, never a sort.
        select 'rejected'::text as cause, ct.number as task, cr.peer_id::bytea as by_id,
               (select cp.seq from schellingaf.posts cp where cp.post_id = cr.post_id) as post_seq,
               null::text as title, cr.checked_at as at, 0 as rank
               ${mailbox ? sql`, cr.reason as why` : sql``}
          from schellingaf.task_checks cr
          join schellingaf.tasks ct on ct.task_id = cr.task_id
         where cr.result_post_id = cx.id and cr.verdict = 'reject'
           and not (ct.state = 'accepted' and ct.done_post_id = cx.id)
           and not exists (select 1 from schellingaf.task_checks cn
                            where cn.result_post_id = cx.id and cn.checked_at > cr.checked_at
                              and cn.task_id = cr.task_id and cn.verdict = 'reject')
        union all
        -- A member's warn or fail citing cx.id that stands and is readable: a backward walk
        -- of post_objections_pkey, stopped at the limit, each warn read by its key. The
        -- lateral's limit keeps the planner from joining the view to the walk, which under
        -- a generic plan merged it with every post.
        select * from (
          select cw.kind, null::int, cw.author_id::bytea, cw.seq, cw.title, cw.posted_at, 1
                 ${mailbox ? sql`, null::text` : sql``}
            from schellingaf.post_objections co
            cross join lateral ${warnOf(sql)} cw
           where co.source_id = cx.id
             and not exists (select 1 from schellingaf.posts cy where cy.supersedes = co.post_id and cy.kind <> 'version')
             and not exists (select 1 from schellingaf.posts cy where cy.retracts = co.post_id)
           order by co.post_id desc
           limit ${CAUSES}) cwn
      ) cc`;
}

/**
 * A finding's causes, as a json array, or null when none holds or when its words are
 * withheld or hidden: for a query that has the finding's post in `visible_posts` as `p`.
 * Each cause names the post it is about (`on`), the task and the rejecting KEY or the
 * warn's author (`by`), the check's or the warn's own post, and a warn's or fail's title;
 * in the mailbox a reject's reason too. Null fields are left out. At most
 * FINDING_LIMITS.causes, rejects first, then the newest; two warns of one batch share a
 * time and are ordered by seq. json, not jsonb, so each cause keeps the keys in the order
 * written here, the order the website and the specification give; jsonb sorts them.
 */
export function contestedOf(sql: Sql, target: "f.post_id", mailbox = false) {
  const t = sql(target);
  return sql`case when p.unavailable is null then (
      select json_agg(json_strip_nulls(json_build_object(
               'cause', ck.cause, 'on', ck.on_seq::text, 'task', ck.task,
               'by', encode(ck.by_id, 'hex'), 'post', ck.post_seq::text, 'title', ck.title
               ${mailbox ? sql`, 'reason', ck.why` : sql``}))
             order by ck.rank, ck.at desc, ck.post_seq desc)
        from (select cx_on.seq as on_seq, cc.*
                from (select ${t} as id
                      union all
                      select cs.source_id from schellingaf.post_sources cs where cs.post_id = ${t}) cx
                join schellingaf.posts cx_on on cx_on.post_id = cx.id
                ${causeRows(sql, mailbox)}
               order by cc.rank, cc.at desc, cc.post_seq desc
               limit ${CAUSES}) ck) end`;
}

/**
 * Whether any cause holds, as a boolean, for SEEK, the snippet and the one-post sources.
 * `finding`: the target is a finding, and its sources always count. `source`: the target
 * is a source, which must be readable itself, and its own sources count only when it is a
 * finding whose words are available. A scalar subquery with a limit, as
 * headlineColumns() writes its marks, so a generic plan keeps it a probe.
 */
export function contestedAny(sql: Sql, target: Target, mode: "finding" | "source") {
  const t = sql(target);
  const sourcesToo = mode === "finding"
    ? sql`true`
    : sql`exists (select 1 from schellingaf.findings csf
                    join schellingaf.visible_posts csv on csv.post_id = csf.post_id
                   where csf.post_id = ${t} and csv.unavailable is null)`;
  const readable = mode === "finding"
    ? sql`true`
    : sql`exists (select 1 from schellingaf.visible_posts csv where csv.post_id = ${t} and csv.unavailable is null)`;
  return sql`coalesce((select true
      from (select ${t} as id
            union all
            select cs.source_id from schellingaf.post_sources cs
             where cs.post_id = ${t} and ${sourcesToo}) cx
     where ${readable}
       and (exists (select 1 from schellingaf.task_checks cr
                     join schellingaf.tasks ct on ct.task_id = cr.task_id
                    where cr.result_post_id = cx.id and cr.verdict = 'reject'
                      and not (ct.state = 'accepted' and ct.done_post_id = cx.id))
            or exists (select 1 from schellingaf.post_objections co
                        cross join lateral ${warnOf(sql)} cw
                       where co.source_id = cx.id
                         and not exists (select 1 from schellingaf.posts cy where cy.supersedes = co.post_id and cy.kind <> 'version')
                         and not exists (select 1 from schellingaf.posts cy where cy.retracts = co.post_id)))
     limit 1), false)`;
}
