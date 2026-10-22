// Host acceptance (docs/plan/roadmap.md section 4; Phase 1 for Codex, Phase 4 for Claude Code): a scripted
// client against the real host, started with the nano-host CLI, driving the real engine of one agent. Not
// part of the gate (it needs the operator's login and spends tokens). Run it with:
//
//   pnpm -C host acceptance                                  (Codex; builds dist/, then runs this file)
//   NANO_ACCEPTANCE_AGENT=claude pnpm -C host acceptance     (Claude Code; same as pnpm -C host acceptance:claude)
//
// The agent comes from NANO_ACCEPTANCE_AGENT (codex or claude, default codex). For claude the host config
// carries claudeConfigDir from CLAUDE_CONFIG_DIR (absolute) or ~/.claude, where the operator's login lives.
// Every step writes one timestamped line to acceptance/host-<agent>.log (overwritten per run, committed as
// evidence). The Phase 1 Codex run is kept as acceptance/host-v0.log. Exit 0 only when all eight steps pass.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(HOST_DIR, 'dist', 'cli', 'main.js');
const AGENTS = ['codex', 'claude'] as const;
type Agent = (typeof AGENTS)[number];
const AGENT = (process.env.NANO_ACCEPTANCE_AGENT || 'codex') as Agent;
if (!AGENTS.includes(AGENT)) {
  console.error(`NANO_ACCEPTANCE_AGENT must be one of ${AGENTS.join(', ')}, not ${JSON.stringify(AGENT)}`);
  process.exit(2);
}
const LOG = path.join(HOST_DIR, 'acceptance', `host-${AGENT}.log`);
const STEP_MS = 240_000;

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------- log

mkdirSync(path.dirname(LOG), { recursive: true });
writeFileSync(LOG, '');
function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  writeFileSync(LOG, `${text}\n`, { flag: 'a' });
}
function fail(message: string): never {
  throw new Error(message);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

// --------------------------------------------------------------------------------------------- host

const work = mkdtempSync(path.join(tmpdir(), 'nano-acceptance-'));
const configDir = path.join(work, 'config');
const configPath = path.join(configDir, 'config.json');
const cwd = path.join(work, 'project');
mkdirSync(cwd);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function cli(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args, '--config', configPath], (error, stdout, stderr) => {
      if (error) reject(new Error(`nano-host ${args.join(' ')}: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

/** The current host process, stopped if the run fails. */
let running: ChildProcess | undefined;

interface RunningHost {
  child: ChildProcess;
  origin: string;
  agents: unknown;
}

/** `nano-host start --insecure-dev`; resolves on the `host.listening` log line. */
function startHost(): Promise<RunningHost> {
  const child = spawn(process.execPath, [BIN, 'start', '--config', configPath, '--insecure-dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('host did not report host.listening within 60 s')), 60_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let entry: Json;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.event === 'host.listening') {
          clearTimeout(timer);
          resolve({ child, origin: entry.origin, agents: entry.agents });
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`host exited before listening (code ${code}, signal ${signal})`));
    });
  });
}

async function pairDevice(origin: string, name: string): Promise<{ clientId: string; deviceToken: string }> {
  const out = await cli('pair');
  const code = /^code: (\d{8})$/m.exec(out)?.[1] ?? fail(`no code in nano-host pair output:\n${out}`);
  const response = await fetch(`${origin}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, client: { name, platform: 'acceptance-script' } }),
  });
  const body = (await response.json()) as Json;
  check(response.status === 200, `POST /v1/pair ${response.status}: ${JSON.stringify(body)}`);
  check(typeof body.deviceToken === 'string' && body.deviceToken.length > 0, 'no deviceToken');
  return { clientId: body.clientId, deviceToken: body.deviceToken };
}

// ------------------------------------------------------------------------------------------- client

/** A protocol v1 client: numbers its envelopes, acks every host message, keeps every message received. */
class Client {
  readonly messages: Json[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private seq = 0;
  private nextId = 1;
  private chunks: string[] = [];
  private waiters: (() => void)[] = [];
  private closedValue: { code: number; reason: string } | undefined;
  private readonly streamId = randomUUID();
  private readonly socket: WebSocket;
  readonly clientId: string;

  // Plain fields, not parameter properties: node runs this file with type stripping only.
  private constructor(socket: WebSocket, clientId: string) {
    this.socket = socket;
    this.clientId = clientId;
    socket.on('message', (data) => this.onFrame(JSON.parse(data.toString()) as Json));
    this.closed = new Promise((resolve) =>
      socket.on('close', (code, reason) => {
        this.closedValue = { code, reason: reason.toString() };
        resolve(this.closedValue);
        this.wake();
      }),
    );
  }

  static async connect(origin: string, device: { clientId: string; deviceToken: string }): Promise<Client> {
    const url = `${origin.replace(/^http/, 'ws')}/v1/stream`;
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${device.deviceToken}`, 'x-nano-protocol-version': '1' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new Client(socket, device.clientId);
  }

  private send(fields: Json, consume = true): void {
    const seq_id = consume ? ++this.seq : fields.seq_id;
    this.socket.send(JSON.stringify({ client_id: this.clientId, stream_id: this.streamId, ...fields, seq_id }));
  }

  private onFrame(frame: Json): void {
    if (frame.type === 'server_message') {
      this.messages.push(frame.message);
      this.send({ type: 'ack', seq_id: frame.seq_id }, false);
    } else if (frame.type === 'server_message_chunk') {
      this.chunks.push(frame.message_chunk_base64);
      if (this.chunks.length === frame.segment_count) {
        this.messages.push(JSON.parse(Buffer.from(this.chunks.join(''), 'base64').toString('utf8')));
        this.chunks = [];
      }
      this.send({ type: 'ack', seq_id: frame.seq_id }, false);
    }
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until<T>(check: () => T | undefined | false, label: string, ms = STEP_MS): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value !== undefined && value !== false) return value;
      if (this.closedValue) fail(`stream closed ${JSON.stringify(this.closedValue)} while waiting for ${label}`);
      if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  notify(method: string, params?: Json): void {
    this.send({ type: 'client_message', message: params === undefined ? { method } : { method, params } });
  }

  async call(method: string, params?: Json): Promise<Json> {
    const id = `c-${this.nextId++}`;
    this.send({ type: 'client_message', message: params === undefined ? { id, method } : { id, method, params } });
    const response = await this.until(() => this.messages.find((m) => m.id === id && !('method' in m)), `response to ${method}`);
    if (response.error) fail(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  async handshake(name: string): Promise<Json> {
    const result = await this.call('initialize', {
      protocolVersion: 1,
      client: { name, version: '0.0.0', platform: 'acceptance-script' },
    });
    this.notify('initialized');
    return result;
  }

  /** Journal events of a session received live on this stream. */
  events(sessionId: string): Json[] {
    return this.messages.filter((m) => !('id' in m) && m.params?.sessionId === sessionId && typeof m.params.seq === 'number');
  }

  /** Highest Journal seq applied for a session: the cursor a Replica would save. */
  cursor(sessionId: string): number {
    return Math.max(0, ...this.events(sessionId).map((e) => e.params.seq as number));
  }

  close(): void {
    this.socket.close();
  }
}

/** Accepts every approval the engine asks for until the turn completes. Returns the final turn. */
async function driveTurn(client: Client, sessionId: string, turnId: string, onApproval: (request: Json, decision: string) => void): Promise<Json> {
  const answered = new Set<string>();
  for (;;) {
    const next = await client.until(
      () =>
        client
          .events(sessionId)
          .find(
            (e) =>
              (e.method === 'turn/completed' && e.params.turn.turnId === turnId) ||
              ((e.method === 'approval/request' || e.method === 'input/request') && !answered.has(e.params.request.requestId)),
          ),
      `approval or end of turn ${turnId}`,
    );
    if (next.method === 'turn/completed') return next.params.turn;
    const request = next.params.request;
    answered.add(request.requestId);
    check(next.method === 'approval/request', `unexpected question: ${JSON.stringify(request)}`);
    const decision = request.availableDecisions?.includes('accept') ? 'accept' : fail(`accept not offered: ${JSON.stringify(request)}`);
    onApproval({ ...request, seq: next.params.seq }, decision);
    await client.call('approval/resolve', { sessionId, requestId: request.requestId, decision });
  }
}

function reply(events: Json[], turnId: string): string {
  return events
    .filter((e) => e.method === 'item/completed' && e.params.turnId === turnId && e.params.item.type === 'agentMessage')
    .map((e) => e.params.item.text as string)
    .join(' ');
}

// -------------------------------------------------------------------------------------------- agent

/** What differs per agent: the host config keys, the first turn's settings and prompt. */
interface AgentPlan {
  config: Json;
  settings: Json;
  prompt: string;
  /** For the step 3 log line. */
  describe: string;
}

function claudeConfigDir(): string {
  const value = process.env.CLAUDE_CONFIG_DIR;
  return value && path.isAbsolute(value) ? value : path.join(homedir(), '.claude');
}

const PLANS: Record<Agent, () => AgentPlan> = {
  codex: () => ({
    config: {},
    settings: { sandbox: 'read-only' },
    prompt:
      'Create a file named hello.txt in the current directory containing exactly the word hello, without a newline. ' +
      'The sandbox is read-only, so run the shell command with escalated permissions; I will approve it. Then reply with "done".',
    describe: 'read-only sandbox',
  }),
  claude: () => ({
    config: { enabledAgents: ['claude'], claudeConfigDir: claudeConfigDir() },
    // Default settings: permission mode default, so the Write call asks for approval.
    settings: {},
    prompt:
      'Create a file named hello.txt in the current directory containing exactly the word hello, without a newline. ' +
      'Use your file writing tool; I will approve it. Then reply with "done".',
    describe: 'default settings',
  }),
};

/** One approval request in a log line: the command, or the paths of the file changes. */
function approvalSummary(request: Json): string {
  if (request.kind === 'command') return JSON.stringify(request.command ?? '');
  if (request.kind === 'fileChange') return (request.changes as Json[]).map((c) => `${c.kind} ${c.path}`).join(', ');
  return JSON.stringify(request.permissions ?? {});
}

// -------------------------------------------------------------------------------------------- steps

async function main(): Promise<void> {
  const port = await freePort();
  const plan = PLANS[AGENT]();
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath,
    JSON.stringify({
      listenAddresses: ['127.0.0.1'],
      port,
      tls: { certPath: path.join(configDir, 'tls-cert.pem'), keyPath: path.join(configDir, 'tls-key.pem') },
      journalPath: path.join(configDir, 'journal.sqlite'),
      logFile: path.join(configDir, 'host.log'),
      ...plan.config,
    }),
    { mode: 0o600 },
  );
  log(`acceptance host-${AGENT}: node ${process.version}, work dir ${work}${plan.config.claudeConfigDir ? `, claudeConfigDir ${plan.config.claudeConfigDir}` : ''}`);

  // 1. Start the host with the CLI.
  let host = await startHost();
  log(`step 1 ok: nano-host start --insecure-dev --config <tmp>/config/config.json; pid ${host.child.pid}, origin ${host.origin}, agents ${JSON.stringify(host.agents)}`);

  // 2. Pair through the CLI and POST /v1/pair (twice: the phone, and a second client for steps 6 and 8).
  const deviceA = await pairDevice(host.origin, 'Acceptance A');
  const deviceB = await pairDevice(host.origin, 'Acceptance B');
  log(`step 2 ok: nano-host pair printed a code, POST /v1/pair returned clientId ${deviceA.clientId} with a device token (${deviceA.deviceToken.length} chars); second client ${deviceB.clientId} paired the same way`);

  // 3. Stream, initialize, session/start (the agent under test), turn/start that must write a file.
  let a = await Client.connect(host.origin, deviceA);
  const init = await a.handshake('Acceptance A');
  const agent = (init.agents as Json[]).find((entry) => entry.id === AGENT);
  check(agent?.status === 'ready', `${AGENT} not ready: ${JSON.stringify(agent)}`);
  const { session } = await a.call('session/start', { agentId: AGENT, cwd, settings: plan.settings });
  const sessionId = session.sessionId as string;
  await a.call('session/open', { sessionId });
  const { turn } = await a.call('turn/start', {
    sessionId,
    input: [{ type: 'text', text: plan.prompt }],
    clientMessageId: randomUUID(),
  });
  log(`step 3 ok: stream open, initialize (host ${init.host.hostId}, ${AGENT} ${agent.status}${agent.version ? ` ${agent.version}` : ''}), session/start ${sessionId} in ${cwd} (${plan.describe}; settings in effect ${JSON.stringify(session.settings)}), turn/start ${turn.turnId}`);

  // 4. Approval round trip, turn completes, the file exists.
  const approvals: string[] = [];
  const first = await driveTurn(a, sessionId, turn.turnId, (request, decision) =>
    approvals.push(`seq ${request.seq} ${request.kind} ${approvalSummary(request)} -> ${decision}`),
  );
  check(approvals.length > 0, 'the turn completed without an approval/request');
  check(first.status === 'completed', `first turn ${first.status}: ${JSON.stringify(first.error)}`);
  const file = path.join(cwd, 'hello.txt');
  check(existsSync(file), `${file} does not exist`);
  const content = readFileSync(file, 'utf8');
  check(content.trim() === 'hello', `hello.txt holds ${JSON.stringify(content)}`);
  const savedCursor = a.cursor(sessionId);
  log(`step 4 ok: approval/request then approval/resolve accept (${approvals.join('; ')}), turn/completed status ${first.status}, reply ${JSON.stringify(reply(a.events(sessionId), turn.turnId))}, hello.txt exists with ${JSON.stringify(content)}; client A saved cursor ${savedCursor}`);

  // 5. SIGKILL the host, restart with the same config folder.
  const killedPid = host.child.pid;
  const exited = new Promise((resolve) => host.child.once('exit', (code, signal) => resolve(signal ?? code)));
  host.child.kill('SIGKILL');
  const how = await exited;
  const closeA = await a.closed;
  host = await startHost();
  log(`step 5 ok: host pid ${killedPid} killed (${String(how)}; client A stream closed ${closeA.code}), restarted with the same config folder as pid ${host.child.pid} at ${host.origin}`);

  // The gap: while A is disconnected, client B runs a follow-up turn on the same session.
  const b = await Client.connect(host.origin, deviceB);
  await b.handshake('Acceptance B');
  const opened = await b.call('session/open', { sessionId });
  const follow = await b.call('turn/start', {
    sessionId,
    input: [{ type: 'text', text: 'What is the name of the file you created in this conversation? Reply with the file name only.' }],
    clientMessageId: randomUUID(),
  });
  const second = await driveTurn(b, sessionId, follow.turn.turnId, () => {});
  check(second.status === 'completed', `follow-up turn ${second.status}: ${JSON.stringify(second.error)}`);
  const followReply = reply(b.events(sessionId), follow.turn.turnId);
  check(followReply.includes('hello.txt'), `follow-up reply does not name hello.txt: ${JSON.stringify(followReply)}`);
  log(`gap: client B opened the session (${opened.mode} mode, cursor ${opened.cursor}) and ran follow-up turn ${follow.turn.turnId}: status ${second.status}, reply ${JSON.stringify(followReply)}; journal head now ${b.cursor(sessionId)}`);

  // 6. A reconnects with the same token and catches up from its saved cursor.
  a = await Client.connect(host.origin, deviceA);
  await a.handshake('Acceptance A');
  const resumed = await a.call('session/open', { sessionId, cursor: savedCursor });
  check(resumed.mode === 'events', `session/open with cursor answered mode ${resumed.mode}`);
  const missed = resumed.events as Json[];
  check(missed.length > 0, 'no missed events');
  check(missed[0].params.seq === savedCursor + 1, `first missed event has seq ${missed[0].params.seq}, expected ${savedCursor + 1}`);
  check(
    missed.every((e, i) => i === 0 || e.params.seq === missed[i - 1].params.seq + 1),
    'missed events are not dense',
  );
  const missedTurn = missed.find((e) => e.method === 'turn/completed' && e.params.turn.turnId === follow.turn.turnId);
  check(missedTurn, 'the follow-up turn/completed is not among the missed events');
  check(reply(missed, follow.turn.turnId).includes('hello.txt'), 'the follow-up reply is not among the missed events');
  const methods = [...new Set(missed.map((e) => e.method as string))].join(', ');
  // Claude Code reports its own session id in every system/init (host log, module claude): one id across
  // both host processes means the restarted host resumed the same engine session.
  const engineIds = [...readFileSync(path.join(configDir, 'host.log'), 'utf8').matchAll(/system\/init session=([0-9a-f-]+)/g)].map((m) => m[1]);
  const engineNote =
    engineIds.length > 0 ? `; engine system/init session ids across both host processes: ${[...new Set(engineIds)].join(', ')} (${engineIds.length} inits)` : '';
  log(`step 6 ok: client A reconnected with the same token; session/open cursor ${savedCursor} returned mode events with ${missed.length} events, seq ${missed[0].params.seq} to ${missed.at(-1)!.params.seq} (cursor ${resumed.cursor}), methods ${methods}; the resumed session continued: follow-up turn ${follow.turn.turnId} ${missedTurn.params.turn.status}, reply ${JSON.stringify(reply(missed, follow.turn.turnId))}${engineNote}`);

  // 7. session/open without a cursor: snapshot with the turns.
  const snapshot = await a.call('session/open', { sessionId, turns: 5 });
  check(snapshot.mode === 'snapshot', `session/open without cursor answered mode ${snapshot.mode}`);
  const turns = snapshot.turns as Json[];
  check(turns.some((t) => t.turnId === turn.turnId) && turns.some((t) => t.turnId === follow.turn.turnId), 'snapshot misses a turn');
  log(`step 7 ok: session/open without cursor returned mode snapshot, cursor ${snapshot.cursor}, ${turns.length} turns: ${turns.map((t) => `${t.turnId} ${t.status} (${t.items.length} items)`).join(', ')}`);

  // 8. device/list shows both clients; revoking B closes its stream with 4003.
  const { devices } = await a.call('device/list');
  const ids = (devices as Json[]).map((d) => d.clientId as string);
  check(ids.includes(deviceA.clientId) && ids.includes(deviceB.clientId), `device/list: ${JSON.stringify(devices)}`);
  await a.call('device/revoke', { clientId: deviceB.clientId });
  const closeB = await Promise.race([b.closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('B not closed')), 10_000))]);
  check(closeB.code === 4003, `client B stream closed with ${closeB.code}`);
  log(`step 8 ok: device/list shows ${(devices as Json[]).map((d) => `${d.clientId} ${JSON.stringify(d.displayName)}${d.current ? ' (current)' : ''}`).join(', ')}; device/revoke ${deviceB.clientId} closed its stream with ${closeB.code} ${JSON.stringify(closeB.reason)}`);

  a.close();
  host.child.kill('SIGTERM');
  await new Promise((resolve) => host.child.once('exit', resolve));
  log(`acceptance host-${AGENT} passed: all eight steps ok`);
}

main()
  .then(() => {
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`acceptance host-${AGENT} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    running?.kill('SIGTERM');
    process.exit(1);
  });
