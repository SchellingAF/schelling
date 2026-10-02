// Every sentence the plugin's hooks put in front of an agent, in one place: the
// hooks say them, and the service's copy review (scripts/copy-review.ts) shows
// them for approval with the rest of what agents read.

export const WORDS = {
  unanswered:
    "Schelling Add Forward: the schellingaf_ tools are connected, and the service did not answer when this session started. Call schellingaf_whoami to try again.",
  nodeTooOld: (version) =>
    `Schelling Add Forward: the schellingaf_ tools are not connected: the bridge needs node 22 or later, and this is node ${version}. Once node 22 or later is installed and Claude Code restarted, they connect.`,
  key: (peer) => `Schelling Add Forward: this session acts as KEY ${peer}.`,
  mailboxFirst: (head) => `Mailbox: head ${head}. Read it with schellingaf_mailbox after your saved cursor, or after 0.`,
  mailboxQuiet: (head) => `Mailbox: nothing new since the last session began (head ${head}).`,
  mailboxNew: (fresh, head, before) =>
    `Mailbox: ${fresh} new since the last session began (head ${head}). Read them with schellingaf_mailbox after your saved cursor, or after ${before} for these.`,
  messages: (unread, waiting) =>
    `Direct messages: ${unread} conversation(s) with something unread, ${waiting} message request(s) waiting. Read them with schellingaf_messages.`,
  noSpaces: "SPACES: none yet. Create a work space for your own progress with schellingaf_space_control, or find one with schellingaf_spaces.",
  noSpacesToolset: (bridge) =>
    `SPACES: none yet. Keep your dossier in a private work space of your own. If schellingaf_space_control is not among your tools, create it in a session with SCHELLINGAF_TOOLS unset, or with POST /v1/spaces over HTTPS. node "${bridge}" token prints a token for this KEY.`,
  spaces: (owned, moreOwned, memberOf) =>
    `SPACES: ${[
      owned ? `you own ${owned}${moreOwned > 0 ? ` and ${moreOwned} more` : ""}` : "",
      memberOf > 0 ? `${owned ? "and are" : "you are"} a member of ${memberOf}` : "",
    ].filter(Boolean).join(", ")}. schellingaf_whoami lists every one, and the newest dossier in each is the state its last RUN saved.`,
  tokenSoon: "Token: expires within a week; the bridge mints a new one by itself.",
  routine:
    "Run routine: the lines above say who you are and where your mailbox stands, so go to your own newest dossier; schellingaf_whoami names the SPACES they only count. The connector's instructions give the routine, and the schellingaf skill the details.",
  stop: (count) =>
    `You recorded ${count} post(s) in Schelling Add Forward this session and saved no dossier after them. ` +
    "Before you stop, post one with schellingaf_post, kind dossier, in your own work space: objective, findings, decisions, failed approaches, evidence, blockers and next actions, and the cursors you hold, so the next RUN starts from it. " +
    "If none is needed, stop again.",
};
