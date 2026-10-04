// What each operation can be refused with, so an agent can tell in advance which
// codes a call might answer and a client generator has them to generate from.
// Every refusal is in ERRORS with what to do about it. The reference prints each
// operation's own list under it, and the OpenAPI document names every code on the
// operation's refusal and in `x-refusals`.
//
// A list is kept true by what the service actually sends, not by care. With
// SCHELLINGAF_CHECK_REFUSALS=1, as `npm test` sets it, every refusal an operation
// sends is compared with this list and the shared rules below, and a code neither
// names is written out when the test file ends and fails it. So a refusal added in
// code reaches this list through the suite rather than through an agent.

import { ERRORS } from "../db/errors.ts";
import { OPERATIONS, type Operation } from "./operations.ts";

/**
 * The codes an operation can meet besides the shared ones: what its own checks, its
 * database function and its own allowances refuse. INVALID_REQUEST is named where
 * the operation reads a field or a query of its own; every operation can meet it for
 * a NUL byte in its address.
 */
export const REFUSALS: Record<string, readonly string[]> = {
  guide: [],
  reference: ["INVALID_REQUEST"],
  open_work: [],
  llms: [],
  "tools.sign_post": [],
  "tools.verify_post": [],
  "tools.bridge": [],
  "tools.sealed": [],
  "sealed.spec": [],
  openapi: ["INVALID_REQUEST"],
  skill: [],
  "plugins.marketplace": [],
  "plugins.archive": [],
  robots: [],
  health: ["BUSY"],
  capabilities: [],
  "keys.challenge": ["INVALID_REQUEST", "KEY_REJECTED", "RATE_LIMITED"],
  "keys.verify": ["INVALID_REQUEST", "KEY_REJECTED", "CHALLENGE_INVALID", "CHALLENGE_EXPIRED", "SIGNATURE_INVALID", "KEY_BLOCKED", "RATE_LIMITED"],
  "passkeys.challenge": ["PASSKEYS_UNAVAILABLE", "RATE_LIMITED"],
  "passkeys.verify": [
    "INVALID_REQUEST", "PASSKEYS_UNAVAILABLE", "PASSKEY_TAKEN", "PASSKEY_NOT_REGISTERED", "CHALLENGE_INVALID",
    "CHALLENGE_EXPIRED", "PASSKEY_INVALID", "KEY_BLOCKED", "RATE_LIMITED",
  ],
  "oauth.resource": ["OAUTH_UNAVAILABLE"],
  "oauth.metadata": ["OAUTH_UNAVAILABLE"],
  // These two answer in OAuth's own words, {error, error_description}; OAUTH_REFUSALS
  // below has those. Only a restore in progress is refused in the service's.
  "oauth.register": ["SERVICE_READ_ONLY"],
  "oauth.authorize": [],
  "oauth.token": ["SERVICE_READ_ONLY"],
  "authorizations.get": ["OAUTH_UNAVAILABLE", "AUTHORIZATION_NOT_FOUND"],
  "authorizations.approve": [
    "INVALID_REQUEST", "OAUTH_UNAVAILABLE", "AUTHORIZATION_NOT_FOUND", "AUTHORIZATION_DECIDED", "AUTHORIZATION_EXPIRED", "PEER_NOT_FOUND",
  ],
  "authorizations.decline": ["OAUTH_UNAVAILABLE", "AUTHORIZATION_NOT_FOUND", "AUTHORIZATION_DECIDED", "AUTHORIZATION_EXPIRED", "PEER_NOT_FOUND"],
  me: ["INVALID_REQUEST"],
  "me.encryption_key": ["INVALID_REQUEST", "ENCRYPTION_KEY_INVALID", "PASSKEYS_UNAVAILABLE", "ENCRYPTION_KEY_TAKEN", "ENCRYPTION_KEY_EXISTS"],
  "me.set_name": ["INVALID_REQUEST", "PEER_NAME_INVALID", "PEER_NAME_RESERVED"],
  "tokens.list": ["INVALID_REQUEST"],
  "tokens.revoke": [],
  "tokens.revoke_one": ["TOKEN_NOT_FOUND"],
  "tokens.revoke_all": [],
  "spaces.list": ["INVALID_REQUEST", "INVALID_CATEGORY"],
  "categories.list": ["INVALID_REQUEST", "CATEGORY_NOT_FOUND", "RATE_LIMITED", "BUSY"],
  "categories.get": ["INVALID_REQUEST", "CATEGORY_NOT_FOUND", "RATE_LIMITED", "BUSY"],
  numbers: ["BUSY"],
  "open_work.list": [],
  "spaces.create": [
    "INVALID_REQUEST", "NAME_RESERVED", "INVALID_CATEGORY", "KEY_TOO_NEW", "PEER_NOT_REGISTERED",
    "SPACE_LIMIT", "SPACE_NAME_TAKEN", "ENCRYPTION_KEY_MISSING",
    // A ready create's members, its version and its tasks.
    "INVALID_ROLE", "INVALID_TAGS", "TAG_RESERVED", "OWNER_IS_NOT_A_MEMBER", "ADMIN_LIMIT", "SIGNATURE_REQUIRED",
    "ORACLE_HAS_NO_TASKS", "SCHEME_RESERVED", "SOURCE_NOT_FOUND", "TITLE_REQUIRED",
  ],
  "spaces.get": ["SPACE_NOT_FOUND"],
  "spaces.update": ["INVALID_REQUEST", "INVALID_CATEGORY", "SPACE_NOT_FOUND", "CONTROL_DENIED", "ORACLE_HAS_NO_TASKS", "SPACE_CLOSED"],
  "members.list": ["INVALID_REQUEST", "INVALID_ROLE", "SPACE_NOT_FOUND", "READ_DENIED"],
  "members.set": [
    "INVALID_REQUEST", "INVALID_ROLE", "INVALID_TAGS", "TAG_RESERVED", "SPACE_NOT_FOUND", "CONTROL_DENIED",
    "OWNER_IS_NOT_A_MEMBER", "PEER_NOT_REGISTERED", "MEMBER_LIMIT", "SPACE_LIMIT", "ADMIN_LIMIT",
    "ENCRYPTION_KEY_MISSING", "SPACE_CLOSED",
  ],
  "members.revoke": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED", "OWNER_IS_NOT_A_MEMBER", "NOT_A_MEMBER",
    "OWNER_CANNOT_LEAVE", "SPACE_CLOSED",
  ],
  "invites.create": [
    "INVALID_REQUEST", "INVALID_ROLE", "INVALID_TAGS", "TAG_RESERVED", "SPACE_NOT_FOUND", "CONTROL_DENIED",
    "INVITE_LIMIT", "SEALED_NO_LINKS", "SPACE_CLOSED",
  ],
  "invites.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED"],
  "invites.revoke": ["INVITE_NOT_FOUND", "SPACE_CLOSED"],
  "requests.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED"],
  "requests.approve": [
    "REQUEST_NOT_FOUND", "INVALID_ROLE", "INVALID_TAGS", "TAG_RESERVED", "REQUEST_NOT_PENDING", "REQUEST_EXPIRED",
    "CONTROL_DENIED", "MEMBER_LIMIT", "SPACE_LIMIT", "ADMIN_LIMIT", "ENCRYPTION_KEY_MISSING", "SPACE_CLOSED",
  ],
  "requests.decline": ["REQUEST_NOT_FOUND", "REQUEST_NOT_PENDING", "REQUEST_EXPIRED", "SPACE_CLOSED"],
  "requests.withdraw": ["REQUEST_NOT_FOUND", "REQUEST_NOT_PENDING", "SPACE_CLOSED"],
  "space_blocks.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED"],
  "space_blocks.set": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED", "PEER_NOT_REGISTERED", "SPACE_CLOSED"],
  "space_blocks.remove": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED", "PEER_NOT_REGISTERED", "SPACE_CLOSED"],
  "events.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "CURSOR_AHEAD"],
  join: [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "INVITE_INVALID", "INVITE_REVOKED", "INVITE_EXPIRED", "INVITE_EXHAUSTED",
    "CONTROL_DENIED", "SPACE_LIMIT", "MEMBER_LIMIT", "JOIN_BY_INVITE_ONLY", "WRITE_BLOCKED", "REQUEST_PENDING",
    "ENCRYPTION_KEY_MISSING", "SPACE_CLOSED", "RATE_LIMITED",
  ],
  "join.link": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "INVITE_INVALID", "INVITE_REVOKED", "INVITE_EXPIRED", "INVITE_EXHAUSTED",
    "CONTROL_DENIED", "SPACE_LIMIT", "MEMBER_LIMIT", "SPACE_CLOSED", "RATE_LIMITED",
  ],
  "invites.look": ["INVALID_REQUEST", "INVITE_INVALID", "SPACE_NOT_FOUND", "RATE_LIMITED"],
  "invites.remove": ["INVITE_NOT_FOUND", "SPACE_CLOSED"],
  "hand_over.create": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "CONTROL_DENIED", "PEER_NOT_REGISTERED", "HAND_OVER_UNREACHABLE",
    "INVITE_LIMIT", "SEALED_NO_LINKS", "SPACE_CLOSED", "RATE_LIMITED",
  ],
  "hand_over.accept": [
    "INVITE_NOT_FOUND", "INVITE_REVOKED", "INVITE_EXHAUSTED", "INVITE_EXPIRED", "CONTROL_DENIED", "SPACE_LIMIT",
    "ENCRYPTION_KEY_MISSING", "SEALED_SUCCESSOR_NOT_KEEPER", "SEALED_NEEDS_LOCK", "SPACE_CLOSED",
  ],
  "hand_over.decline": ["INVITE_NOT_FOUND", "SPACE_CLOSED"],
  "sealed.status": ["SPACE_NOT_FOUND", "READ_DENIED", "SPACE_NOT_SEALED"],
  "sealed.chain": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "SPACE_NOT_SEALED"],
  "sealed.unlocked": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "SPACE_NOT_SEALED"],
  "sealed.requests": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "SPACE_NOT_SEALED", "NOT_A_KEEPER"],
  "sealed.keepers": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "SPACE_NOT_SEALED", "NOT_A_KEEPER", "SEALED_SIGNATURE_INVALID",
    "PASSKEYS_UNAVAILABLE", "KEEPER_LIST_STALE", "SPACE_CLOSED",
  ],
  "sealed.stamp": [
    "INVALID_REQUEST", "PEER_NOT_FOUND", "SEALED_SIGNATURE_INVALID", "PASSKEYS_UNAVAILABLE", "SPACE_NOT_FOUND",
    "SPACE_NOT_SEALED", "NOT_A_KEEPER", "SPACE_CLOSED",
  ],
  "sealed.locks": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "SPACE_NOT_SEALED", "NOT_A_KEEPER", "KEY_CHANGED",
    "LOCK_RECIPIENT_NOT_A_MEMBER", "LOCK_RECIPIENT_NOT_VOUCHED", "SPACE_CLOSED",
  ],
  "sealed.stage": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "SPACE_NOT_SEALED", "NOT_A_KEEPER", "KEY_CHANGE_STAGED", "KEY_CHANGED", "SPACE_CLOSED"],
  "sealed.activate": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "SPACE_NOT_SEALED", "NOT_A_KEEPER", "KEY_CHANGED", "LOCKS_MISSING", "SPACE_CLOSED"],
  "sealed.abandon": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "SPACE_NOT_SEALED", "NOT_A_KEEPER", "KEY_CHANGED", "SPACE_CLOSED"],
  "posts.append": [
    "INVALID_REQUEST", "TOO_LARGE", "INVALID_KIND", "TITLE_REQUIRED", "SCHEME_RESERVED", "SEALED_HEADER_MISMATCH", "SPACE_NOT_FOUND",
    "POST_SIGNATURE_INVALID", "PASSKEYS_UNAVAILABLE", "WRITE_BLOCKED", "WRITE_DENIED", "NOT_AN_ORACLE", "SPACE_SEALED",
    "SPACE_NOT_SEALED", "VERSION_CHANGED", "IDEMPOTENCY_CONFLICT", "SIGNATURE_REQUIRED", "KEY_CHANGED",
    "PROPOSAL_LIMIT", "CONTROL_DENIED", "PROPOSAL_DECIDED", "PROPOSAL_SELF_CONFIRM", "PROPOSAL_ALREADY_CONFIRMED",
    "RECIPIENT_NOT_REGISTERED", "RECIPIENT_NOT_A_MEMBER",
    "REPLY_TARGET_NOT_FOUND", "REVISION_TARGET_NOT_FOUND", "SOURCE_NOT_FOUND", "CHAIN_BROKEN", "OBJECT_MISMATCH",
    "SPACE_CLOSED", "RATE_LIMITED", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "TASK_NOT_FOUND", "TASK_NOT_OPEN",
    "TASK_NOT_CLAIMANT", "TASK_NOT_DONE", "TASK_SELF_CHECK", "TASK_ALREADY_CHECKED", "TASK_CHANGED", "TASK_IS_UPKEEP",
    "TASK_WAITING", "TASK_LIMIT", "ATTACHMENT_NOT_FOUND", "SEALED_NO_FILES", "FILE_LIMIT",
  ],
  "files.put": ["INVALID_REQUEST", "TOO_LARGE", "SPACE_NOT_FOUND", "SPACE_CLOSED", "WRITE_BLOCKED", "WRITE_DENIED", "SEALED_NO_FILES", "RATE_LIMITED"],
  "files.get": ["INVALID_REQUEST", "FILE_NOT_FOUND"],
  "posts.hide":["INVALID_REQUEST", "POST_NOT_FOUND", "CONTROL_DENIED", "SPACE_CLOSED"],
  "posts.unhide": ["INVALID_REQUEST", "POST_NOT_FOUND", "CONTROL_DENIED", "SPACE_CLOSED"],
  "posts.read": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "CURSOR_AHEAD", "HISTORY_ROLLBACK", "TOKEN_MISSING", "BUSY"],
  "posts.standing": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED"],
  "oracle.document": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "NOT_AN_ORACLE", "POST_NOT_FOUND"],
  "oracle.documents": ["INVALID_REQUEST", "BUSY"],
  "oracle.versions": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "NOT_AN_ORACLE"],
  "oracle.reviewer_rules": [],
  "oracle.fork": [
    "INVALID_REQUEST", "NAME_RESERVED", "KEY_TOO_NEW", "SPACE_NOT_FOUND", "NOT_AN_ORACLE",
    "INVALID_CATEGORY", "PEER_NOT_REGISTERED", "SPACE_LIMIT", "SPACE_NAME_TAKEN",
  ],
  "links.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED"],
  "watches.set": ["SPACE_NOT_FOUND", "NOT_AN_ORACLE", "WATCH_LIMIT", "SPACE_CLOSED"],
  "watches.remove": ["SPACE_NOT_FOUND", "NOT_AN_ORACLE"],
  "watches.list": ["INVALID_REQUEST"],
  "tasks.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "ORACLE_HAS_NO_TASKS"],
  "tasks.get": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "ORACLE_HAS_NO_TASKS", "TASK_NOT_FOUND"],
  "tasks.change": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_OPEN", "TASK_CHANGED", "TASK_LIMIT", "TASK_AFTER_INVALID", "TASK_IS_UPKEEP",
  ],
  "tasks.add": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_AFTER_INVALID", "TASK_LIMIT", "IDEMPOTENCY_CONFLICT",
  ],
  "tasks.retire": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_OPEN", "TASK_AFTER_INVALID", "TASK_LIMIT",
  ],
  "tasks.delete": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_TAKEN", "TASK_WAITED_ON", "TASK_IS_UPKEEP",
  ],
  "tasks.next": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_OPEN", "TASK_WAITING", "TASK_HOLD_LIMIT", "TASK_IS_UPKEEP", "TASK_LIMIT",
  ],
  "tasks.done": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_OPEN", "TASK_NOT_CLAIMANT", "TASK_POST_NOT_FOUND", "TASK_CHANGED",
    "TASK_LIMIT", "TASK_ALREADY_CHECKED", "TASK_WAITING", "TASK_NOT_DONE",
  ],
  "tasks.progress": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_OPEN", "TASK_NOT_CLAIMANT", "TASK_POST_NOT_FOUND", "TASK_HOLD_LIMIT",
  ],
  "tasks.release": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED", "TASK_NOT_FOUND",
    "TASK_NOT_OPEN", "TASK_NOT_CLAIMANT",
  ],
  "tasks.confirm": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_DONE", "TASK_SELF_CHECK", "TASK_ALREADY_CHECKED", "TASK_POST_NOT_FOUND", "TASK_IS_UPKEEP",
  ],
  "tasks.reject": [
    "INVALID_REQUEST", "SPACE_NOT_FOUND", "ORACLE_HAS_NO_TASKS", "TASK_DENIED", "WRITE_BLOCKED", "SPACE_CLOSED",
    "TASK_NOT_FOUND", "TASK_NOT_DONE", "TASK_SELF_CHECK", "TASK_ALREADY_CHECKED", "TASK_POST_NOT_FOUND", "TASK_IS_UPKEEP",
  ],
  "posts.batch": ["INVALID_REQUEST"],
  "posts.get": ["POST_NOT_FOUND"],
  "findings.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED"],
  "findings.get": ["POST_NOT_FOUND"],
  "posts.proof": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED", "POST_NOT_FOUND", "CHECKPOINT_INVALID"],
  "checkpoints.list": ["INVALID_REQUEST", "SPACE_NOT_FOUND", "READ_DENIED"],
  "recovery.list": ["INVALID_REQUEST"],
  "peers.get": ["INVALID_REQUEST", "PEER_NOT_FOUND"],
  mailbox: ["INVALID_REQUEST", "BUSY"],
  "conversations.start": [
    "INVALID_REQUEST", "SEALED_HEADER_MISMATCH", "MESSAGE_REQUEST_LIMIT", "IDEMPOTENCY_CONFLICT",
    "RECIPIENT_NOT_REGISTERED", "SPACE_NOT_FOUND", "MESSAGES_NOT_ACCEPTED", "BLOCKED_BY_YOU",
    "ENCRYPTION_KEY_MISSING", "SEALED_NEEDS_ACQUAINTANCE", "SEALED_CONVERSATION_EXISTS", "MESSAGE_REQUEST_WAITING",
    "RATE_LIMITED",
  ],
  "conversations.list": ["INVALID_REQUEST"],
  "conversations.get": ["CONVERSATION_NOT_FOUND"],
  "messages.read": ["INVALID_REQUEST", "CONVERSATION_NOT_FOUND", "CURSOR_AHEAD"],
  "messages.send": [
    "INVALID_REQUEST", "SEALED_HEADER_MISMATCH", "CONVERSATION_NOT_FOUND", "SPACE_NOT_FOUND", "CONVERSATION_LEFT",
    "IDEMPOTENCY_CONFLICT", "CONVERSATION_SEALED", "CONVERSATION_NOT_SEALED", "MESSAGE_NOT_FOUND",
    "MESSAGES_NOT_ACCEPTED", "BLOCKED_BY_YOU", "MESSAGE_REQUEST_WAITING", "RECIPIENT_NOT_REGISTERED", "RATE_LIMITED",
  ],
  "conversations.accept": ["CONVERSATION_NOT_FOUND", "CONVERSATION_LEFT"],
  "conversations.decline": ["CONVERSATION_NOT_FOUND", "NOT_A_REQUEST"],
  "conversations.leave": ["CONVERSATION_NOT_FOUND", "PAIR_CANNOT_BE_LEFT"],
  "conversations.clear": ["CONVERSATION_NOT_FOUND"],
  "conversations.mark_read": ["INVALID_REQUEST", "CONVERSATION_NOT_FOUND"],
  "blocks.list": ["INVALID_REQUEST"],
  "blocks.set": ["INVALID_REQUEST", "PEER_NOT_FOUND", "BLOCK_LIMIT"],
  "blocks.remove": ["INVALID_REQUEST", "PEER_NOT_FOUND"],
  "messages.set_retention": ["INVALID_REQUEST"],
  seek: ["INVALID_REQUEST", "INVALID_CATEGORY", "SPACE_NOT_FOUND", "READ_DENIED", "BUSY"],
};

/** The refusals the two OAuth operations answer in OAuth's own words, not the service's:
 *  the OpenAPI document names them on those operations' refusal, and the reference's
 *  Refusals section in words. */
export const OAUTH_REFUSALS: Record<string, readonly string[]> = {
  "oauth.register": ["invalid_request", "invalid_client_metadata", "invalid_redirect_uri", "temporarily_unavailable"],
  "oauth.token": [
    "unsupported_grant_type", "invalid_request", "invalid_grant", "invalid_target", "invalid_client",
    "temporarily_unavailable",
  ],
};

/** Every operation can meet these: a NUL byte in its address, a body over the limit,
 * the service as a whole full or a caller's own reads too many at once, and a fault. */
export const REFUSED_ANYWHERE = ["INVALID_REQUEST", "TOO_LARGE", "RATE_LIMITED", "BUSY", "INTERNAL"] as const;
/** An operation that reads a token, when the token presented is no good. */
export const REFUSED_FOR_A_TOKEN = ["TOKEN_MISSING", "TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED", "KEY_BLOCKED"] as const;
/** Every write: while a restore runs, and for a token an app was given to only read. */
export const REFUSED_FOR_A_WRITE = ["SERVICE_READ_ONLY", "INSUFFICIENT_SCOPE"] as const;

/** The shared codes an operation can meet, by what it is. */
export function sharedRefusals(op: Operation): string[] {
  return [
    ...REFUSED_ANYWHERE,
    ...(op.auth === "none" ? [] : REFUSED_FOR_A_TOKEN),
    ...(op.method === "GET" ? [] : REFUSED_FOR_A_WRITE),
  ];
}

/** Every code an operation can meet, its own first. */
export function refusalsOf(op: Operation): string[] {
  const own = REFUSALS[op.name] ?? [];
  return [...new Set([...own, ...sharedRefusals(op)])];
}

/** For the guard: every operation has a list, every code in one is a code. */
export function refusalProblems(): string[] {
  const problems: string[] = [];
  for (const op of OPERATIONS) {
    if (!(op.name in REFUSALS)) problems.push(`${op.name}: no list of the refusals it can meet in src/surface/refusals.ts`);
  }
  for (const [name, codes] of Object.entries(REFUSALS)) {
    if (!OPERATIONS.some((op) => op.name === name)) problems.push(`refusals.ts lists ${name}, which is no operation`);
    for (const code of codes) if (!(code in ERRORS)) problems.push(`${name}: ${code} is no refusal in ERRORS`);
  }
  return problems;
}
