// A fake `codex app-server`: a Node script that speaks the JSON-RPC subset the Codex adapter uses over
// stdio, driven by a fixture (fixture.ts). Run as `node fake-app-server.ts app-server` with
//
//   FAKE_CODEX_FIXTURE  path of the fixture JSON
//   FAKE_CODEX_STATE    path of a JSON state file shared by every process of one test (threads, turn count)
//   FAKE_CODEX_LOG      path of a JSONL file that receives every message the fake reads
//
// Self-contained on purpose (Node runs it with type stripping, no build): it imports types only.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { FakeFixture, FakeLogEntry, FakeStep } from './fixture.js';

type Json = Record<string, unknown>;
type Id = number | string;

interface TurnRecord {
  id: string;
  status: string;
  items: Json[];
}
interface ThreadRecord {
  id: string;
  cwd: string;
  model: string;
  /** The thread's `approvalPolicy` (thread/start, updated by thread/resume and turn/start); `never` runs commands unasked. */
  approvalPolicy?: string;
  /** The thread's reasoning effort (config.model_reasoning_effort, updated by turn/start effort). */
  effort?: string | null;
  turns: TurnRecord[];
}
interface State {
  threads: Record<string, ThreadRecord>;
  turnCount: number;
}

const env = process.env;
const fixture: FakeFixture = env.FAKE_CODEX_FIXTURE ? (JSON.parse(readFileSync(env.FAKE_CODEX_FIXTURE, 'utf8')) as FakeFixture) : {};
const statePath = env.FAKE_CODEX_STATE;
const logPath = env.FAKE_CODEX_LOG;
const models = fixture.models ?? [
  { id: 'gpt-fake-luna', displayName: 'Fake Luna', isDefault: true },
  { id: 'gpt-fake-astra', displayName: 'Fake Astra', isDefault: false },
];

function loadState(): State {
  if (statePath && existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8')) as State;
  return { threads: {}, turnCount: 0 };
}
function saveState(): void {
  if (statePath) writeFileSync(statePath, JSON.stringify(state));
}
const state = loadState();

/** Lines held back to go out in one stdout write (`fixture.oneChunkTurnStart`). */
let held: string[] | undefined;

function send(message: Json): void {
  const line = `${JSON.stringify(message)}\n`;
  if (held) held.push(line);
  else process.stdout.write(line);
}
function notify(method: string, params: Json): void {
  send({ method, params });
}
function exitSoon(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

// ---- the running turn ------------------------------------------------------------------------------

interface Waiting {
  rpcId: Id;
  kind: 'command' | 'fileChange' | 'permissions' | 'input' | 'other';
  itemId: string;
  item?: Json;
  output?: string;
}

interface Running {
  thread: ThreadRecord;
  turn: TurnRecord;
  steps: FakeStep[];
  waiting?: Waiting;
  holding?: boolean;
}

let running: Running | undefined;
let nextServerId = 0;
let items = 0;

const itemId = (): string => `item_${process.pid}_${++items}`;

function base(): Json {
  return { threadId: running!.thread.id, turnId: running!.turn.id };
}

function itemStarted(item: Json): void {
  notify('item/started', { ...base(), item, startedAtMs: Date.now() });
}
function itemCompleted(item: Json): void {
  running!.turn.items.push(item);
  notify('item/completed', { ...base(), item, completedAtMs: Date.now() });
}

function status(type: string, activeFlags: string[] = []): void {
  notify('thread/status/changed', {
    threadId: running?.thread.id ?? '',
    status: type === 'active' ? { type, activeFlags } : { type },
  });
}

function startTurn(thread: ThreadRecord, input: Json[], clientUserMessageId: unknown): Json {
  const turn: TurnRecord = { id: randomUUID(), status: 'inProgress', items: [] };
  thread.turns.push(turn);
  const index = state.turnCount++;
  saveState();
  const text = input.map((part) => (part.type === 'text' ? String(part.text) : `[${String(part.type)}]`)).join(' ');
  const steps = fixture.turns?.[index] ?? [{ reply: `You said: ${text}` }];
  running = { thread, turn, steps: [...steps] };
  queueMicrotask(() => {
    notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } });
    status('active');
    const user = { type: 'userMessage', id: itemId(), content: input, clientId: clientUserMessageId ?? null };
    itemStarted(user);
    itemCompleted(user);
    play();
  });
  return { turn: { id: turn.id, status: 'inProgress', items: [] } };
}

function finish(turnStatus: 'completed' | 'interrupted' | 'failed', error: Json | null = null): void {
  const run = running!;
  running = undefined;
  run.turn.status = turnStatus;
  saveState();
  notify('thread/tokenUsage/updated', {
    threadId: run.thread.id,
    turnId: run.turn.id,
    tokenUsage: {
      total: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1280 },
      last: { inputTokens: 600, outputTokens: 40, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 640 },
      modelContextWindow: 64000,
    },
  });
  notify('turn/completed', {
    threadId: run.thread.id,
    turn: { id: run.turn.id, status: turnStatus, items: [], error, completedAt: Math.floor(Date.now() / 1000) },
  });
  notify('thread/status/changed', { threadId: run.thread.id, status: { type: 'idle' } });
}

function serverRequest(method: string, params: Json, waiting: Omit<Waiting, 'rpcId'>): void {
  const rpcId = nextServerId++;
  running!.waiting = { ...waiting, rpcId };
  send({ id: rpcId, method, params: { ...base(), ...params } });
}

/** Plays steps until one waits or the turn ends. */
function play(): void {
  while (running && !running.waiting && !running.holding) {
    const step = running.steps.shift();
    if (!step) return finish('completed');
    if (playStep(step) === 'stop') return;
  }
}

function playStep(step: FakeStep): 'stop' | void {
  if ('reply' in step) {
    const id = itemId();
    itemStarted({ type: 'agentMessage', id, text: '' });
    const chunks = Math.max(1, step.chunks ?? 1);
    const size = Math.max(1, Math.ceil(step.reply.length / chunks));
    for (let i = 0; i < step.reply.length; i += size) {
      notify('item/agentMessage/delta', { ...base(), itemId: id, delta: step.reply.slice(i, i + size) });
    }
    itemCompleted({ type: 'agentMessage', id, text: step.reply });
  } else if ('reasoning' in step) {
    const id = itemId();
    itemStarted({ type: 'reasoning', id, summary: [], content: [] });
    notify('item/reasoning/summaryTextDelta', { ...base(), itemId: id, delta: step.reasoning, summaryIndex: 0 });
    itemCompleted({ type: 'reasoning', id, summary: [step.reasoning], content: [] });
  } else if ('run' in step) {
    const id = itemId();
    const item = { type: 'commandExecution', id, command: step.run.command, cwd: running!.thread.cwd, commandActions: [] };
    itemStarted({ ...item, status: 'inProgress' });
    for (const [file, content] of Object.entries(step.run.files ?? {})) {
      const full = path.resolve(running!.thread.cwd, file);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    notify('item/commandExecution/outputDelta', { ...base(), itemId: id, delta: step.run.output });
    itemCompleted({ ...item, status: 'completed', aggregatedOutput: step.run.output, exitCode: step.run.exitCode ?? 0, durationMs: 5 });
  } else if ('command' in step) {
    const id = itemId();
    const command = step.command.command ?? '/bin/zsh -lc "echo hello > hello.txt"';
    const cwd = step.command.cwd ?? running!.thread.cwd;
    const item = { type: 'commandExecution', id, command, cwd, commandActions: [] };
    itemStarted({ ...item, status: 'inProgress' });
    if (running!.thread.approvalPolicy === 'never') {
      // Like Codex with approval_policy=never: the command runs without asking.
      const output = step.command.output ?? '';
      if (output) notify('item/commandExecution/outputDelta', { ...base(), itemId: id, delta: output });
      itemCompleted({ ...item, status: 'completed', aggregatedOutput: output, exitCode: 0, durationMs: 12 });
      return;
    }
    status('active', ['waitingOnApproval']);
    serverRequest(
      'item/commandExecution/requestApproval',
      {
        itemId: id,
        ...(step.command.bare ? {} : { command, cwd }),
        reason: step.command.reason ?? 'May I create hello.txt in the current directory?',
        availableDecisions:
          step.command.availableDecisions === null
            ? undefined
            : (step.command.availableDecisions ?? ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } }, 'cancel']),
        startedAtMs: Date.now(),
      },
      { kind: 'command', itemId: id, item, output: step.command.output ?? '' },
    );
  } else if ('fileChange' in step) {
    const id = itemId();
    const change = { path: step.fileChange.path, kind: { type: step.fileChange.kind ?? 'add' }, diff: step.fileChange.diff };
    const item = { type: 'fileChange', id, changes: [change] };
    itemStarted({ ...item, status: 'inProgress' });
    status('active', ['waitingOnApproval']);
    const params: Json = { itemId: id, reason: step.fileChange.reason ?? null, startedAtMs: Date.now() };
    if (step.fileChange.grantRoot) params.grantRoot = step.fileChange.grantRoot;
    serverRequest('item/fileChange/requestApproval', params, { kind: 'fileChange', itemId: id, item });
  } else if ('permissions' in step) {
    status('active', ['waitingOnApproval']);
    serverRequest(
      'item/permissions/requestApproval',
      {
        itemId: itemId(),
        cwd: running!.thread.cwd,
        permissions: step.permissions.permissions ?? { network: { enabled: true } },
        reason: step.permissions.reason ?? 'Needs network access',
        startedAtMs: Date.now(),
      },
      { kind: 'permissions', itemId: '' },
    );
  } else if ('input' in step) {
    status('active', ['waitingOnUserInput']);
    serverRequest(
      'item/tool/requestUserInput',
      { itemId: itemId(), questions: step.input.questions, isBlocking: step.input.isBlocking ?? true },
      { kind: 'input', itemId: '' },
    );
  } else if ('withdrawn' in step) {
    const rpcId = nextServerId++;
    send({
      id: rpcId,
      method: 'item/commandExecution/requestApproval',
      params: { ...base(), itemId: itemId(), command: 'sleep 1', cwd: running!.thread.cwd, startedAtMs: Date.now() },
    });
    notify('serverRequest/resolved', { threadId: running!.thread.id, requestId: rpcId });
  } else if ('hold' in step) {
    running!.holding = true;
  } else if ('fail' in step) {
    finish('failed', { message: step.fail, codexErrorInfo: step.info ?? null, additionalDetails: 'from the fake' });
    return 'stop';
  } else if ('crash' in step) {
    running = undefined;
    exitSoon(step.crash);
    return 'stop';
  } else if ('closeStdout' in step) {
    running = undefined;
    process.stdout.end();
    setTimeout(() => process.exit(0), 5000).unref();
    return 'stop';
  } else if ('notify' in step) {
    notify(step.notify.method, { threadId: running!.thread.id, ...step.notify.params });
  } else {
    serverRequest(step.request.method, step.request.params ?? {}, { kind: 'other', itemId: '' });
    running!.waiting = undefined;
  }
}

/** The host answered a server request. */
function onResponse(id: Id, result: Json | undefined): void {
  const run = running;
  if (!run?.waiting || run.waiting.rpcId !== id) return;
  const waiting = run.waiting;
  run.waiting = undefined;
  notify('serverRequest/resolved', { threadId: run.thread.id, requestId: id });
  status('active');
  if (waiting.kind === 'input') {
    const reply = itemId();
    itemStarted({ type: 'agentMessage', id: reply, text: '' });
    itemCompleted({ type: 'agentMessage', id: reply, text: `Answers: ${JSON.stringify(result?.answers ?? {})}` });
    return play();
  }
  if (waiting.kind === 'permissions') {
    const granted = Object.keys((result?.permissions as Json | undefined) ?? {}).length > 0;
    const reply = itemId();
    itemStarted({ type: 'agentMessage', id: reply, text: '' });
    itemCompleted({ type: 'agentMessage', id: reply, text: granted ? `granted for the ${String(result?.scope)}` : 'not granted' });
    return play();
  }
  const decision = result?.decision;
  if (decision === 'cancel') {
    itemCompleted({ ...waiting.item, status: 'declined' });
    return finish('interrupted');
  }
  if (decision === 'decline') {
    itemCompleted({ ...waiting.item, status: 'declined' });
    return play();
  }
  if (waiting.kind === 'command') {
    if (waiting.output) notify('item/commandExecution/outputDelta', { ...base(), itemId: waiting.itemId, delta: waiting.output });
    itemCompleted({ ...waiting.item, status: 'completed', aggregatedOutput: waiting.output, exitCode: 0, durationMs: 12 });
  } else {
    notify('item/fileChange/outputDelta', { ...base(), itemId: waiting.itemId, delta: 'Success. Updated the following files' });
    itemCompleted({ ...waiting.item, status: 'completed' });
  }
  play();
}

// ---- requests from the host ------------------------------------------------------------------------

function thread(params: Json): ThreadRecord {
  const found = state.threads[String(params.threadId)];
  if (!found) throw new Error(`no thread ${String(params.threadId)}`);
  return found;
}

/** `config.model_reasoning_effort` of thread/start or thread/resume, when given. */
function configEffort(params: Json): string | undefined {
  const effort = (params.config as Json | undefined)?.model_reasoning_effort;
  return typeof effort === 'string' ? effort : undefined;
}

function handle(method: string, params: Json): Json {
  switch (method) {
    case 'initialize':
      return {
        userAgent: fixture.userAgent ?? 'codex_cli_rs/0.0.0-fake (fake app-server)',
        codexHome: env.CODEX_HOME ?? '',
        platformFamily: 'unix',
        platformOs: 'macos',
      };
    case 'model/list': {
      const size = fixture.modelPageSize ?? models.length;
      const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
      const data = models.slice(start, start + size).map((m) => ({
        id: m.id,
        model: m.id,
        displayName: m.displayName ?? m.id,
        description: '',
        hidden: m.hidden ?? false,
        isDefault: m.isDefault ?? false,
        defaultReasoningEffort: m.defaultEffort ?? 'medium',
        supportedReasoningEfforts: (m.efforts ?? []).map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      }));
      return start + size < models.length ? { data, nextCursor: String(start + size) } : { data, nextCursor: null };
    }
    case 'thread/start': {
      const record: ThreadRecord = {
        id: randomUUID(),
        cwd: String(params.cwd ?? ''),
        model: String(params.model ?? ''),
        approvalPolicy: String(params.approvalPolicy ?? ''),
        effort: configEffort(params) ?? fixture.threadEffort ?? null,
        turns: [],
      };
      state.threads[record.id] = record;
      saveState();
      queueMicrotask(() => notify('thread/started', { thread: { id: record.id } }));
      return { thread: { id: record.id, turns: [] }, model: record.model, cwd: record.cwd, reasoningEffort: record.effort ?? null };
    }
    case 'thread/resume': {
      const record = thread(params);
      if (typeof params.approvalPolicy === 'string') record.approvalPolicy = params.approvalPolicy;
      const effort = configEffort(params);
      if (effort !== undefined) record.effort = effort;
      saveState();
      const page = params.initialTurnsPage as { limit?: number } | undefined;
      const turns = record.turns.slice(-(page?.limit ?? record.turns.length));
      return { thread: { id: record.id, turns }, model: String(params.model ?? record.model), cwd: record.cwd, reasoningEffort: record.effort ?? null };
    }
    case 'turn/start': {
      if (running) throw new Error('a turn is already running');
      const record = thread(params);
      // model, effort and approvalPolicy apply "for this turn and subsequent turns".
      if (typeof params.model === 'string') record.model = params.model;
      if (typeof params.approvalPolicy === 'string') record.approvalPolicy = params.approvalPolicy;
      if (typeof params.effort === 'string') record.effort = params.effort;
      saveState();
      return startTurn(record, (params.input as Json[]) ?? [], params.clientUserMessageId);
    }
    case 'turn/steer': {
      if (!running || params.expectedTurnId !== running.turn.id) throw new Error('expectedTurnId is not the running turn');
      const run = running;
      queueMicrotask(() => {
        const user = { type: 'userMessage', id: itemId(), content: params.input, clientId: params.clientUserMessageId ?? null };
        itemStarted(user);
        itemCompleted(user);
        if (run.holding) {
          run.holding = false;
          play();
        }
      });
      return { turnId: run.turn.id };
    }
    case 'turn/interrupt': {
      if (running && params.turnId === running.turn.id) {
        const waiting = running.waiting;
        queueMicrotask(() => {
          if (waiting) notify('serverRequest/resolved', { threadId: running!.thread.id, requestId: waiting.rpcId });
          finish('interrupted');
        });
      }
      return {};
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

function onMessage(message: FakeLogEntry['message']): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, message } satisfies FakeLogEntry)}\n`);
  const { id, method } = message;
  if (method === undefined) {
    if (id !== undefined) onResponse(id, message.result as Json | undefined);
    return;
  }
  if (fixture.exitOn === method) return exitSoon(3);
  if (id === undefined) return; // notifications (`initialized`)
  if (fixture.ignore?.includes(method)) return;
  const failure = fixture.fail?.[method];
  if (failure !== undefined) return send({ id, error: { code: -32000, message: failure } });
  if (fixture.oneChunkTurnStart && method === 'turn/start' && !held) {
    // The reply and the notifications its microtask plays go out together once that microtask has run.
    held = [];
    setImmediate(() => {
      const lines = held!.join('');
      held = undefined;
      process.stdout.write(lines);
    });
  }
  try {
    const result = handle(method, message.params ?? {});
    send({ id, result: fixture.results && method in fixture.results ? fixture.results[method] : result });
  } catch (error) {
    const err = error as Error & { code?: number };
    send({ id, error: { code: err.code ?? -32000, message: err.message } });
  }
}

if (fixture.noise) {
  process.stdout.write('not json at all\n\n');
  process.stdout.write('[1,2]\nnull\n5\n{"method":"noise/withoutParams"}\n{"id":4242,"result":{}}\n');
  process.stderr.write('fake app-server: warming up\n');
}
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() !== '') onMessage(JSON.parse(line) as FakeLogEntry['message']);
});
process.stdin.on('end', () => process.exit(0));
