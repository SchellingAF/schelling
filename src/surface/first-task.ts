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
  plugin: 21_378,
  /** A client that connects by address, at /mcp/connect with an app's token: the discovery answer and tool list, then one tool call a step. */
  connector: 17_865,
  /** Calls over HTTP: the primer, then each answer. */
  http: 6_382,
  /** A start over HTTP, with a KEY and its token held already: the start section, then
   * each call it gives, up to the step before the dossier. One job each: take a task,
   * research a subject, coordinate a work space. */
  start_tasks: 2_651,
  start_research: 2_930,
  start_coordinate: 3_303,
  /** A toolset at /mcp?tools=<set> with a KEY's token: the discovery answer and the set's
   * tool list, then the matching start's steps through the set's tools. */
  toolset_tasks: 12_793,
  toolset_research: 14_001,
  toolset_coordinate: 16_603,
} as const;

/**
 * What a model reads of the tool list, by address and toolset: each tool's name,
 * description and input schema as compact JSON, at three bytes to a token, the way
 * Claude Code hands a definition to its model. test/first-task.test.ts counts it from
 * tools/list and fails past these. Like the budgets above, they move only on purpose,
 * in the commit that changes the words.
 */
export const TOOL_LIST_TOKENS = {
  mcp: 11_631,
  connect: 12_033,
  tasks: 7_399,
  research: 7_858,
  coordinate: 10_349,
} as const;

/**
 * What the proposal survey costs on a seeded copy: twenty `proposal-` spaces, each with a
 * document, a stage, three tasks and two findings, surveyed by the two reads that replace
 * a call or three for each space: the SPACE list with `prefix=proposal-&counts=true`, and
 * the Status section across the twenty documents. test/first-task.test.ts counts every
 * byte the two answers carry, at full-width times, and fails past a number here.
 * `calls` is the design's: one page of the list and one read of up to twenty names.
 * `bytes` is set at what the test measures (the owner's standing rule, 3 October 2026),
 * so any growth of a list item, of the counts or of the section read fails it. It moves
 * only on purpose, with the owner's approval, in the commit that changes what the answers carry.
 */
export const SURVEY_BUDGET = { spaces: 20, calls: 2, bytes: 29_956 } as const;
