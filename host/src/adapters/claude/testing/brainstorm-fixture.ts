// The first turn of the operator's "Brainstorm-BROCODE" session (2026-10-24, Claude Code 2.1.308, SDK
// 0.3.308), reduced to the calls that registered engine tasks, as FakeClaude steps for the adapter tests.
//
// Where each part comes from:
// - tool_use ids, inputs (descriptions; commands shortened), the order of calls and the shape of every
//   tool_use_result: the session's Claude Code transcript (projects/-Users-mabue-BROCODE/1bcf050a-….jsonl);
// - the task ids and how each task ended: the task notifications the host journaled for the session
//   (journal.sqlite, ses_0mvm4qj9kbd1feefc8e45bffb, "background task: …" items);
// - the system/task_* and background_tasks_changed messages around them: the transcript does not keep
//   system messages, so they follow what raw query() repros sent on 2026-10-24 (same SDK and CLI, haiku):
//   a Bash call running past about 3 s is registered as a task in the foreground (task_started
//   is_backgrounded false) and, when it finishes in time, ends with task_notification completed just
//   before its normal tool result; one that runs past its timeout joins the live set
//   (background_tasks_changed), gets task_updated {is_backgrounded: true} and a tool result naming
//   backgroundTaskId; TaskStop sends task_updated {status: killed}, task_notification stopped and an
//   empty live set.
//
// Six tasks: bly0wsn1q timed out into the background and was stopped with TaskStop; bh3714u1b,
// b0agpc0c8, boeez5w84, btydc7nni and b8h3y0909 were Bash calls of 4 to 8 s that never left the
// foreground (their results carry their full output and came back before the next call).
import type { FakeClaudeStep } from './fake-query.js';

type Json = Record<string, unknown>;

let messageNumber = 0;
const assistantToolUse = (id: string, name: string, input: Json): FakeClaudeStep => ({
  message: { type: 'assistant', message: { id: `msg_brainstorm_${++messageNumber}`, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null },
});
const toolResult = (id: string, content: string, toolUseResult: Json): FakeClaudeStep => ({
  message: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null, tool_use_result: toolUseResult },
});
const system = (subtype: string, fields: Json): FakeClaudeStep => ({ message: { type: 'system', subtype, ...fields } });

/** A finished Bash result as Claude Code shapes it. */
const bashOutput = (stdout: string): Json => ({ stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false });

/** A Bash call that finishes in the foreground but runs long enough to be registered as a task. */
function foregroundTask(toolUseId: string, taskId: string, description: string, command: string): FakeClaudeStep[] {
  return [
    assistantToolUse(toolUseId, 'Bash', { command, description }),
    system('task_started', { task_id: taskId, tool_use_id: toolUseId, description, is_backgrounded: false, task_type: 'local_bash' }),
    system('task_notification', { task_id: taskId, tool_use_id: toolUseId, status: 'completed', output_file: '', summary: description }),
    toolResult(toolUseId, `output of ${taskId}`, bashOutput(`output of ${taskId}`)),
  ];
}

/** A quick Bash call: no task at all. */
function quickBash(toolUseId: string, description: string, command: string): FakeClaudeStep[] {
  return [assistantToolUse(toolUseId, 'Bash', { command, description }), toolResult(toolUseId, 'ok', bashOutput('ok'))];
}

export const BRAINSTORM_BACKGROUND = { toolUseId: 'toolu_01EF4onkCT23MTWQKTnG3SY5', taskId: 'bly0wsn1q', title: 'Read CLAUDE.md, list projects, search for nano-remote and mattcopock' };

/** The five Bash calls that were registered as tasks and finished in the foreground. */
export const BRAINSTORM_FOREGROUND = [
  { toolUseId: 'toolu_01BQkiWxFC4Dv4qYnQjfjiKH', taskId: 'bh3714u1b', title: 'Look for mattcopock/pocock skills and global CLAUDE.md' },
  { toolUseId: 'toolu_01D27jytaACwyMjudmEVBxnn', taskId: 'b0agpc0c8', title: 'Query BROCODE service state and Beads trackers in both projects' },
  { toolUseId: 'toolu_01DZMF8WhKdKTL31V3HS3477', taskId: 'boeez5w84', title: 'Read BROCODE spec outline, connectors epic, and history' },
  { toolUseId: 'toolu_01A3E63oZFqL8fiB6A1z9BBk', taskId: 'btydc7nni', title: 'Read NANO-REMOTE open epics and host source layout' },
  { toolUseId: 'toolu_01P4FNCdKV5z1gQShxsibT8M', taskId: 'b8h3y0909', title: 'Read BROCODE controller spec, delivery sequence, slice 3 and connector tickets' },
];

const bg = BRAINSTORM_BACKGROUND;
const [look, query, outline, epics, controller] = BRAINSTORM_FOREGROUND.map((t) => foregroundTask(t.toolUseId, t.taskId, t.title, `# ${t.title}`));

/** The turn, in the order the engine sent it; it ends with a text reply. */
export const BRAINSTORM_TURN: FakeClaudeStep[] = [
  ...quickBash('toolu_01LQ3bmLHARgSSFSvEB4sKzF', 'Locate BROCODE, nano-remote, and mattcopock skills', 'ls -la ~/Projects/BROCODE'),
  // Default 120 s timeout: registered in the foreground, then moved to the background.
  assistantToolUse(bg.toolUseId, 'Bash', { command: 'cd /Users/mabue/BROCODE; cat CLAUDE.md; find /Users/mabue -maxdepth 4 -iname "*nano*remote*"', description: bg.title }),
  system('task_started', { task_id: bg.taskId, tool_use_id: bg.toolUseId, description: bg.title, is_backgrounded: false, task_type: 'local_bash' }),
  system('background_tasks_changed', { tasks: [{ task_id: bg.taskId, task_type: 'local_bash', description: bg.title }] }),
  system('task_updated', { task_id: bg.taskId, patch: { is_backgrounded: true } }),
  toolResult(bg.toolUseId, `Command did not complete within its 120s timeout and was moved to the background (ID: ${bg.taskId}).`, {
    ...bashOutput(''),
    backgroundTaskId: bg.taskId,
    timedOutAfterMs: 120000,
    backgroundCwdHint: 'Session cwd remains /Users/mabue/BROCODE; directory changes made by the backgrounded command do not apply to subsequent commands',
  }),
  ...quickBash('toolu_018FT27CNPBwULVgvej3meUc', 'Check interim output of background search', `cat /private/tmp/tasks/${bg.taskId}.output | head -150`),
  assistantToolUse('toolu_018xm5L8S195doj7j6XLqHgc', 'ToolSearch', { query: 'select:TaskStop' }),
  toolResult('toolu_018xm5L8S195doj7j6XLqHgc', 'TaskStop', { matches: ['TaskStop'], query: 'select:TaskStop', total_deferred_tools: 76 }),
  ...quickBash('toolu_017BGH7jxaS7MXuEuGpFJCFp', 'Inspect BROCODE project root and docs', 'ls -la'),
  ...quickBash('toolu_01R9U3NNSPBuBrijuAuLEfJW', 'Inspect NANO-REMOTE project root and docs', 'ls -la'),
  assistantToolUse('toolu_01Xeny1igEMnG5SP2DgxSvrN', 'TaskStop', { task_id: bg.taskId }),
  system('task_updated', { task_id: bg.taskId, patch: { status: 'killed', end_time: 1792830261000 } }),
  system('task_notification', { task_id: bg.taskId, tool_use_id: bg.toolUseId, status: 'stopped', output_file: `/private/tmp/tasks/${bg.taskId}.output`, summary: bg.title }),
  system('background_tasks_changed', { tasks: [] }),
  toolResult('toolu_01Xeny1igEMnG5SP2DgxSvrN', `{"message":"Successfully stopped task: ${bg.taskId}"}`, {
    message: `Successfully stopped task: ${bg.taskId}`,
    task_id: bg.taskId,
    task_type: 'local_bash',
    command: 'cd /Users/mabue/BROCODE; …',
  }),
  ...quickBash('toolu_01EdbysCP948tt5Pe7tSZchP', 'Read BROCODE context, package layout, docs list, git history', 'cat CONTEXT.md'),
  ...look!,
  ...query!,
  ...quickBash('toolu_01KuxNcSR727EvkbKiQBK3HR', 'Read all Matt Pocock skills', 'cat */SKILL.md'),
  ...outline!,
  ...quickBash('toolu_01BHia88HDPCGQNXY3QGK7ga', 'Read BROCODE spec runtime architecture and connectors sections', 'sed -n 1,80p docs/specification.md'),
  ...epics!,
  ...controller!,
  { text: 'I have read both projects.' },
];
