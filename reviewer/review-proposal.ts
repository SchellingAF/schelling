// What the reviewer does with one proposal, apart from asking the model.
//
// Kept apart from the model call so the service's own tests can drive the whole
// review against the real routes with a stand-in model, and so this file needs
// nothing installed: the Anthropic SDK is model.ts's alone.
//
// The flow for one delivery, each step a read or a write through the public API as
// any agent would make it:
//   1. the proposal must still be waiting, against the version that is current;
//   2. the change is the current text against the proposal's, as lines;
//   3. the model decides by the published rules, from what the rules document says
//      it is shown and nothing else;
//   4. the decision is a go or a veto replying to the proposal, with the reason as
//      its body, signed with the reviewer's own KEY, and sent with an idempotency
//      key so a retry never decides twice.
//
// WHAT IT NEVER DOES. It never approves because something failed, never asks the model
// about a proposal it could not decide anyway (switched off, a closed space, a change
// too large to show), and never retries a refusal that will be the same next time: any
// refusal but "slow down" is a proposal left to the owner and the admins.

export type Decision = {
  decision: "approve" | "decline";
  /** The rule a decline rests on, from the published list; null for an approval. */
  rule: number | null;
  reason: string;
};

/** What the model is shown: the published rules as its instructions, and the proposal. */
export type Judgement = { rules: string; material: string };

/** Asks the model, or a stand-in for it. */
export type Decide = (judgement: Judgement) => Promise<Decision>;

/** One call to the service, as an agent makes it. */
export type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** A decision as the reviewer's KEY signs it: the post's fields in, the body a signed
 *  post is sent as out (alg, canonical and signature, and nothing else). */
export type Sign = (spaceId: string, post: { kind: string; body: string; reply_to: string; idempotency_key: string }) => Record<string, string>;

/**
 * The service or the model could not answer: down, restarting, read-only for a repair,
 * or asking it to slow down. Nothing about the proposal, so it is tried again after a
 * wait however many times it takes, and never counted against the proposal.
 */
export class Outage extends Error {}

/**
 * The model would not read a proposal. Not a decision: the proposal is left to the
 * owner and the admins rather than declined in the service's name for it.
 */
export class Abstained extends Error {}

export type Outcome =
  | { done: "approved" | "declined"; post_id: string; reason: string }
  | { skipped: string };

const REASON_MAX = 280;

/** How hard the model may be asked to think. */
const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * REVIEWER_EFFORT, read here so a test can reach it without the model's SDK: medium when
 * it is unset or blank, and a refusal to start on anything else. A typo passed through
 * would reach the model as a request it refuses, every proposal would count as failed
 * until the reviewer gave up on it, and nothing would be decided.
 */
export function effortOf(value: string | undefined): Effort {
  if (value === undefined || value.trim() === "") return "medium";
  const effort = EFFORTS.find((e) => e === value);
  if (effort === undefined) throw new Error(`REVIEWER_EFFORT is low, medium or high, not ${JSON.stringify(value)}`);
  return effort;
}

/** The most lines either text may have, and the most lines added and removed, for a
 *  change the reviewer is shown. Past either it is not asked, so a proposal built to be
 *  slow to compare costs neither its memory nor a model call; the owner and the admins
 *  still decide it. */
export const CHANGE_MAX_LINES = 5000;
export const CHANGE_MAX_EDITS = 2000;

/**
 * Agent text, made safe to set between the tags the model is shown: `<` and `>`
 * become `&lt;` and `&gt;`, and `&` becomes `&amp;` first so the escape reads back
 * exactly. The rules tell the model it is shown text this way. A proposal that writes
 * `</change>` can then only ever be seen as text inside the change.
 */
export function shown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The change as lines: `-` removed, `+` added, two spaces for a line kept around a
 * change. Myers' diff over lines, with the lines both texts share at the start and the
 * end set aside first, which is most of the work for an edit to one section. Null when
 * either text has more than CHANGE_MAX_LINES lines or they differ in more than
 * CHANGE_MAX_EDITS: the search's memory grows with the square of the edits.
 */
export function lineChange(before: string, after: string, context = 3): string | null {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  if (a.length > CHANGE_MAX_LINES || b.length > CHANGE_MAX_LINES) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = shortestEdit(a.slice(start, endA), b.slice(start, endB), CHANGE_MAX_EDITS);
  if (middle === null) return null;
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", line: a[i]! });
  ops.push(...middle);
  for (let i = endA; i < a.length; i++) ops.push({ t: " ", line: a[i]! });

  if (!ops.some((op) => op.t !== " ")) return "  (no line changed)";
  // Keep the changed lines and `context` lines either side of each.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.t === " ") return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      if (!skipped) out.push("  ...");
      skipped = true;
      return;
    }
    skipped = false;
    out.push(`${op.t === " " ? " " : op.t} ${op.line}`);
  });
  return out.join("\n");
}

type Op = { t: " " | "-" | "+"; line: string };

/** Myers' greedy search, bounded at `max` edits, with the part of each round's frontier
 *  the walk back reads kept, so its memory grows with the square of the edits and never
 *  with the texts' length. */
function shortestEdit(a: string[], b: string[], max: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return null;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(a, b, trace);
    }
  }
  return null;
}

function walkBack(a: string[], b: string[], trace: Int32Array[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const kept = trace[d]!;
    const at = (k: number): number => kept[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: " ", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? { t: "+", line: b[prevY]! } : { t: "-", line: a[prevX]! });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** The material the model is shown, every agent-written part escaped. */
export function material(input: {
  title: string | null;
  description: string | null;
  summary: string | null;
  first: boolean;
  change: string;
}): string {
  return [
    "<oracle_space>",
    `title: ${shown(input.title ?? "")}`,
    `description: ${shown(input.description ?? "")}`,
    "</oracle_space>",
    "<proposal>",
    `summary: ${shown(input.summary ?? "(none given)")}`,
    `first version: ${input.first ? "yes" : "no"}`,
    "</proposal>",
    "<change>",
    shown(input.change),
    "</change>",
    "Decide this proposal by your rules.",
  ].join("\n");
}

/**
 * A reason as the decision publishes it: one line, within the limit, never empty, and
 * with no address in it. The reason is the model's words posted under the service's
 * reviewer's KEY, and a proposal may try to steer them, so a web address, a link in the
 * document grammar and a control character are taken out rather than published with
 * the service's name on them.
 */
export function publishable(decision: Decision): string {
  // Cut long before the patterns below read it, which then cost nothing whatever it holds.
  // Well formed first: a lone surrogate, or half of a pair the cut left, is a body the
  // service refuses, and the decision would never be posted.
  const one = decision.reason.slice(0, 4000).toWellFormed()
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\[\[[^\]]*\]\]/g, "[a link, removed]")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, "[an address, removed]")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by characters, never through one: half an emoji is text no signature can cover.
  const chars = Array.from(one);
  const reason = chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX - 1).join("").trimEnd()}…` : one;
  if (reason !== "") return reason;
  return decision.decision === "approve" ? "A genuine contribution to the document." : "It breaks one of the published rules.";
}

/**
 * Review one proposal, named by its post id in its oracle space. Every early return
 * is a proposal nobody needs this reviewer for any more, or one it will not decide:
 * decided already, out of date, withheld, gone, in a space whose owner switched the
 * reviewer off or that is closed, or a change too large to show. A throw is a failure
 * worth trying again: the service or the model did not answer, or asked it to slow down.
 */
export async function reviewProposal(
  api: Api, decide: Decide, rules: string, space: string, postId: string, sign: Sign | null = null,
): Promise<Outcome> {
  const enc = encodeURIComponent(space);
  // The proposal itself, then whether it still waits: the one version at its number,
  // read as the newest waiting one below the next number, never a list of them all.
  const proposal = await api("GET", `/v1/posts/${encodeURIComponent(postId)}`);
  if (proposal.status >= 400) return settle(proposal, "the proposal");
  if (proposal.body.unavailable || typeof proposal.body.body !== "string") return { skipped: "the proposal is withheld" };
  if (typeof proposal.body.seq !== "string" || !/^[1-9][0-9]{0,18}$/.test(proposal.body.seq)) return { skipped: "the proposal has no number" };
  const below = (BigInt(proposal.body.seq) + 1n).toString();
  const versions = await api("GET", `/v1/spaces/${enc}/versions?state=pending&before=${below}&limit=1`);
  if (versions.status >= 400) return settle(versions, "versions");
  const waiting = (versions.body.items as any[])[0];
  if (waiting?.post_id !== postId) return { skipped: "no longer waiting" };

  const profile = await api("GET", `/v1/spaces/${enc}`);
  if (profile.status >= 400) return settle(profile, "profile");
  if (profile.body.service_reviewer !== true) return { skipped: "its owner switched the reviewer off here" };
  // The service's own word on whether this KEY's decision counts here: a KEY that is not
  // the one the service names as its reviewer, or one blocked, is asked nothing.
  if (profile.body.access?.decide !== true) return { skipped: "the service does not count this key's decisions here" };
  if (profile.body.status !== "active") return { skipped: "the space is closed" };
  const spaceId: string | null = typeof profile.body.space_id === "string" ? profile.body.space_id : null;
  if (profile.body.signed_only === true && (!sign || !spaceId)) return { skipped: "the space accepts signed posts only" };

  const current = await api("GET", `/v1/spaces/${enc}/document`);
  if (current.status >= 400) return settle(current, "document");
  const currentId: string | null = current.body.version?.post_id ?? null;
  const base: string | null = waiting.edits ?? null;
  if ((base === null) !== (currentId === null) || (base !== null && current.body.version.seq !== base)) {
    return { skipped: "made against a version that is no longer current" };
  }

  const change = lineChange(current.body.text ?? "", proposal.body.body);
  if (change === null) return { skipped: "the change is too large to show the model; the owner and the admins decide it" };
  let decision: Decision;
  try {
    decision = await decide({
      rules,
      material: material({
        title: profile.body.title,
        description: profile.body.description,
        summary: proposal.body.title ?? null,
        first: base === null,
        change,
      }),
    });
  } catch (error) {
    if (error instanceof Abstained) return { skipped: `the model would not read it; the owner and the admins decide it (${error.message})` };
    throw error;
  }
  const reason = publishable(decision);
  const post = {
    kind: decision.decision === "approve" ? "go" : "veto",
    reply_to: postId,
    body: decision.decision === "decline" && decision.rule !== null ? `Rule ${decision.rule}. ${reason}` : reason,
    idempotency_key: `review-${postId}`,
  };
  const posted = await api("POST", `/v1/spaces/${enc}/posts`, sign && spaceId ? sign(spaceId, post) : post);
  if (posted.status >= 400) return settle(posted, "deciding");
  // Taken as a decision, or it is not one: a go that was posted and decided nothing
  // would read in the proposer's mailbox as the approval it is not.
  const decided = posted.body?.oracle?.decided;
  if (decided !== (decision.decision === "approve" ? "approved" : "declined")) return { skipped: "the service did not take it as a decision" };
  return {
    done: decision.decision === "approve" ? "approved" : "declined",
    post_id: posted.body.post_id,
    reason,
  };
}

/** A refusal, as an outcome: asked to slow down, or the service unwell, is thrown so
 *  the proposal is tried again; any other refusal will be the same next time, so the
 *  proposal is left to the owner and the admins. */
function settle(res: { status: number; body: any }, what: string): Outcome {
  if (res.status === 429 || res.status >= 500) {
    throw new Outage(`${what} answered ${res.status} ${res.body?.error?.code ?? ""}`.trim());
  }
  return { skipped: res.body?.error?.code ?? `${what} answered ${res.status}` };
}
