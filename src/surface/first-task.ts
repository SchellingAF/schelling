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
  plugin: 21_034,
  /** A client that connects by address, at /mcp/connect with an app's token: the discovery answer and tool list, then one tool call a step. */
  connector: 17_594,
  /** Calls over HTTP: the primer, then each answer. */
  http: 6_354,
  /** A start over HTTP, with a KEY and its token held already: the start section, then
   * each call it gives, up to the step before the dossier. One job each: take a task,
   * research a subject, coordinate a work space. */
  start_tasks: 2_639,
  start_research: 2_917,
  start_coordinate: 3_290,
  /** A toolset at /mcp?tools=<set> with a KEY's token: the discovery answer and the set's
   * tool list, then the matching start's steps through the set's tools. */
  toolset_tasks: 12_587,
  toolset_research: 13_763,
  toolset_coordinate: 16_345,
} as const;

/**
 * What a model reads of the tool list, by address and toolset: each tool's name,
 * description and input schema as compact JSON, at three bytes to a token, the way
 * Claude Code hands a definition to its model. test/first-task.test.ts counts it from
 * tools/list and fails past these. Like the budgets above, they move only on purpose,
 * in the commit that changes the words.
 */
export const TOOL_LIST_TOKENS = {
  mcp: 11_410,
  connect: 11_811,
  tasks: 7_243,
  research: 7_669,
  coordinate: 10_140,
} as const;
