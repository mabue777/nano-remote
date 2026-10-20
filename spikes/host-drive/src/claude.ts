// Claude adapter: the Claude Agent SDK's query() in streaming-input mode, permission prompts via canUseTool.
import { spawn, type ChildProcess } from "node:child_process";
import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Trace, type Adapter, type Decision, type Ev } from "./host.ts";

const MODEL = "opus";
const KIND: Record<string, string> = { Bash: "command", Write: "fileChange", Edit: "fileChange", MultiEdit: "fileChange", NotebookEdit: "fileChange", AskUserQuestion: "input" };
const ITEM: Record<string, string> = { Bash: "command", Write: "fileChange", Edit: "fileChange", MultiEdit: "fileChange" };

/** The SDK child inherits this env. Drop the parent Claude Code session's variables so the child is a
 *  clean headless run (keeps CLAUDE_CONFIG_DIR, which is where this machine's login lives). */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) continue;
    env[k] = v;
  }
  return env;
}

/** Push-based async iterable: the SDK's streaming-input prompt. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(text: string): void {
    this.items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

export type ClaudeOptions = { settingSources?: Array<"user" | "project" | "local">; permissionMode?: "default" | "auto" };

export class ClaudeAdapter implements Adapter {
  readonly agentId = "claude";
  onEvent: (ev: Ev) => void = () => {};
  /** Every canUseTool call, for the probe and for NOTES.md. */
  readonly canUseToolCalls: Array<{ toolName: string; input: unknown }> = [];
  private trace: Trace;
  private opts: ClaudeOptions;
  private child: ChildProcess | undefined;
  private q: Query | undefined;
  private inbox = new Inbox();
  private sessionId = "";
  resumeInfo = "";
  private turnSeq = 0;
  private turnId = "";
  private waiting = new Map<string, { input: Record<string, unknown>; suggestions: unknown; res: (r: PermissionResult) => void }>();
  private initWaiters: Array<(id: string) => void> = [];
  /** How the probe answers AskUserQuestion. */
  answerQuestions: ((input: any) => Record<string, string>) | undefined;

  constructor(trace: Trace, opts: ClaudeOptions = { settingSources: [], permissionMode: "default" }) {
    this.trace = trace;
    this.opts = opts;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  private open(cwd: string, resume?: string): void {
    const canUseTool: CanUseTool = (toolName, input, { suggestions, toolUseID }) => {
      this.canUseToolCalls.push({ toolName, input });
      this.trace.write("canUseTool", { toolName, input, toolUseID, suggestions });
      const kind = KIND[toolName] ?? "permission";
      const requestId = `req_${toolUseID ?? Math.random().toString(36).slice(2)}`;
      const request: Record<string, unknown> = {
        requestId,
        kind,
        engineMethod: `canUseTool:${toolName}`,
        turnId: this.turnId,
        itemId: toolUseID,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: null,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      };
      if (kind === "command") Object.assign(request, { command: (input as any).command, cwd, reason: (input as any).description ?? null });
      else if (kind === "fileChange") Object.assign(request, { changes: [{ path: (input as any).file_path, kind: "add", diff: String((input as any).content ?? (input as any).new_string ?? "").slice(0, 200) }], reason: null });
      else if (kind === "input") Object.assign(request, { kind: "input", isBlocking: true, questions: (input as any).questions });
      else Object.assign(request, { permissions: [{ tool: toolName, input }], scope: "turn", reason: null });
      return new Promise<PermissionResult>((res) => {
        this.waiting.set(requestId, { input, suggestions, res });
        if (kind === "input" && this.answerQuestions) {
          // Probe path: answer like a phone would via input/answer.
          this.onEvent({ method: "input/request", params: { request } });
          const answers = this.answerQuestions(input);
          this.waiting.delete(requestId);
          res({ behavior: "allow", updatedInput: { ...input, answers } });
          return;
        }
        this.onEvent({ method: kind === "input" ? "input/request" : "approval/request", params: { request } });
      });
    };

    this.q = query({
      prompt: this.inbox,
      options: {
        cwd,
        model: MODEL,
        resume,
        canUseTool,
        permissionMode: this.opts.permissionMode,
        settingSources: this.opts.settingSources,
        env: childEnv(),
        stderr: (d) => this.trace.write("claude.stderr", d.slice(0, 2000)),
        spawnClaudeCodeProcess: (o) => {
          const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
          child.stderr!.on("data", (d) => this.trace.write("claude.child.stderr", String(d).slice(0, 2000)));
          this.child = child;
          this.trace.write("claude.spawn", { pid: child.pid, command: o.command, args: o.args });
          return child;
        },
      },
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q!) this.onMessage(m as any);
    } catch (e) {
      this.trace.write("claude.pump.error", String(e));
    }
  }

  private onMessage(m: any): void {
    if (m.type !== "stream_event") this.trace.write("sdk->host", m);
    if (m.type === "system" && m.subtype === "init") {
      this.sessionId = m.session_id;
      for (const w of this.initWaiters.splice(0)) w(m.session_id);
      return;
    }
    if (m.type === "assistant") {
      for (const b of m.message.content ?? []) {
        if (b.type === "text" && b.text) {
          this.onEvent({ method: "item/completed", params: { turnId: this.turnId, item: { itemId: `${m.uuid}:text`, type: "agentMessage", turnId: this.turnId, status: "completed", text: b.text } } });
        } else if (b.type === "tool_use") {
          const type = ITEM[b.name] ?? "toolCall";
          const item: any = { itemId: b.id, type, turnId: this.turnId, status: "inProgress" };
          if (type === "command") Object.assign(item, { command: b.input.command });
          else if (type === "fileChange") item.changes = [{ path: b.input.file_path, kind: "add" }];
          else Object.assign(item, { tool: b.name, arguments: b.input });
          this.onEvent({ method: "item/started", params: { turnId: this.turnId, item } });
        }
      }
      return;
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        const status = b.is_error ? "failed" : "completed";
        this.onEvent({ method: "item/completed", params: { turnId: this.turnId, item: { itemId: b.tool_use_id, type: "toolCall", turnId: this.turnId, status, result: String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 300) } } });
      }
      return;
    }
    if (m.type === "result") {
      const status = m.subtype === "success" ? "completed" : "failed";
      this.onEvent({ method: "usage/updated", params: { usage: { inputTokens: m.usage?.input_tokens, outputTokens: m.usage?.output_tokens } } });
      this.onEvent({ method: "turn/completed", params: { turn: { turnId: this.turnId, status, error: status === "failed" ? { code: m.subtype, message: String(m.errors ?? "") } : null } } });
      this.onEvent({ method: "status/changed", params: { status: "idle" } });
    }
  }

  private nextInit(): Promise<string> {
    return new Promise((r) => this.initWaiters.push(r));
  }

  /** session/start. The SDK emits system/init (with the session id) once the first user message is read,
   *  so the host's session/start only spawns the process; the id is known at the first turn. */
  async start(cwd: string): Promise<string> {
    this.open(cwd);
    return "(assigned at first turn)";
  }

  async resume(sessionId: string, cwd: string): Promise<string> {
    // The id is confirmed by system/init at the next turn; startTurn waits for it.
    this.open(cwd, sessionId);
    this.resumeInfo = "query({resume}) spawned; system/init at the follow-up turn confirmed the id";
    return sessionId;
  }

  engineSessionId(): string {
    return this.sessionId;
  }

  async startTurn(text: string, _clientMessageId: string): Promise<string> {
    this.turnSeq += 1;
    this.turnId = `trn_claude_${this.turnSeq}_${Date.now().toString(36)}`;
    const init = this.nextInit();
    this.onEvent({ method: "status/changed", params: { status: "running" } });
    this.onEvent({ method: "turn/started", params: { turn: { turnId: this.turnId, status: "inProgress" } } });
    this.inbox.push(text);
    if (!this.sessionId) this.sessionId = await init;
    return this.turnId;
  }

  resolve(requestId: string, decision: Decision): void {
    const w = this.waiting.get(requestId);
    if (!w) return;
    this.waiting.delete(requestId);
    if (decision === "accept") w.res({ behavior: "allow", updatedInput: w.input });
    else if (decision === "acceptForSession") w.res({ behavior: "allow", updatedInput: w.input, updatedPermissions: (w.suggestions as any) ?? [] });
    else w.res({ behavior: "deny", message: "The user declined this action.", interrupt: decision === "cancel" });
  }

  kill(): Promise<{ pid: number; signal: string | null; code: number | null }> {
    const child = this.child!;
    const pid = child.pid!;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ pid, signal: child.signalCode, code: child.exitCode });
    return new Promise((res) => {
      child.once("exit", (code, signal) => res({ pid, signal, code }));
      child.kill("SIGKILL");
    });
  }

  close(): void {
    this.inbox.close();
    this.q?.close?.();
  }
}
