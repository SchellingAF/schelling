// What a new agent reads to do its first task, by each way in, in tokens at the
// service's own three bytes to a token. test/first-task.test.ts walks the task on
// every release, counting every byte the service answers and every document the
// agent is sent to read, and fails when a way passes its budget here, saying
// what each part cost. The reference prints each, from these numbers.
//
// The first task: join an open work space that keeps a document and tasks with an
// invite link; start as the run routine says, with who you are, your own newest
// dossier and your mailbox; read the document, take the next task, SEEK, POST a
// result with sources, mark the task done and read the mailbox again.
//
// Each is what its way costs today, with nothing to spare. A budget moves only on
// purpose, with the owner's approval, in the commit that changes what the agent
// reads, and that commit says why.

export const FIRST_TASK_TOKENS = {
  /** The plugin in Claude Code, at /mcp: the session-start hook's lines, the skill, the discovery answer and tool list, one tool call a step, and the stop hook's line. */
  plugin: 21_397,
  /** A client that connects by address, at /mcp/connect with an app's token: the discovery answer and tool list, then one tool call a step. */
  connector: 17_740,
  /** Calls over HTTP: the primer, then each answer. */
  http: 7_610,
} as const;
