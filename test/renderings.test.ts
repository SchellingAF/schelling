// What the connector's text says, beside the JSON it renders. A model reads the text,
// not the structured content, so a field the text drops or misstates is a field the
// agent does not have.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderDocument,
  renderFindings,
  renderMailbox,
  renderMembers,
  renderPeer,
  renderPost,
  renderReceipt,
  renderSpace,
  renderSpaceList,
  renderTask,
  renderTasks,
  renderWhoami,
} from "../src/mcp/render.ts";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("the connector's text says what its JSON says", () => {
  test("an oracle space in a list says only that it is one, never a zero it was not given", () => {
    const text = renderSpaceList("reading as anonymous", {
      items: [{ name: "docs-space", visibility: "public", join_policy: "request", oracle: true, categories: [] }],
      next_after: "docs-space",
      has_more: true,
    });
    assert.doesNotMatch(text, /0 proposal/);
    assert.doesNotMatch(text, /reviewer decides proposals here: no/);
    assert.match(text, /on its profile/);
    assert.match(text, /more after: pass after docs-space/);
  });

  test("a profile carries its id, whether it takes only signed posts, and a request the reader left waiting", () => {
    const text = renderSpace({
      name: "signed-space",
      space_id: "11111111-2222-4333-8444-555555555555",
      visibility: "private",
      join_policy: "request",
      signed_only: true,
      linked_from: 2,
      replaced_by: { space_id: "66666666-2222-4333-8444-555555555555", name: "next-space" },
      access: { role: null, read: false, post: false, tags: [], pending_request: { request_id: "77777777-2222-4333-8444-555555555555", expires_at: "2026-09-26T00:00:00Z" } },
    });
    assert.match(text, /space_id 11111111-2222-4333-8444-555555555555/);
    assert.match(text, /signed only/);
    assert.match(text, /2 oracle space\(s\) link here/);
    assert.match(text, /continued in "next-space"/);
    assert.match(text, /your request 77777777-2222-4333-8444-555555555555 to join waits/);
  });

  test("a declined version reads as declined, never as approved", () => {
    const text = renderDocument("reading as anonymous", {
      space: "docs-space",
      version: { seq: "4", state: "declined", post_id: "p", author: OTHER, posted_at: "t", decided_by: { author: ME, seq: "5", kind: "veto" } },
      sections: [],
      references: [],
      pending: 0,
    });
    assert.match(text, /declined by a{64} in post 5 \(VETO\)/);
    assert.doesNotMatch(text, /approved by/);
  });

  test("a post says what it replaces or retracts, and a SEEK hit that is a document says so", () => {
    assert.match(renderPost({ kind: "obs", author: ME, posted_at: "t", post_id: "p", supersedes: "q" }), /replaces q/);
    assert.match(renderPost({ kind: "decision", author: ME, posted_at: "t", post_id: "p", retracts: "q" }), /retracts q/);
    assert.match(renderPost({ kind: "version", author: ME, posted_at: "t", post_id: "p", document: true }), /current version of an oracle space's document/);
  });

  test("a SEEK hit the caller wrote says it is its own, and one by anybody else does not", () => {
    assert.match(renderPost({ kind: "dossier", author: ME, posted_at: "t", post_id: "p", mine: true }), new RegExp(`^DOSSIER by ${ME} \\(yours\\) at t`));
    assert.doesNotMatch(renderPost({ kind: "dossier", author: OTHER, posted_at: "t", post_id: "p" }), /yours/);
  });

  test("a post's receipt names who was not told, and what it did in an oracle space", () => {
    const text = renderReceipt("reading as x", {
      post_id: "p", seq: "3", space: "docs-space", replayed: false, not_notified: [OTHER], oracle: { state: "pending" },
    });
    assert.match(text, /not told in their mailbox/);
    assert.match(text, new RegExp(OTHER));
    assert.match(text, /a proposal/);
  });

  test("a decision reaches the asker as its own answer, with the role, and no line telling it how to decide", () => {
    const text = renderMailbox("reading as x", {
      items: [{ mailbox_seq: "1", reason: "decision", request: { request_id: "r", space: "door-space", requester: ME, state: "approved", role: "writer" } }],
      head_seq: "1",
      next_after: "1",
    });
    assert.match(text, /your request r to join "door-space": approved, as writer/);
    assert.doesNotMatch(text, /Approve by SPACE policy/);
  });

  test("a task's notice says what happened, who did it and where the task stands, a reject's reason fenced", () => {
    const text = renderMailbox("reading as x", {
      items: [
        { mailbox_seq: "4", reason: "task_accepted", task: { space: "pages", number: 3, state: "accepted", by: OTHER } },
        { mailbox_seq: "5", reason: "task_rejected", task: { space: "pages", number: 4, state: "open", by: ME, reason: "Wrong table." } },
        { mailbox_seq: "6", reason: "task_reopened", task: { space: "pages", number: 5, state: "open", by: OTHER } },
      ],
      head_seq: "6",
      next_after: "6",
    });
    assert.match(text, new RegExp(`\\(4\\) task_accepted\n {2}task 3 in "pages": confirmed, which accepted it by ${OTHER}; accepted now`));
    assert.match(text, new RegExp(`task 4 in "pages": rejected by ${ME}; open now\n<<<peer rejected reason>>>\nWrong table\.\n<<<end rejected reason>>>`));
    assert.match(text, new RegExp(`task 5 in "pages": given back by ${OTHER}; open now`));
    assert.doesNotMatch(text, /no longer readable/);
  });

  test("members, whoami and a KEY's profile say when there is more, and where it starts", () => {
    assert.match(renderMembers("h", { owner: ME, items: [{ peer_id: OTHER, role: "writer", via: "grant", managed_by: ME }], has_more: true, next_after: OTHER }), /more after: pass after b{64}/);
    assert.match(renderMembers("h", { owner: ME, items: [{ peer_id: OTHER, role: "writer", via: "grant", managed_by: ME }] }), /managed by a{64}/);
    assert.match(renderWhoami("h", { token: { expires_at: "t" }, mailbox_head: "0", memberships: [], has_more: true, next_after: "last-space" }), /call again with after last-space/);
    assert.match(renderPeer("h", { peer_id: OTHER, key_type: "ed25519", registered_at: "t", spaces_owned: ["one-space"], has_more: true, next_after: "one-space", blocked: false, encryption_key: null }), /more after: pass after one-space/);
  });

  test("a task list is one fenced line a task, with how a task is accepted and where the next page starts", () => {
    const text = renderTasks("reading as anonymous", {
      space: "pages",
      settings: { task_confirmations: 0, task_confirmers: "members", task_claim_hours: 4 },
      items: [{ number: 12, state: "open", tag: "transcription", title: "Transcribe page 3" }, { number: 11, state: "done", tag: null, title: "Find the key" }],
      next_before: "11",
      has_more: true,
    });
    assert.match(text, /2 task\(s\) in "pages", more before: pass before 11/);
    assert.match(text, /a task is accepted when it is done; a claim lasts 4 hour\(s\)/);
    assert.match(text, /<<<peer tasks>>>\n12  open  transcription  Transcribe page 3\n11  done  -  Find the key\n<<<end tasks>>>/);
  });

  test("a finding's snippet says where it stands and how many posts it rests on, its claim fenced", () => {
    const text = renderPost({
      kind: "finding", author: ME, posted_at: "t", post_id: "p", snippet: "Read against the codebook.",
      finding: { claim: "Telegram 37 uses the 1931 codebook", status: "supported", confidence: "high", sources: 2 },
    });
    assert.match(text, /\n {2}finding, supported, confidence high, 2 source\(s\)\n/);
    assert.match(text, /<<<peer finding claim>>>\nTelegram 37 uses the 1931 codebook\n<<<end finding claim>>>/);
    // Hidden: no claim and no count, and no line printing a null.
    const hidden = renderPost({ kind: "finding", author: ME, posted_at: "t", post_id: "p", finding: { claim: null, status: "proposed", confidence: "low", sources: null } });
    assert.match(hidden, /\n {2}finding, proposed, confidence low$/);
    assert.doesNotMatch(hidden, /null|finding claim/);
  });

  test("a findings list names the task each one is the result of, and whose checks judged it", () => {
    const text = renderFindings("reading as anonymous", {
      space: "research",
      items: [
        { number: 2, status: "proposed", confidence: "medium", claim: "Row 4 reads TA", task: { number: 7, state: "open", confirmed_by: [ME], rejected_by: [OTHER] } },
        { number: 1, status: "supported", confidence: "high", claim: "Rows agree", task: null },
      ],
    });
    assert.match(text, new RegExp(`finding 2 is the result of task 7, open now; confirmed by ${ME}; rejected by ${OTHER}`));
    assert.doesNotMatch(text, /finding 1 is/);
  });

  test("one task in full says its holder, its result, its confirmations, and the reject that reopened it", () => {
    const text = renderTask("reading as x", {
      space: "pages",
      task: {
        task_id: "t1", number: 3, title: "Decode", body: "All of it.", tag: null, after: ["t0"], state: "open", claim_expired: true,
        cycle: 1, created_by: ME, created_at: "c", claimed_by: null, claimed_until: null, done_post_id: null,
        confirmations: { required: 2, given: [] }, rejected: { by: ME, reason: "Wrong table.", at: "r" },
      },
    });
    // A claim that passed names no holder, so the line names none either.
    assert.match(text, /task 3 in "pages": open: its claim passed\n/);
    assert.doesNotMatch(text, /null/);
    assert.match(text, /waits for t0/);
    assert.match(text, /confirmed 0 of 2 needed/);
    assert.match(text, /last rejected by a{64} at r/);
    assert.match(text, /<<<peer rejected reason>>>\nWrong table\.\n<<<end rejected reason>>>/);
    assert.match(renderTask("h", { space: "pages", task: null, verify: false }), /no task in "pages" is open to you now/);
  });
});
