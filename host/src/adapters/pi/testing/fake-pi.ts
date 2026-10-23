// A fake `pi --mode rpc`: a Node script that speaks the JSONL subset the pi adapter uses, driven by a
// fixture (fixture.ts). It loads the extension named by `-e` exactly as pi does (default export called with
// an ExtensionAPI subset), so Nano's real approval extension decides which tool calls ask. Run as
// `node fake-pi.ts --mode rpc --no-extensions -e <ext> --session-id <id>` with
//
//   FAKE_PI_FIXTURE  path of the fixture JSON
//   FAKE_PI_STATE    path of a JSON state file shared by every process of one test (sessions, turn count)
//   FAKE_PI_LOG      path of a JSONL file that receives the command line and every record the fake reads
//
// Self-contained on purpose (Node runs it with type stripping, no build): it imports types only.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FakePiFixture, FakePiModel, FakePiStep } from './fixture.js';

type Json = Record<string, unknown>;

interface SessionRecord {
  id: string;
  model: FakePiModel;
  messages: Json[];
}
interface State {
  sessions: Record<string, SessionRecord>;
  turnCount: number;
}

const env = process.env;
const fixture: FakePiFixture = env.FAKE_PI_FIXTURE ? (JSON.parse(readFileSync(env.FAKE_PI_FIXTURE, 'utf8')) as FakePiFixture) : {};
const statePath = env.FAKE_PI_STATE;
const logPath = env.FAKE_PI_LOG;
const models: FakePiModel[] = fixture.models ?? [
  { provider: 'llamacpp', id: 'bonsai-27b', name: 'Bonsai 27B' },
  { provider: 'openrouter', id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek V4 Flash' },
];
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function log(entry: Json): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}
function loadState(): State {
  if (statePath && existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8')) as State;
  return { sessions: {}, turnCount: 0 };
}
function saveState(): void {
  if (statePath && session.id !== '') writeFileSync(statePath, JSON.stringify(state));
}
function send(record: Json): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (argv.includes('--version')) {
  process.stdout.write(`${fixture.version ?? '1.3.0'}\n`);
  process.exit(0);
}
log({ argv, cwd: process.cwd() });
if (fixture.exitAtBoot !== undefined) {
  process.stderr.write(`${fixture.exitAtBoot}\n`);
  process.exit(1);
}

const state = loadState();
const sessionId = flag('--session-id');
const session: SessionRecord =
  sessionId === undefined
    ? { id: '', model: models[0]!, messages: [] }
    : (state.sessions[sessionId] ??= { id: sessionId, model: models[0]!, messages: [] });

// ---- the extension -------------------------------------------------------------------------------

type Handler = (event: Json, ctx: Json) => Promise<Json | undefined> | Json | undefined;
const handlers: Record<string, Handler[]> = {};
const extension = flag('-e');
if (extension !== undefined) {
  const mod = (await import(pathToFileURL(path.resolve(extension)).href)) as { default: (pi: Json) => void };
  mod.default({ on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler) });
}

const dialogs = new Map<string, (answer: Json) => void>();
function dialog(request: Json): Promise<Json> {
  const id = randomUUID();
  return new Promise((resolve) => {
    dialogs.set(id, resolve);
    send({ type: 'extension_ui_request', id, ...request });
    // Like pi: a dialog with a timeout answers itself when it passes (a little later than the host's own
    // timer, which starts when the request arrives, so the test sees the withdrawal first).
    if (typeof request.timeout === 'number') {
      setTimeout(() => {
        if (dialogs.delete(id)) resolve({ cancelled: true, timedOut: true });
      }, request.timeout + 300);
    }
  });
}
const ui = {
  confirm: async (title: string, message: string) => (await dialog({ method: 'confirm', title, message })).confirmed === true,
  select: async (title: string, options: string[]) => (await dialog({ method: 'select', title, options })).value,
  input: async (title: string) => (await dialog({ method: 'input', title })).value,
};

// ---- the running turn ----------------------------------------------------------------------------

interface Running {
  steps: FakePiStep[];
  aborted: boolean;
  steering: string[];
  wake?: () => void;
}
let running: Running | undefined;
const late: Json[] = [];
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: Json[], extra: Json = {}): Json {
  return { role: 'assistant', content, api: 'openai-completions', provider: session.model.provider, model: session.model.id, usage, stopReason: 'stop', timestamp: Date.now(), ...extra };
}

function message(msg: Json): void {
  send({ type: 'message_start', message: msg });
  send({ type: 'message_end', message: msg });
  session.messages.push(msg);
}

function streamText(kind: 'text' | 'thinking', text: string, chunks: number): void {
  const msg = assistant([]);
  send({ type: 'message_start', message: msg });
  send({ type: 'message_update', usage, assistantMessageEvent: { type: `${kind}_start`, contentIndex: 0 } });
  const size = Math.max(1, Math.ceil(text.length / chunks));
  for (let i = 0; i < text.length; i += size) {
    send({ type: 'message_update', usage, assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: text.slice(i, i + size) } });
  }
  const block = kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text };
  send({ type: 'message_update', usage, assistantMessageEvent: { type: `${kind}_end`, contentIndex: 0, content: text } });
  const final = assistant([block]);
  send({ type: 'message_end', message: final });
  session.messages.push(final);
}

async function runTool(tool: Extract<FakePiStep, { tool: unknown }>['tool']): Promise<void> {
  const toolCallId = `call_${randomUUID().slice(0, 8)}`;
  const call = { type: 'toolCall', id: toolCallId, name: tool.name, arguments: tool.args };
  send({ type: 'message_start', message: assistant([], { stopReason: 'pending' }) });
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: toolCallId, toolName: tool.name } });
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call } });
  const msg = assistant([call], { stopReason: 'toolUse' });
  send({ type: 'message_end', message: msg });
  session.messages.push(msg);
  send({ type: 'tool_execution_start', toolCallId, toolName: tool.name, args: tool.args });

  let blocked: string | undefined;
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ type: 'tool_call', toolCallId, toolName: tool.name, input: tool.args }, { hasUI: true, cwd: process.cwd(), ui });
    if (result?.block === true) {
      blocked = String(result.reason ?? 'blocked');
      break;
    }
  }
  let result: Json;
  let isError = tool.isError === true;
  if (blocked !== undefined) {
    result = { content: [{ type: 'text', text: blocked }], details: {} };
    isError = true;
  } else if (running?.aborted) {
    result = { content: [{ type: 'text', text: 'Command aborted' }], details: {} };
    isError = true;
  } else {
    const output = tool.output ?? '';
    if (tool.name === 'write') writeFileSync(path.resolve(process.cwd(), String(tool.args.path)), String(tool.args.content ?? ''));
    if (tool.name === 'bash') {
      const half = output.slice(0, Math.ceil(output.length / 2));
      send({ type: 'tool_execution_update', toolCallId, toolName: tool.name, args: tool.args, partialResult: { content: [] } });
      send({ type: 'tool_execution_update', toolCallId, toolName: tool.name, args: tool.args, partialResult: { content: [{ type: 'text', text: half }] } });
      send({ type: 'tool_execution_update', toolCallId, toolName: tool.name, args: tool.args, partialResult: { content: [{ type: 'text', text: 'rewritten' }] } });
    }
    result = { content: [{ type: 'text', text: output }] };
    if (tool.name === 'bash') result.structuredContent = { output, exit_code: tool.exitCode ?? 0 };
    if (tool.patch !== undefined) result.details = { patch: tool.patch };
  }
  send({ type: 'tool_execution_end', toolCallId, toolName: tool.name, result, isError, durationMs: 5 });
  message({ role: 'toolResult', toolCallId, toolName: tool.name, content: result.content, isError, timestamp: Date.now() });
}

async function play(step: FakePiStep): Promise<void> {
  if ('reply' in step) return streamText('text', step.reply, step.chunks ?? 2);
  if ('thinking' in step) return streamText('thinking', step.thinking, 1);
  if ('tool' in step) return runTool(step.tool);
  if ('dialog' in step) {
    const answer = await dialog({ ...step.dialog });
    return streamText('text', `Answer: ${JSON.stringify(answer)}`, 1);
  }
  if ('notify' in step) {
    send({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: step.notify });
    return;
  }
  if ('hold' in step) {
    await new Promise<void>((resolve) => (running!.wake = resolve));
    running!.wake = undefined;
    return;
  }
  if ('fail' in step) {
    const msg = assistant([], { stopReason: 'error', errorMessage: step.fail });
    message(msg);
    return;
  }
  if ('crash' in step) {
    saveState();
    process.stdout.write('', () => process.exit(step.crash));
    await new Promise(() => {});
  }
  if ('raw' in step) return send(step.raw);
  if ('late' in step) {
    late.push(step.late);
    return;
  }
  process.stdout.write('this is not json\n');
}

async function runTurn(text: string): Promise<void> {
  const index = state.turnCount++;
  const steps = fixture.turns?.[index] ?? [{ reply: `You said: ${text}` }];
  const turn: Running = { steps: [...steps], aborted: false, steering: [] };
  running = turn;
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  message({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
  for (;;) {
    while (turn.steering.length > 0 && !turn.aborted) {
      const steer = turn.steering.shift()!;
      message({ role: 'user', content: [{ type: 'text', text: steer }], timestamp: Date.now() });
      await play({ reply: `You steered: ${steer}`, chunks: 1 });
    }
    const step = turn.steps.shift();
    if (step === undefined || turn.aborted) break;
    await play(step);
  }
  send({ type: 'agent_end', messages: [], willRetry: false });
  running = undefined;
  saveState();
  send({ type: 'agent_settled', aborted: turn.aborted });
  for (const record of late.splice(0)) send(record);
  turn.wake?.();
}

// ---- commands ------------------------------------------------------------------------------------

function respond(id: unknown, command: string, data?: unknown): void {
  const record: Json = { type: 'response', command, success: true };
  if (id !== undefined) record.id = id;
  if (data !== undefined) record.data = data;
  send(record);
}

let settled: Promise<void> = Promise.resolve();

async function handle(record: Json): Promise<void> {
  const type = String(record.type);
  const id = record.id;
  if (type === 'extension_ui_response') {
    const resolve = dialogs.get(String(record.id));
    dialogs.delete(String(record.id));
    resolve?.(record);
    return;
  }
  if (fixture.ignore?.includes(type)) return;
  const failure = fixture.fail?.[type];
  if (failure !== undefined) {
    send({ id, type: 'response', command: type, success: false, error: failure });
    return;
  }
  switch (type) {
    case 'prompt': {
      if (running) {
        send({ id, type: 'response', command: type, success: false, error: 'Agent is already processing' });
        return;
      }
      if (fixture.disposition === 'handled') return respond(id, type, { disposition: 'handled' });
      respond(id, type, { disposition: 'started' });
      settled = runTurn(String(record.message));
      return;
    }
    case 'steer':
      if (running) {
        running.steering.push(String(record.message));
        running.wake?.();
      }
      return respond(id, type, { disposition: 'queued' });
    case 'clear_queue': {
      const steering = running?.steering.splice(0) ?? [];
      return respond(id, type, { steering, followUp: [] });
    }
    case 'abort':
      // Like pi: the abort waits until the run is idle, which an open dialog prevents.
      if (running) {
        running.aborted = true;
        running.wake?.();
        await settled;
      }
      return respond(id, type);
    case 'get_state':
      return respond(id, type, {
        model: { ...session.model, name: session.model.name ?? session.model.id },
        thinkingLevel: 'off',
        isStreaming: running !== undefined,
        sessionId: session.id,
        messageCount: session.messages.length,
      });
    case 'get_messages':
      return respond(id, type, { messages: session.messages });
    case 'get_available_models':
      return respond(id, type, { models: models.map((m) => ({ ...m, name: m.name ?? m.id, api: 'openai-completions' })) });
    case 'set_model': {
      const model = models.find((m) => m.provider === record.provider && m.id === record.modelId);
      if (!model) {
        send({ id, type: 'response', command: type, success: false, error: `Model not found: ${String(record.provider)}/${String(record.modelId)}` });
        return;
      }
      session.model = model;
      saveState();
      return respond(id, type, model);
    }
    case 'get_session_stats':
      return respond(
        id,
        type,
        fixture.stats ?? {
          sessionId: session.id,
          tokens: { input: 100 * state.turnCount, output: 10 * state.turnCount, cacheRead: 50, cacheWrite: 0, total: 0 },
          contextUsage: { tokens: 1234, contextWindow: 32768, percent: 3.766 },
        },
      );
    default:
      send({ id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
  }
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += String(chunk);
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim() === '') continue;
    let record: Json;
    try {
      record = JSON.parse(line) as Json;
    } catch {
      send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
      continue;
    }
    log({ record });
    void handle(record);
  }
});
process.stdin.on('end', () => {
  saveState();
  process.exit(0);
});
