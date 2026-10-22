// Kimi adapter over `kimi acp` (Agent Client Protocol), mapped onto the protocol-v1 vocabulary the
// host-drive spike used. Session mode stays "default" ("Manual approvals"), so tool calls that need
// approval arrive as the reverse request session/request_permission.
import { randomUUID } from "node:crypto";
import { AcpClient } from "./acp.ts";
import { Trace } from "./log.ts";
import type { Adapter, Decision, Ev } from "./host.ts";

const DECISION_BY_KIND: Record<string, Decision> = { allow_once: "accept", allow_always: "acceptForSession", reject_once: "decline" };
const APPROVAL_KIND: Record<string, string> = { edit: "fileChange", execute: "command" };

export class KimiAcpAdapter implements Adapter {
  readonly agentId = "kimi";
  onEvent: (ev: Ev) => void = () => {};
  resumeInfo = "";
  private client!: AcpClient;
  private sessionId = "";
  private turnId = "";
  private replaying = false;
  private replayed: Record<string, number> = {};
  private agentText = "";
  private approvals = new Map<string, { rpcId: number | string; optionByDecision: Record<string, string> }>();
  private nextRequest = 0;
  private kindByToolCall = new Map<string, string>(); // later tool_call_update messages omit `kind`

  private trace: Trace;
  private env: Record<string, string | undefined>;
  private cwd: string;
  private model: string | undefined;
  constructor(trace: Trace, env: Record<string, string | undefined>, cwd: string, model?: string) {
    this.trace = trace;
    this.env = env;
    this.cwd = cwd;
    this.model = model;
  }

  pid(): number | undefined {
    return this.client?.proc.pid;
  }

  engineSessionId(): string {
    return this.sessionId;
  }

  private async boot(): Promise<void> {
    this.client = new AcpClient(this.trace, this.env, this.cwd);
    this.client.onNotification = (n) => this.onUpdate(n.params);
    this.client.onPermission = (r) => this.onPermission(r.rpcId, r.params);
    await this.client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "nano-kimi-drive-spike", version: "0.0.0" },
    });
  }

  private async pinModel(): Promise<void> {
    if (!this.model) return;
    await this.client.call("session/set_config_option", { sessionId: this.sessionId, configId: "model", value: this.model });
  }

  async start(cwd: string): Promise<string> {
    await this.boot();
    const r = await this.client.call("session/new", { cwd, mcpServers: [] });
    this.sessionId = r.sessionId;
    const mode = r.modes?.currentModeId;
    if (mode !== "default") throw new Error(`expected mode default (manual approvals), got ${mode}`);
    await this.pinModel();
    return this.sessionId;
  }

  async resume(engineSessionId: string, cwd: string): Promise<string> {
    await this.boot();
    // session/load replays the stored history as session/update before it returns. The host already has
    // those events in its Journal, so the adapter counts them instead of re-emitting them.
    this.replaying = true;
    const r = await this.client.call("session/load", { sessionId: engineSessionId, cwd, mcpServers: [] });
    this.replaying = false;
    this.sessionId = engineSessionId;
    await this.pinModel();
    const counts = Object.entries(this.replayed).map(([k, v]) => `${k}x${v}`).join(" ");
    this.resumeInfo = `session/load replayed [${counts}] mode=${r?.modes?.currentModeId}`;
    return this.sessionId;
  }

  async startTurn(text: string, _clientMessageId: string): Promise<string> {
    this.turnId = `turn_${randomUUID()}`;
    this.agentText = "";
    const turnId = this.turnId;
    this.onEvent({ method: "turn/started", params: { turn: { turnId, status: "inProgress" } } });
    this.client
      .call("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] })
      .then((r) => this.endTurn(turnId, r.stopReason === "end_turn" ? "completed" : r.stopReason === "cancelled" ? "interrupted" : "failed", r.stopReason))
      .catch((e) => this.endTurn(turnId, "failed", String(e.message)));
    return turnId;
  }

  private endTurn(turnId: string, status: string, stopReason: string): void {
    if (this.agentText) {
      this.onEvent({ method: "item/completed", params: { item: { itemId: `${turnId}:msg`, type: "agentMessage", text: this.agentText, status: "completed" } } });
    }
    this.onEvent({ method: "turn/completed", params: { turn: { turnId, status, stopReason } } });
  }

  private onUpdate(p: any): void {
    const u = p?.update ?? {};
    if (this.replaying) {
      this.replayed[u.sessionUpdate] = (this.replayed[u.sessionUpdate] ?? 0) + 1;
      return;
    }
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.agentText += u.content?.text ?? "";
        break;
      case "tool_call":
        this.kindByToolCall.set(u.toolCallId, u.kind);
        this.onEvent({ method: "item/started", params: { item: { itemId: u.toolCallId, type: u.kind === "edit" ? "fileChange" : "toolCall", title: u.title, status: "inProgress" } } });
        break;
      case "tool_call_update":
        if (u.kind) this.kindByToolCall.set(u.toolCallId, u.kind);
        if (u.status === "completed" || u.status === "failed") {
          const content = (u.content ?? []).map((c: any) => c.content?.text ?? "").join(" ");
          this.onEvent({ method: "item/completed", params: { item: { itemId: u.toolCallId, type: this.kindByToolCall.get(u.toolCallId) === "edit" ? "fileChange" : "toolCall", title: u.title, status: u.status, rawOutput: u.rawOutput ?? content } } });
        }
        break;
      default:
        break; // available_commands_update, session_info_update, usage_update, ...: not mapped in this spike
    }
  }

  private onPermission(rpcId: number | string, p: any): void {
    const requestId = `req_${this.nextRequest++}`;
    const optionByDecision: Record<string, string> = {};
    for (const o of p.options ?? []) if (DECISION_BY_KIND[o.kind]) optionByDecision[DECISION_BY_KIND[o.kind]] = o.optionId;
    this.approvals.set(requestId, { rpcId, optionByDecision });
    const text = (p.toolCall?.content ?? []).map((c: any) => c.content?.text ?? "").join(" ");
    this.onEvent({
      method: "approval/request",
      params: {
        request: {
          requestId,
          kind: APPROVAL_KIND[p.toolCall?.kind] ?? "fileChange",
          turnId: this.turnId,
          itemId: p.toolCall?.toolCallId,
          engineMethod: "session/request_permission",
          toolInput: { title: p.toolCall?.title, text, options: (p.options ?? []).map((o: any) => `${o.optionId}:${o.kind}`) },
          // cancel is always possible in ACP: answer the request with outcome "cancelled".
          availableDecisions: [...Object.keys(optionByDecision), "cancel"],
        },
      },
    });
  }

  resolve(requestId: string, decision: Decision): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    const optionId = a.optionByDecision[decision];
    const outcome = decision === "cancel" || !optionId ? { outcome: "cancelled" } : { outcome: "selected", optionId };
    this.client.respond(a.rpcId, { outcome });
  }

  kill(): Promise<{ pid: number; signal: string | null; code: number | null }> {
    return this.client.kill();
  }
}
