// Codex adapter: `codex app-server` over stdio, newline-delimited JSON-RPC.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Trace, type Adapter, type Decision, type Ev } from "./host.ts";

export const CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
// The operator's ~/.config/codex/config.toml pins a model this ChatGPT plan rejects (400), so the spike
// names the engine's own model/list default explicitly instead of editing the operator's config.
const MODEL = process.env.SPIKE_CODEX_MODEL ?? "gpt-6-luna";
const POLICY = { approvalPolicy: "on-request", sandbox: "read-only", model: MODEL } as const;
const APPROVAL_KIND: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permission",
};
const ITEM_TYPE: Record<string, string> = {
  userMessage: "userMessage",
  agentMessage: "agentMessage",
  reasoning: "reasoning",
  commandExecution: "command",
  fileChange: "fileChange",
  mcpToolCall: "toolCall",
  dynamicToolCall: "toolCall",
  webSearch: "toolCall",
  plan: "plan",
};

export class CodexAdapter implements Adapter {
  readonly agentId = "codex";
  onEvent: (ev: Ev) => void = () => {};
  private proc!: ChildProcess;
  private nextId = 1;
  private calls = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private approvals = new Map<string, { rpcId: number | string; method: string }>();
  private threadId = "";
  resumeInfo = "";

  private trace: Trace;
  constructor(trace: Trace) {
    this.trace = trace;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  private async boot(): Promise<void> {
    this.proc = spawn(CODEX_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc.stderr!.on("data", (d) => this.trace.write("codex.stderr", String(d).slice(0, 2000)));
    createInterface({ input: this.proc.stdout! }).on("line", (line) => this.onLine(line));
    await this.call("initialize", {
      clientInfo: { name: "nano-remote-host-drive-spike", title: "Nano Remote spike", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  private send(msg: object): void {
    this.trace.write("host->codex", msg);
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private call(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((res, rej) => this.calls.set(id, { res, rej }));
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.trace.write("codex->host.unparsed", line.slice(0, 500));
      return;
    }
    const isDelta = typeof msg.method === "string" && /delta|Delta/.test(msg.method);
    if (!isDelta) this.trace.write("codex->host", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const c = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) c?.rej(new Error(`${JSON.stringify(msg.error)}`));
      else c?.res(msg.result);
      return;
    }
    if (msg.id !== undefined) return this.onServerRequest(msg);
    this.onNotification(msg.method, msg.params ?? {});
  }

  private onServerRequest(msg: any): void {
    const kind = APPROVAL_KIND[msg.method];
    if (!kind) {
      this.send({ id: msg.id, error: { code: -32601, message: `spike does not handle ${msg.method}` } });
      return;
    }
    const p = msg.params;
    const requestId = `req_${String(msg.id)}`;
    this.approvals.set(requestId, { rpcId: msg.id, method: msg.method });
    this.onEvent({
      method: "approval/request",
      params: {
        request: {
          requestId,
          kind,
          engineMethod: msg.method,
          turnId: p.turnId,
          itemId: p.itemId,
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: null,
          command: p.command,
          cwd: p.cwd,
          grantRoot: p.grantRoot,
          reason: p.reason ?? null,
          // The engine sends its own list; object-valued decisions (execpolicy amendments) are not in protocol v1.
          availableDecisions: (p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"]).filter((d: unknown) => typeof d === "string"),
        },
      },
    });
  }

  private onNotification(method: string, p: any): void {
    switch (method) {
      case "turn/started":
      case "turn/completed":
        this.onEvent({ method, params: { turn: { turnId: p.turn.id, status: p.turn.status, error: p.turn.error ?? null } } });
        return;
      case "item/started":
      case "item/completed": {
        const it = p.item;
        const type = ITEM_TYPE[it.type] ?? "other";
        const item: any = { itemId: it.id, type, turnId: p.turnId, status: it.status ?? (method === "item/completed" ? "completed" : "inProgress") };
        if (type === "agentMessage") item.text = it.text;
        if (type === "command") Object.assign(item, { command: it.command, cwd: it.cwd, exitCode: it.exitCode });
        if (type === "fileChange") item.changes = it.changes;
        if (type === "other") item.raw = { type: it.type };
        this.onEvent({ method, params: { item, turnId: p.turnId } });
        return;
      }
      case "thread/status/changed":
        this.onEvent({ method: "status/changed", params: { status: p.status?.type ?? p.status } });
        return;
      default:
        return; // deltas, token usage, rate limits, MCP startup, serverRequest/resolved: not needed here
    }
  }

  async start(cwd: string): Promise<string> {
    await this.boot();
    const r = await this.call("thread/start", { cwd, ...POLICY });
    this.threadId = r.thread.id;
    return this.threadId;
  }

  async resume(threadId: string, cwd: string): Promise<string> {
    await this.boot();
    const r = await this.call("thread/resume", { threadId, cwd, ...POLICY });
    this.threadId = r.thread.id;
    this.trace.write("codex.resume.turns", (r.thread.turns ?? []).map((t: any) => ({ id: t.id, status: t.status, items: t.items?.length })));
    const turns = r.thread.turns ?? [];
    this.resumeInfo = `thread/resume returned ${turns.length} prior turn(s) [${turns.map((t: any) => t.status).join(",")}]`;
    return this.threadId;
  }

  async startTurn(text: string, clientMessageId: string): Promise<string> {
    const r = await this.call("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      clientUserMessageId: clientMessageId,
    });
    return r.turn.id;
  }

  resolve(requestId: string, decision: Decision): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    this.send({ id: a.rpcId, result: { decision } });
  }

  kill(): Promise<{ pid: number; signal: string | null; code: number | null }> {
    const pid = this.proc.pid!;
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return Promise.resolve({ pid, signal: this.proc.signalCode, code: this.proc.exitCode });
    }
    return new Promise((res) => {
      this.proc.once("exit", (code, signal) => res({ pid, signal, code }));
      this.proc.kill("SIGKILL");
    });
  }
}
