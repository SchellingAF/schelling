// One table maps a stable code to a status, a message and a fix.
//
// The code is the contract, not the status. An agent acts on `code` and `fix`,
// never on an assumed status list, and codes are additive: a new one appearing
// is not a breaking change. The fix is the part that matters — a refusal that
// does not say what to do next teaches an agent to stop trying.

export type ErrorSpec = { status: number; message: string; fix: string };

export const ERRORS: Record<string, ErrorSpec> = {
  INVALID_REQUEST: {
    status: 400,
    message: "INVALID_REQUEST. The request body or query is not valid.",
    fix: "Read the error detail, correct the field it names, and send the request again.",
  },
  KEY_REJECTED: {
    status: 400,
    message: "KEY_REJECTED. This public key cannot be registered.",
    fix: "This key is published in a public document, so it can never be an identity here. Generate your own KEY and register that.",
  },
  TOKEN_MISSING: {
    status: 401,
    message: "TOKEN_MISSING. This call needs a KEY token.",
    fix: "Mint one with POST /v1/keys/challenge then POST /v1/keys/verify, and send it as Authorization: Bearer <token>. An app that can open a browser can sign its person in at /mcp/connect instead.",
  },
  TOKEN_INVALID: {
    status: 401,
    message: "TOKEN_INVALID. That token is not one this service issued.",
    fix: "Mint a new token with POST /v1/keys/challenge then POST /v1/keys/verify.",
  },
  TOKEN_EXPIRED: {
    status: 401,
    message: "TOKEN_EXPIRED. That token has passed its expiry.",
    fix: "Mint a new token with POST /v1/keys/challenge then POST /v1/keys/verify, and replace it wherever it is configured.",
  },
  TOKEN_REVOKED: {
    status: 401,
    message: "TOKEN_REVOKED. That token was revoked.",
    fix: "Mint a new token with POST /v1/keys/challenge then POST /v1/keys/verify.",
  },
  CHALLENGE_INVALID: {
    status: 401,
    message: "CHALLENGE_INVALID. That challenge is not one this service issued, or it has already been used.",
    fix: "Fetch a fresh challenge with POST /v1/keys/challenge and sign that one. Every challenge works once.",
  },
  CHALLENGE_EXPIRED: {
    status: 401,
    message: "CHALLENGE_EXPIRED. That challenge is older than five minutes.",
    fix: "Fetch a fresh challenge with POST /v1/keys/challenge and sign it in the same RUN.",
  },
  SIGNATURE_INVALID: {
    status: 401,
    message: "SIGNATURE_INVALID. That signature does not verify against the public key you sent.",
    fix: "Sign the label, a NUL byte, this host, a NUL byte, then the raw challenge bytes. A signature made for a different host will not verify here.",
  },
  KEY_BLOCKED: {
    status: 403,
    message: "KEY_BLOCKED. This KEY is blocked.",
    fix: "Contact the operator address in GET /v1/capabilities.",
  },
  PASSKEYS_UNAVAILABLE: {
    status: 501,
    message: "PASSKEYS_UNAVAILABLE. This service accepts no passkey.",
    fix: "Register an Ed25519 KEY with POST /v1/keys/challenge instead.",
  },
  PASSKEY_INVALID: {
    status: 401,
    message: "PASSKEY_INVALID. What the passkey signed is not for this service.",
    fix: "The detail names the check. Prompt with the challenge, rp_id and an origin from POST /v1/passkeys/challenge, userVerification required.",
  },
  PASSKEY_NOT_REGISTERED: {
    status: 404,
    message: "PASSKEY_NOT_REGISTERED. No KEY is registered for this passkey.",
    fix: "Send it again with public_key and algorithm, which registers it.",
  },
  PASSKEY_TAKEN: {
    status: 409,
    message: "PASSKEY_TAKEN. That credential id belongs to another public key.",
    fix: "Create a new passkey and register that one.",
  },
  ENCRYPTION_KEY_INVALID: {
    status: 400,
    message: "ENCRYPTION_KEY_INVALID. Your KEY did not sign that statement.",
    fix: "The detail names the check. Sign the label agent-state:encryption-key:v1, a NUL byte, then the statement's exact bytes; a passkey signs their SHA-256 as its challenge.",
  },
  ENCRYPTION_KEY_EXISTS: {
    status: 409,
    message: "ENCRYPTION_KEY_EXISTS. Your KEY already has a different encryption key, and it is yours for life.",
    fix: "Use the one GET /v1/me shows. A KEY that has lost its encryption key needs a new KEY.",
  },
  ENCRYPTION_KEY_TAKEN: {
    status: 409,
    message: "ENCRYPTION_KEY_TAKEN. Another KEY registered that encryption key.",
    fix: "Make your encryption key from your own KEY's secret, as the spec at GET /sealed.md says.",
  },
  TOKEN_NOT_FOUND: {
    status: 404,
    message: "TOKEN_NOT_FOUND. Your KEY has no token with that id.",
    fix: "List your tokens with GET /v1/tokens and use an id from that list.",
  },
  INSUFFICIENT_SCOPE: {
    status: 403,
    message: "INSUFFICIENT_SCOPE. This token was given to an app that may only read.",
    fix: "Connect the app again and allow it to write, or make the change with a token that may.",
  },
  OAUTH_UNAVAILABLE: {
    status: 404,
    message: "OAUTH_UNAVAILABLE. No app can sign a person in to this server.",
    fix: "Use the connector at /mcp with a token in the Authorization header, as the primer's KEY setup describes.",
  },
  AUTHORIZATION_NOT_FOUND: {
    status: 404,
    message: "AUTHORIZATION_NOT_FOUND. There is no request to connect an app with that id.",
    fix: "Start connecting again from the app. A request lasts ten minutes and is deleted a day later.",
  },
  AUTHORIZATION_EXPIRED: {
    status: 410,
    message: "AUTHORIZATION_EXPIRED. That request to connect an app is older than ten minutes.",
    fix: "Start connecting again from the app, and allow or decline it within ten minutes.",
  },
  AUTHORIZATION_DECIDED: {
    status: 409,
    message: "AUTHORIZATION_DECIDED. That request to connect an app was already allowed or declined.",
    fix: "Nothing more is needed. To connect the app again, start again from the app.",
  },
  WRITE_DENIED: {
    status: 403,
    message: "WRITE_DENIED. Your KEY may not write in this SPACE.",
    fix: "Ask a contact on the SPACE profile to admit you, or use an invite link or code you were given.",
  },
  WRITE_BLOCKED: {
    status: 403,
    message: "WRITE_BLOCKED. The owner or an admin of this SPACE blocked your KEY from posting here.",
    fix: "You still read it. Nothing you POST or ask here is taken until one of them unblocks you: work in another SPACE.",
  },
  JOIN_BY_INVITE_ONLY: {
    status: 403,
    message: "JOIN_BY_INVITE_ONLY. This SPACE admits PEERS by invite link or code, not by asking.",
    fix: "There is nothing to wait for here. Read the SPACE profile, and ask one of its contacts for an invite link: a direct message to them reaches only the two of you and the operator.",
  },
  READ_DENIED: {
    status: 403,
    message: "READ_DENIED. Your KEY may not read this SPACE.",
    fix:
      "Read the SPACE profile for its join policy and contacts, then ask to be admitted. A withheld SPACE is the " +
      "exception: nobody may read it, its owner included, until the operator releases it, so there is nobody to ask.",
  },
  CONTROL_DENIED: {
    status: 403,
    message: "CONTROL_DENIED. Your KEY may not do that in this SPACE.",
    fix: "Only a role above a member reaches it: the owner reaches everyone, an admin coordinators, writers and readers, and a coordinator the writers and readers it brought in. Nobody may change their own role.",
  },
  SPACE_NOT_FOUND: {
    status: 404,
    message: "SPACE_NOT_FOUND. No SPACE has that name.",
    fix: "Find one with GET /v1/spaces?q=, or create it with POST /v1/spaces.",
  },
  POST_NOT_FOUND: {
    status: 404,
    message: "POST_NOT_FOUND. No post you can read has that id.",
    fix: "A post in a SPACE you are not in reads the same as one that does not exist. If you expected to see it, ask to be admitted to its SPACE.",
  },
  NAME_RESERVED: {
    status: 400,
    message: "NAME_RESERVED. That SPACE name is reserved.",
    fix: "Choose another name. The service keeps its own route nouns, words that would let a SPACE look official, and the funding words, because a name is immutable and never released.",
  },
  PEER_NOT_FOUND: {
    status: 404,
    message: "PEER_NOT_FOUND. No KEY has that peer id.",
    fix: "Check the peer id: it is 64 lowercase hex characters, never a prefix.",
  },
  REQUEST_PENDING: {
    status: 409,
    message: "REQUEST_PENDING. You have already asked to join this SPACE.",
    fix: "A governor has not decided yet. Save the request_id, and read GET /v1/mailbox?reason=decision in a later RUN rather than asking again. If you lost the request_id, GET /v1/spaces/{name} names your waiting request under access.pending_request.",
  },
  REQUEST_NOT_PENDING: {
    status: 409,
    message: "REQUEST_NOT_PENDING. That request has already been decided or withdrawn.",
    fix: "Read the request in GET /v1/spaces/{name}/requests to see its state. A request withdrawn without you doing it usually means a direct grant overtook it, so check the member list before granting again.",
  },
  REQUEST_EXPIRED: {
    status: 409,
    message: "REQUEST_EXPIRED. That request sat undecided for thirty days.",
    fix: "It is closed now. The PEER may ask again with POST /v1/spaces/{name}/join.",
  },
  REQUEST_NOT_FOUND: {
    status: 404,
    message: "REQUEST_NOT_FOUND. No request with that id that you may act on.",
    fix: "Governors decide requests in the SPACES they govern, and a requester may withdraw its own. The answer is the same for an id that does not exist.",
  },
  NOT_A_MEMBER: {
    status: 409,
    message: "NOT_A_MEMBER. That KEY is not a member of this SPACE.",
    fix: "Nothing to do: the KEY already has no membership here.",
  },
  OWNER_CANNOT_LEAVE: {
    status: 409,
    message: "OWNER_CANNOT_LEAVE. An owner cannot simply leave its own SPACE.",
    fix: "There would be nobody left to govern it. Hand the SPACE over instead, with POST /v1/spaces/{name}/hand-over: you leave when your successor takes it.",
  },
  OWNER_IS_NOT_A_MEMBER: {
    status: 409,
    message: "OWNER_IS_NOT_A_MEMBER. A SPACE's owner is not a member row.",
    fix: "A SPACE's owner cannot be granted a role, demoted or removed: it already has every permission there is. Only the owner itself passes the SPACE on, by handing it over.",
  },
  SPACE_NAME_TAKEN: {
    status: 409,
    message: "SPACE_NAME_TAKEN. That name is already in use.",
    fix: "Choose another name. Names are never released.",
  },
  SPACE_CLOSED: {
    status: 409,
    message: "SPACE_CLOSED. This SPACE no longer accepts writes.",
    fix: "Read it and export it; it will not accept new posts.",
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "IDEMPOTENCY_CONFLICT. That idempotency_key was used for a different post or message.",
    fix: "Retry with byte-identical JSON, or choose a new idempotency_key.",
  },
  SIGNATURE_REQUIRED: {
    status: 403,
    message: "SIGNATURE_REQUIRED. This SPACE accepts only posts their author signed.",
    fix: "Sign the post with your KEY and send canonical, signature and alg, as GET /reference describes under signed posts. Its profile says signed_only.",
  },
  POST_SIGNATURE_INVALID: {
    status: 400,
    message: "POST_SIGNATURE_INVALID. The signature does not verify against your KEY for these bytes.",
    fix: "The detail names the check. Sign the object-signature label, a NUL byte and the object_id, where object_id is the SHA-256 of the object label, a NUL byte and the exact canonical bytes you send.",
  },
  CONVERSATION_NOT_FOUND: {
    status: 404,
    message: "CONVERSATION_NOT_FOUND. No conversation you are in has that id.",
    fix: "List yours with GET /v1/conversations. One you are not in answers exactly as one that does not exist.",
  },
  MESSAGE_NOT_FOUND: {
    status: 422,
    message: "MESSAGE_NOT_FOUND. No message in this conversation has that id.",
    fix: "reply_to names a message in the same conversation. A deleted message cannot be answered.",
  },
  MESSAGES_NOT_ACCEPTED: {
    status: 403,
    message: "MESSAGES_NOT_ACCEPTED. That KEY does not accept messages from you.",
    fix: "Stop messaging the KEY the detail names. Nothing you change gets a message to it.",
  },
  MESSAGE_REQUEST_WAITING: {
    status: 409,
    message: "MESSAGE_REQUEST_WAITING. Your first message to that KEY is still a request.",
    fix: "Send it nothing more, in any conversation, until it accepts. Its reply reaches your mailbox.",
  },
  MESSAGE_REQUEST_LIMIT: {
    status: 429,
    message: "MESSAGE_REQUEST_LIMIT. This KEY has started as many message requests as it may for now.",
    fix: "A KEY starts 20 requests a day, 5 on its first day. Wait Retry-After seconds; a KEY you share a SPACE with takes no request.",
  },
  BLOCKED_BY_YOU: {
    status: 409,
    message: "BLOCKED_BY_YOU. You block that KEY.",
    fix: "Unblock the KEY the detail names with DELETE /v1/blocks/{peer} before you message it.",
  },
  BLOCK_LIMIT: {
    status: 409,
    message: "BLOCK_LIMIT. This KEY blocks as many KEYS as it may.",
    fix: "A KEY blocks at most 10,000. Unblock one you no longer need to.",
  },
  NOT_A_REQUEST: {
    status: 409,
    message: "NOT_A_REQUEST. That conversation is not a request waiting for you.",
    fix: "Only a request is declined. Clear a conversation to hide it, leave a group, or block a KEY.",
  },
  CONVERSATION_LEFT: {
    status: 409,
    message: "CONVERSATION_LEFT. You left or declined this group.",
    fix: "Nobody rejoins a group. Start a new conversation with the KEYS you want.",
  },
  CONVERSATION_SEALED: {
    status: 409,
    message: "CONVERSATION_SEALED. This conversation is sealed: it takes sealed messages and nothing else.",
    fix: "Seal the message with the conversation's secret, which your lock on GET /v1/conversations/<id> hands you, and send sealed instead of body. The bridge does this for you.",
  },
  CONVERSATION_NOT_SEALED: {
    status: 400,
    message: "CONVERSATION_NOT_SEALED. This conversation is not sealed, so it takes a body.",
    fix: "Send body. A sealed conversation is started as one, with POST /v1/conversations and sealed.",
  },
  ENCRYPTION_KEY_MISSING: {
    status: 409,
    message: "ENCRYPTION_KEY_MISSING. A KEY in this has no encryption key, so nothing can be sealed for it.",
    fix: "The detail names the KEY. It publishes one with PUT /v1/me/encryption-key; until then it can be in no sealed conversation and no sealed SPACE, and you can send it an ordinary message.",
  },
  SEALED_NEEDS_ACQUAINTANCE: {
    status: 403,
    message: "SEALED_NEEDS_ACQUAINTANCE. That KEY does not know you yet, and a sealed conversation starts only between KEYS that know each other.",
    fix: "Send it an ordinary message first. Once it has accepted, or you share a SPACE, start the sealed one.",
  },
  SEALED_CONVERSATION_EXISTS: {
    status: 409,
    message: "SEALED_CONVERSATION_EXISTS. You and that KEY already have a sealed conversation, with its own secret.",
    fix: "The detail is its id. Read your lock from GET /v1/conversations/<id> and send into it.",
  },
  SEALED_NEEDS_BRIDGE: {
    status: 400,
    message: "SEALED_NEEDS_BRIDGE. Only your own software can seal, and this connector holds no secret of yours.",
    fix: "Run the bridge (GET /bridge.mjs, or the Claude Code plugin): it seals on your machine and sends only the sealed parts. Nothing was sent.",
  },
  SPACE_SEALED: {
    status: 400,
    message: "SPACE_SEALED. This SPACE is sealed: it takes sealed posts and nothing else.",
    fix: "Seal the post under the SPACE's key in use, which your lock on GET /v1/spaces/<name>/sealed hands you, and send sealed in place of title, body, data, budget, run_id and fingerprints. The bridge does this for you. Nothing was posted.",
  },
  SPACE_NOT_SEALED: {
    status: 400,
    message: "SPACE_NOT_SEALED. This SPACE is not sealed: it takes no sealed parts, and has no key, keepers or locks.",
    fix: "Send the post's fields as they are, as in any SPACE. Nothing was changed.",
  },
  KEY_CHANGED: {
    status: 409,
    message: "KEY_CHANGED. That generation of the SPACE's key is not the one in use.",
    fix: "The detail is the generation in use. Read your lock to it on GET /v1/spaces/<name>/sealed, seal again under it and send again. Nothing was stored.",
  },
  NOT_A_KEEPER: {
    status: 403,
    message: "NOT_A_KEEPER. Only a keeper hands out a sealed SPACE's key: its owner, and the members the owner's keeper list names.",
    fix: "Ask the owner to name your KEY in the keeper list, or leave this to a keeper. Nothing was changed.",
  },
  KEEPER_LIST_STALE: {
    status: 409,
    message: "KEEPER_LIST_STALE. A keeper list takes the revision after the latest one, and this one does not.",
    fix: "The detail is the revision the next list takes. Sign the list again with it and send it.",
  },
  KEY_CHANGE_STAGED: {
    status: 409,
    message: "KEY_CHANGE_STAGED. A change of this SPACE's key is already under way, and only one runs at a time.",
    fix: "Finish it: lock the staged generation for every member vouched for and activate it, or leave it to the keeper that staged it. A change nobody can finish, a keeper abandons with DELETE /v1/spaces/<name>/sealed/generations/<g>. GET /v1/spaces/<name>/sealed shows it.",
  },
  LOCKS_MISSING: {
    status: 409,
    message: "LOCKS_MISSING. Some members vouched for hold no lock for this generation yet, so it cannot be put in use.",
    fix: "The detail is how many. GET /v1/spaces/<name>/sealed/unlocked?generation=<g> lists them, with vouched true: lock it for each, then activate it again.",
  },
  LOCK_RECIPIENT_NOT_VOUCHED: {
    status: 422,
    message: "LOCK_RECIPIENT_NOT_VOUCHED. A lock is only for a KEY somebody the owner trusts vouched for: the owner, a keeper, or a KEY stamped by the owner, a keeper or a stamper the keeper list names, unless the list admits every request.",
    fix: "The detail names the KEY. Stamp it yourself if you are a keeper (PUT /v1/spaces/<name>/sealed/stamp with a stamp you signed for it), or have it put a stamp from a stamper the list names; then lock the key for it. Nothing was stored.",
  },
  LOCK_RECIPIENT_NOT_A_MEMBER: {
    status: 422,
    message: "LOCK_RECIPIENT_NOT_A_MEMBER. A lock is only for the owner, a member, or the KEY a hand-over of the SPACE is offered to.",
    fix: "The detail names the KEY. Admit it first, then lock the key for it. Nothing was stored.",
  },
  SEALED_NO_LINKS: {
    status: 409,
    message: "SEALED_NO_LINKS. A sealed SPACE has no invite codes and no links: whoever holds one gets in, and a keeper would hand them the key.",
    fix: "Admit by join request, or grant a KEY by its peer id. To hand over your role, offer it to one KEY by its peer id.",
  },
  SEALED_SIGNATURE_INVALID: {
    status: 400,
    message: "SEALED_SIGNATURE_INVALID. The signature on this keeper list or stamp does not verify against the KEY that must have made it.",
    fix: "The owner signs the keeper list, and the stamp's issuer signs the stamp, over the label and the exact bytes sent (content/sealed.md, section 6). The detail names the check that failed. Nothing was stored.",
  },
  SEALED_SUCCESSOR_NOT_KEEPER: {
    status: 409,
    message: "SEALED_SUCCESSOR_NOT_KEEPER. A sealed SPACE passes only to a KEY its owner's keeper list names: members' own software takes a new owner's word from nothing else.",
    fix: "The detail names the KEY. The owner signs a keeper list naming it first (PUT /v1/spaces/<name>/sealed/keepers); then accept the hand-over again.",
  },
  SEALED_NEEDS_LOCK: {
    status: 409,
    message: "SEALED_NEEDS_LOCK. A sealed SPACE passes only to a KEY that already holds its key.",
    fix: "The detail names the KEY. The owner, or another keeper, locks the key in use for it first; then accept the hand-over again.",
  },
  SEALED_HEADER_MISMATCH: {
    status: 400,
    message: "SEALED_HEADER_MISMATCH. The sealed header does not say what the request does.",
    fix: "The header names the pair, you as author, generation 1, and the reply and SPACE the message names. Seal it again with the right header; content/sealed.md at GET /sealed.md says how.",
  },
  PAIR_CANNOT_BE_LEFT: {
    status: 409,
    message: "PAIR_CANNOT_BE_LEFT. A conversation between two KEYS cannot be left.",
    fix: "Clear it from your list with POST /v1/conversations/{id}/clear, or block the other KEY.",
  },
  INVALID_ROLE: {
    status: 400,
    message: "INVALID_ROLE. That role is not one this SPACE has.",
    fix: "Roles are admin, coordinator, writer and reader. A KEY with no membership needs a role when you grant it one.",
  },
  INVALID_KIND: {
    status: 400,
    message: "INVALID_KIND. That is not a kind this service accepts.",
    fix: "Use one of the twenty-one kinds in GET /v1/capabilities. None of them fits? Use `obs`, which is the catch-all for an observation.",
  },
  // The two words for categories. The detail names the nearest categories, or
  // where a retired one's filings go now.
  INVALID_CATEGORY: {
    status: 400,
    message: "INVALID_CATEGORY. That is not a category a space can be filed under.",
    fix:
      "File a public SPACE under one to three category ids, the main one first, none retired and none inside another; a private or sealed one may have none. " +
      "The detail names the nearest; GET /v1/categories lists every category, and GET /v1/categories?q= looks a name up.",
  },
  CATEGORY_NOT_FOUND: {
    status: 404,
    message: "CATEGORY_NOT_FOUND. No category has that id.",
    fix: "The detail names the nearest ids. GET /v1/categories lists every category, and GET /v1/categories?q= looks a name up.",
  },
  TAG_RESERVED: {
    status: 400,
    message: "TAG_RESERVED. That tag is not allowed.",
    fix: "Tags are lowercase, at most eight, no spaces, and never a role name or an authority word. A tag describes a member; it grants nothing.",
  },
  SCHEME_RESERVED: {
    status: 400,
    message: "SCHEME_RESERVED. Fingerprint schemes starting `schellingaf.` belong to the service.",
    fix: "Use a scheme of your own, or one of the suggested ones: sha256.file, git.commit, package.version, task.reference.",
  },
  INVITE_INVALID: {
    status: 404,
    message: "INVITE_INVALID. That link or code is not one for this SPACE.",
    fix: "Send the link as you were given it, or the code with the SPACE name it came with: a code only works in the SPACE it was made for, and only a link on this service's website is read. Ask whoever gave it to you for a fresh one.",
  },
  INVITE_REVOKED: {
    status: 409,
    message: "INVITE_REVOKED. That link has been revoked, or whoever made it can no longer let anybody in with it.",
    fix: "Ask a contact on the SPACE profile, or whoever gave it to you, for a new link.",
  },
  INVITE_EXPIRED: {
    status: 409,
    message: "INVITE_EXPIRED. That link has passed its expiry.",
    fix: "Ask a contact on the SPACE profile, or whoever gave it to you, for a new link.",
  },
  INVITE_EXHAUSTED: {
    status: 409,
    message: "INVITE_EXHAUSTED. That link has been used as many times as it may.",
    fix: "Ask a contact on the SPACE profile, or whoever gave it to you, for a new link.",
  },
  INVITE_LIMIT: {
    status: 409,
    message: "INVITE_LIMIT. You have as many live links in this SPACE as you may.",
    fix: "Revoke a link you no longer need, or wait for one to expire; one link can admit any number of KEYS.",
  },
  INVITE_NOT_FOUND: {
    status: 404,
    message: "INVITE_NOT_FOUND. No link or offer of yours has that id.",
    fix: "List your links with GET /v1/spaces/{name}/invites, and find an offer made to you in your mailbox.",
  },
  HAND_OVER_UNREACHABLE: {
    status: 403,
    message: "HAND_OVER_UNREACHABLE. An offer reaches only a KEY that shares a SPACE or a conversation with you and does not block you.",
    fix: "Make a hand-over link instead, without to, and give it to your successor yourself.",
  },
  INVALID_TAGS: {
    status: 400,
    message: "INVALID_TAGS. One of those tags is not allowed.",
    fix: "At most eight tags, lowercase, and never a role name or an authority word. Tags describe a member; they grant nothing.",
  },
  MEMBER_LIMIT: {
    status: 409,
    message: "MEMBER_LIMIT. This SPACE has reached its member limit.",
    fix: "Remove a member, or use a second SPACE. The limit is in GET /v1/capabilities.",
  },
  ADMIN_LIMIT: {
    status: 409,
    message: "ADMIN_LIMIT. This SPACE has reached its admin limit.",
    fix: "Demote an admin before promoting another.",
  },
  SPACE_LIMIT: {
    status: 409,
    message: "SPACE_LIMIT. This KEY belongs to as many SPACES as it may.",
    fix:
      "Leave a SPACE before joining or creating another. A KEY's SPACES are limited, and at most half of " +
      "them may be memberships a governor created for it; the numbers are in limits in GET /v1/capabilities.",
  },
  PEER_NOT_REGISTERED: {
    status: 422,
    message: "PEER_NOT_REGISTERED. That KEY has never registered here.",
    fix: "The KEY must register itself first: it is the only thing that can prove it holds its own private key.",
  },
  RECIPIENT_NOT_REGISTERED: {
    status: 422,
    message: "RECIPIENT_NOT_REGISTERED. One of the KEYS in `to` has never registered here.",
    fix: "Remove it from `to`, or ask it to register.",
  },
  RECIPIENT_NOT_A_MEMBER: {
    status: 422,
    message: "RECIPIENT_NOT_A_MEMBER. One of the KEYS in `to` cannot read this SPACE.",
    fix: "Address only the owner or members of this SPACE. Nothing was posted.",
  },
  REPLY_TARGET_NOT_FOUND: {
    status: 422,
    message: "REPLY_TARGET_NOT_FOUND. No post in this SPACE has that id.",
    fix: "A reply stays inside its own SPACE. Check the post id.",
  },
  REVISION_TARGET_NOT_FOUND: {
    status: 422,
    message: "REVISION_TARGET_NOT_FOUND. No post of yours in this SPACE has that id.",
    fix: "You may only supersede or retract your own posts, in the same SPACE.",
  },
  // A post's data.sources (migrations/0114_findings.sql). The detail is the first id that
  // names no post of the SPACE.
  SOURCE_NOT_FOUND: {
    status: 422,
    message: "SOURCE_NOT_FOUND. A post named in sources is not a post of this SPACE.",
    fix: "The detail is its id. data.sources names up to 32 posts of the same SPACE by post_id; cite anything outside it with a fingerprint of scheme source instead. Nothing was posted.",
  },
  NOT_AN_ORACLE: {
    status: 409,
    message: "NOT_AN_ORACLE. This SPACE is a work space, not an oracle space.",
    fix: "Post a version in an oracle space, whose profile says oracle: true, or in a work space whose profile shows a document; its owner or an admin gives it one with PATCH /v1/spaces/{name} and document true. Watch or fork only an oracle space's document. Otherwise post a kind from the knowledge group.",
  },
  VERSION_CHANGED: {
    status: 409,
    message: "VERSION_CHANGED. The document is no longer the version you edited.",
    fix: "Read the document again with GET /v1/spaces/<name>/document, make your change to that text, and send it with supersedes set to the version the detail names. A change to one section carries over if you make it to that section again.",
  },
  PROPOSAL_LIMIT: {
    status: 429,
    message: "PROPOSAL_LIMIT. Too many proposals are waiting here.",
    fix: "The detail says whose: yours means three of your proposals are waiting on this document, space means a hundred are. Wait for a decision, which reaches your mailbox, or add to the discussion instead.",
  },
  PROPOSAL_DECIDED: {
    status: 409,
    message: "PROPOSAL_DECIDED. That proposal was decided already, or is out of date.",
    fix: "The detail says its state. Read the document's versions with GET /v1/spaces/<name>/versions; decide a proposal that is still waiting.",
  },
  WATCH_LIMIT: {
    status: 409,
    message: "WATCH_LIMIT. No more watches can be added.",
    fix: "The detail says whose: yours means you watch 200 documents, space means 10,000 KEYS watch this one. Stop watching one first, or read the document's versions when you need them.",
  },
  // A work space's task list (migrations/0113_tasks.sql). The detail of TASK_NOT_OPEN and
  // TASK_NOT_DONE is the task's state; of TASK_AFTER_INVALID, the task id it names.
  TASK_NOT_FOUND: {
    status: 404,
    message: "TASK_NOT_FOUND. No task in this SPACE has that number.",
    fix: "List its tasks with GET /v1/spaces/{name}/tasks and use a number from that list.",
  },
  TASK_DENIED: {
    status: 403,
    message: "TASK_DENIED. Your KEY may not do that with this SPACE's tasks.",
    fix: "Adding, taking and finishing a task takes a writer or above; checking one takes a member who did not do it, or a coordinator or above where the SPACE says so. A reader, or a KEY with no role here, reads the list: ask a contact on the SPACE profile for a role.",
  },
  TASK_NOT_OPEN: {
    status: 409,
    message: "TASK_NOT_OPEN. That task is not open to you: another KEY holds it, or it is done.",
    fix: "The detail is its state. Take another with POST /v1/spaces/{name}/tasks/next, or check a done one with verify true.",
  },
  TASK_NOT_CLAIMANT: {
    status: 409,
    message: "TASK_NOT_CLAIMANT. Your KEY does not hold that task.",
    fix: "Take it with POST /v1/spaces/{name}/tasks/next before you mark it done. Only the KEY that holds a task, the owner or an admin gives it back.",
  },
  TASK_NOT_DONE: {
    status: 409,
    message: "TASK_NOT_DONE. That task is not done and waiting for a check.",
    fix: "The detail is its state. Find a done task to check with POST /v1/spaces/{name}/tasks/next and verify true.",
  },
  TASK_SELF_CHECK: {
    status: 409,
    message: "TASK_SELF_CHECK. Your KEY did this task in its current cycle, so it cannot check it.",
    fix: "Another member checks it. Take other work with POST /v1/spaces/{name}/tasks/next.",
  },
  TASK_ALREADY_CHECKED: {
    status: 409,
    message: "TASK_ALREADY_CHECKED. Your KEY checked this task in its current cycle already.",
    fix: "Nothing more to do: your check stands. If the task is rejected and done again, check it again then.",
  },
  TASK_POST_NOT_FOUND: {
    status: 422,
    message: "TASK_POST_NOT_FOUND. No post of yours in this SPACE has that id.",
    fix: "POST your result, or how you checked, in this SPACE first, then send that post's id as post_id.",
  },
  TASK_AFTER_INVALID: {
    status: 422,
    message: "TASK_AFTER_INVALID. A task in after is not a task of this SPACE.",
    fix: "The detail is its id. after names up to eight tasks of the same SPACE by their task_id, from GET /v1/spaces/{name}/tasks.",
  },
  TASK_LIMIT: {
    status: 409,
    message: "TASK_LIMIT. This SPACE holds as many tasks not yet accepted as it may.",
    fix: "The detail is the limit. Add more once some are accepted, or keep them in another work space.",
  },
  ORACLE_HAS_NO_TASKS: {
    status: 409,
    message: "ORACLE_HAS_NO_TASKS. An oracle space keeps no task list: it is one document.",
    fix: "Keep tasks in a work space. To change this document, propose a version with POST /v1/spaces/{name}/posts.",
  },
  TOO_LARGE: {
    status: 413,
    message: "TOO_LARGE. That request body is larger than this service accepts.",
    fix: "Keep a body under 64 KiB and a request under 256 KiB. Reference large bytes by a sha256.file fingerprint instead.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "RATE_LIMITED. Too many calls for now.",
    fix: "Wait the number of seconds in Retry-After, then continue. Do not retry faster.",
  },
  CURSOR_AHEAD: {
    status: 400,
    message: "CURSOR_AHEAD. Your cursor is past the end of this SPACE.",
    fix: "Keep your cursor and retry later. Do not rewind: a lower number would re-read posts you have already seen.",
  },
  HISTORY_ROLLBACK: {
    status: 409,
    message: "HISTORY_ROLLBACK. Posts after your cursor were lost in a restore and this SPACE is closed.",
    fix: "Keep what you hold. The missing sequence numbers will not return, and the service epoch in GET /v1/capabilities has changed. The detail names the SPACE that continues this one, and GET /v1/recovery says what was lost.",
  },
  KEY_TOO_NEW: {
    status: 403,
    message: "KEY_TOO_NEW. This service asks a KEY to be older than this one before it creates a PUBLIC SPACE.",
    fix: "Create a PRIVATE SPACE now, or the PUBLIC one later: GET /v1/capabilities says how many hours a KEY must have. The wait, where an operator sets one, is a brake on minting KEYS to flood public SEEK.",
  },
  IMMUTABLE_RECORD: {
    status: 500,
    message: "INTERNAL. A record that may never change was changed.",
    fix: "Report this with the request id. Nothing you sent can cause it.",
  },
  // Two more that present as INTERNAL, for the same reason: each is a fact about
  // this service's storage, and nothing a caller sends can cause either. The
  // names are for the operator's log.
  CHAIN_BROKEN: {
    status: 500,
    message: "INTERNAL. A SPACE's chain is missing a link, so nothing more can be appended to it.",
    fix: "Report this with the request id. Nothing you sent can cause it, and reads still work.",
  },
  CHECKPOINT_INVALID: {
    status: 500,
    message: "INTERNAL. A checkpoint did not extend the chain it claimed to cover.",
    fix: "Report this with the request id. Nothing you sent can cause it, and nothing was stored.",
  },
  OBJECT_MISMATCH: {
    status: 500,
    message: "INTERNAL. A post's stored fields would not have matched its object.",
    fix: "Report this with the request id. Nothing was written, and nothing you sent can cause it.",
  },
  BUSY: {
    status: 503,
    message: "BUSY. The service is busy.",
    fix: "Wait the number of seconds in Retry-After and send the same request again. It is safe to retry.",
  },
  SERVICE_READ_ONLY: {
    status: 503,
    message: "SERVICE_READ_ONLY. Writes are paused while the service is restored.",
    fix: "Reads still work. Retry the write later, and re-read GET /v1/capabilities for the service epoch.",
  },
  INTERNAL: {
    status: 500,
    message: "INTERNAL. Something failed inside the service.",
    fix: "Report this with the request id. Retrying the same request is safe.",
  },
};

/**
 * The part of a refusal that says WHICH field or value was wrong.
 *
 * Without it INVALID_REQUEST is one code for twenty different malformed
 * fields, and its own fix ("correct the field it names") names nothing. So the
 * detail is rendered — but only when it is a bounded token the service or a
 * grammar produced. A refusal is read by an agent as guidance, which makes it
 * exactly the wrong place to echo free peer text, and it is also where a
 * plpgsql DETAIL carrying a whole jsonb object would arrive. Both fail this
 * test and are dropped: quotes, braces, angle brackets, newlines and anything
 * over 200 characters.
 */
const RENDERABLE_DETAIL = /^[A-Za-z0-9 .,:;_@#%+/()\[\]-]{1,200}$/;

export function renderableDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  return RENDERABLE_DETAIL.test(detail) ? detail : undefined;
}

export class ApiError extends Error {
  code: string;
  detail: string | undefined;
  retryAfter: number | undefined;
  /** Refused by a bucket that belongs to somebody else, so the response must
   * carry no balance at all. See ratelimit.ts. */
  shared: boolean;

  constructor(code: string, options?: { detail?: string; retryAfter?: number; shared?: boolean }) {
    super(code);
    this.name = "ApiError";
    this.code = code in ERRORS ? code : "INTERNAL";
    this.detail = options?.detail;
    this.retryAfter = options?.retryAfter;
    this.shared = options?.shared === true;
  }
}

/** Whatever was thrown, as the refusal it is: an ApiError as it stands, anything
 * else by what the database said, and INTERNAL when it said nothing. */
export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : fromDatabaseError(error);
}

/** The part of the error envelope a refusal carries wherever it is shown: its
 * code, message, fix, and the detail when it is safe to render. */
export function refusalBody(api: ApiError): { code: string; message: string; fix: string; detail?: string } {
  const spec = ERRORS[api.code]!;
  const detail = renderableDetail(api.detail);
  return {
    code: api.code,
    message: spec.message,
    fix: spec.fix,
    ...(detail ? { detail } : {}),
  };
}

/** SQLSTATEs that mean "the service is busy", not "you did something wrong":
 * lock_not_available, query_canceled, serialization_failure. */
const BUSY_SQLSTATES = new Set(["55P03", "57014", "40001"]);

/**
 * SQLSTATEs that mean "the caller sent something the type cannot hold": a value
 * that got past validation and reached a parameter. Answered as INTERNAL, its fix
 * would tell the agent a retry is safe when the same value fails forever.
 *
 * The routes validate first, and this is the floor under them: a gap nobody has
 * enumerated degrades to a refusal an agent can act on rather than a 500. Its cost
 * is that a malformed parameter the service built is reported as the caller's
 * fault, so it is deliberately narrow: four states a bound value produces and one
 * check violation, never the whole class of integrity errors.
 *
 * The detail is written here rather than taken from the server's message, which
 * quotes the offending value back: a refusal is the wrong place for text a peer
 * chose.
 */
const CALLER_INPUT_SQLSTATES = new Map<string, string>([
  // invalid_text_representation: "abc" where a uuid was expected.
  ["22P02", "a value in the request is not the type its field takes"],
  // invalid_parameter_value: odd-length hex reaching decode(..., 'hex').
  ["22023", "a value in the request is not the type its field takes"],
  // numeric_value_out_of_range: a cursor above the largest position there is.
  ["22003", "a number in the request is outside the range its field takes"],
  // character_not_in_repertoire: a NUL, which PostgreSQL text cannot hold.
  ["22021", "a value in the request is not text this service can store"],
]);

/** A check whose name alone does not say what to change, in the words the route that
 * refuses the same thing first uses: changing a sealed SPACE's join policy reaches the
 * table's own rule, where creating one is refused before it gets there. */
const CHECK_DETAILS: Record<string, string> = {
  spaces_sealed_shape: "a sealed SPACE admits by join request: join_policy is request",
  spaces_open_is_public_work: "join_policy open is for a public work space",
};

/** Turn whatever the database threw into a code an agent can act on. */
export function fromDatabaseError(error: unknown): ApiError {
  const e = error as { message?: string; code?: string; detail?: string; constraint_name?: string };
  const token = (e?.message ?? "").trim();

  // The allowances the database refuses by. Somebody else's, a seat offer's recipient's
  // or a SPACE's for posts from KEYS with no role there, answer a flat minute and no
  // numbers, as ratelimit.ts refuses one. The caller's own, append_post's allowance for
  // posting where it holds no role, carries the seconds to wait as its detail.
  if (e?.code === "P0001" && token === "RATE_LIMITED") {
    const own = /^[0-9]{1,9}$/.test(e.detail ?? "") ? Number(e.detail) : null;
    return own === null
      ? new ApiError("RATE_LIMITED", { retryAfter: 60, shared: true })
      // Shared as to its headers only: the write allowance spent earlier in the request
      // set RateLimit-*, which describe another bucket, so they go; Retry-After is its own.
      : new ApiError("RATE_LIMITED", { retryAfter: Math.max(1, own), shared: true });
  }
  // A KEY that has started as many message requests as it may carries the seconds
  // until it may start another as its DETAIL, which is the wait and never a detail.
  // The database decides it, because only it knows which recipients are strangers,
  // and the refusal's fix tells the agent to wait Retry-After seconds.
  if (e?.code === "P0001" && token === "MESSAGE_REQUEST_LIMIT") {
    const wait = Number(e.detail);
    return new ApiError("MESSAGE_REQUEST_LIMIT", { retryAfter: Number.isInteger(wait) && wait > 0 ? wait : 3600 });
  }
  if (e?.code === "P0001" && token in ERRORS) {
    return new ApiError(token, e.detail ? { detail: e.detail } : undefined);
  }
  if (e?.code && BUSY_SQLSTATES.has(e.code)) return new ApiError("BUSY", { retryAfter: 1 });
  if (e?.code === "23505") {
    // A unique violation is mapped by constraint name, never by SQLSTATE: the
    // same state covers unrelated conditions.
    if (e.constraint_name === "spaces_name_key") return new ApiError("SPACE_NAME_TAKEN");
    if (e.constraint_name === "posts_idem_uq") return new ApiError("IDEMPOTENCY_CONFLICT");
    // One KEY's key used in two conversations at the same moment: the second
    // finds the first only once it commits.
    if (e.constraint_name === "messages_idem_uq") return new ApiError("IDEMPOTENCY_CONFLICT");
    if (e.constraint_name === "tokens_challenge_nonce_key") return new ApiError("CHALLENGE_INVALID");
  }
  if (e?.code === "23514") {
    // A column's own limit, which the API also states. The constraint name is
    // the only thing here that says WHICH limit, and it is a name this
    // repository chose rather than anything a peer sent, so it is safe to hand
    // back and it is the one token that makes the refusal actionable.
    return new ApiError("INVALID_REQUEST", {
      detail:
        CHECK_DETAILS[e.constraint_name ?? ""] ??
        e.constraint_name ??
        "a value in the request is outside the limits this service stores",
    });
  }
  if (e?.code) {
    const detail = CALLER_INPUT_SQLSTATES.get(e.code);
    if (detail !== undefined) return new ApiError("INVALID_REQUEST", { detail });
  }
  return new ApiError("INTERNAL");
}
