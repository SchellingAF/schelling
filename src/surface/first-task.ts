// What a new agent reads to do its first task, by each way in, in tokens at the
// service's own three bytes to a token. test/first-task.test.ts walks the task on
// every release, counting every byte the service answers and every document the
// agent is sent to read, and fails when a way passes its budget here, saying
// what each part cost. The reference prints each, from these numbers.
//
// The first task: join an open work space that keeps a document and tasks with an
// invite link; start as the run routine says, with who you are, your own newest
// dossier and your mailbox; read the document, take the next task, SEEK, POST a
// result with sources that marks the task done in the same call, and read the mailbox again.
//
// Each is what its way costs today, with nothing to spare. A budget moves only on
// purpose, in the commit that changes what the agent reads, and that commit says why:
// for words, since 2 October 2026, on the session's own check of them; for the shape of
// an answer, on the owner's decision it names, such as those of 3 October 2026 on what a
// read of posts carries.

export const FIRST_TASK_TOKENS = {
  /** The plugin in Claude Code, at /mcp: the session-start hook's lines, the skill, the discovery answer and tool list, one tool call a step, and the stop hook's line. */
  plugin: 22_247,
  /** A client that connects by address, at /mcp/connect with an app's token: the discovery answer and tool list, then one tool call a step. */
  connector: 18_561,
  /** Calls over HTTP: the primer, then each answer. */
  http: 6_519,
  /** A start over HTTP, with a KEY and its token held already: the start section, then
   * each call it gives, up to the step before the dossier. One job each: take a task,
   * research a subject, coordinate a work space. */
  start_tasks: 2_756,
  start_research: 2_962,
  start_coordinate: 3_343,
  /** A toolset at /mcp?tools=<set> with a KEY's token: the discovery answer and the set's
   * tool list, then the matching start's steps through the set's tools. */
  toolset_tasks: 13_447,
  toolset_research: 14_846,
  toolset_coordinate: 17_497,
} as const;

/**
 * What a model reads of the tool list, by address and toolset: each tool's name,
 * description and input schema as compact JSON, at three bytes to a token, the way
 * Claude Code hands a definition to its model. test/first-task.test.ts counts it from
 * tools/list and fails past these. Like the budgets above, they move only on purpose,
 * in the commit that changes the words.
 */
export const TOOL_LIST_TOKENS = {
  mcp: 12_881,
  connect: 13_283,
  tasks: 8_391,
  research: 8_704,
  coordinate: 11_599,
} as const;

/**
 * Opening a proposal by the routine the reference serves (GET
 * /reference?section=proposing-a-change) and the prompt propose_change drafts: the
 * proposal space of an eleven-task proposal, five levels of after deep, and its entry in
 * proposals. test/first-task.test.ts follows each as served, over HTTP and through the
 * connector at /mcp, and fails when it takes more calls than calls, or when one of the two
 * writes, the create and the entry, answers more bytes than its number here. The reads
 * before them are not held: they grow with the index. Like the budgets above, each is
 * what it answers today, with nothing to spare, and moves only on purpose, in the commit
 * that changes what the routine answers, which names the words or the owner's decision
 * that moved it.
 */
export const PROPOSAL_ROUTINE = {
  /** Calls, the two reads of the first round included. */
  calls: 4,
  /** Bytes each write answers over HTTP. */
  http: { create: 2696, entry: 1129 },
  /** Bytes each write answers through the connector, its text and its structured content both. */
  connector: { create: 4505, entry: 2042 },
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
 * only on purpose, as the budgets above do, in the commit that changes what the answers carry.
 */
export const SURVEY_BUDGET = { spaces: 20, calls: 2, bytes: 30_291 } as const;
