// Throwaway spike. A fake host: one Journal per session, protocol-v1 method names toward the phone,
// one adapter per agent behind it. In-process only; the phone "stream" is a callback.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_DIR = join(SPIKE_DIR, "logs");

export type Ev = { method: string; params: Record<string, any> };
export type Decision = "accept" | "acceptForSession" | "decline" | "cancel";

/** What an agent adapter must provide (protocol-v1 section 11). Emits normalized events, no seq. */
export interface Adapter {
  readonly agentId: string;
  pid(): number | undefined;
  /** session/start: create a brand-new engine session. Returns the engine's own session id. */
  start(cwd: string): Promise<string>;
  /** session/open after a host or engine restart: reattach to an engine session by id. */
  resume(engineSessionId: string, cwd: string): Promise<string>;
  /** turn/start: returns the turn id. */
  startTurn(text: string, clientMessageId: string): Promise<string>;
  /** approval/resolve from a client. */
  resolve(requestId: string, decision: Decision): void;
  /** SIGKILL the engine process. Resolves after the exit is observed. */
  kill(): Promise<{ pid: number; signal: string | null; code: number | null }>;
  /** The engine session id as the engine last reported it (Claude only learns it at the first turn). */
  engineSessionId?(): string;
  /** One line on what resume returned, for the step log. */
  resumeInfo?: string;
  onEvent: (ev: Ev) => void;
}

export function now(): string {
  return new Date().toISOString();
}

/** logs/<agent>.log: exactly one timestamped line per acceptance step. */
export class StepLog {
  private path: string;
  private n = 0;
  constructor(agent: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.path = join(LOG_DIR, `${agent}.log`);
    writeFileSync(this.path, "");
  }
  step(name: string, detail: string): void {
    this.n += 1;
    const line = `${now()}  ${this.n}. ${name}  ${detail}`;
    appendFileSync(this.path, line + "\n");
    console.log(line);
  }
}

/** logs/<agent>.trace.jsonl: everything else (wire traffic, journal), for debugging the spike. */
export class Trace {
  private path: string;
  constructor(agent: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.path = join(LOG_DIR, `${agent}.trace.jsonl`);
    writeFileSync(this.path, "");
  }
  write(dir: string, msg: unknown): void {
    appendFileSync(this.path, JSON.stringify({ t: now(), dir, msg }) + "\n");
  }
}

type Phone = (ev: Ev & { params: { seq: number } }) => void;

export class Host {
  readonly sessionId = `ses_${Math.random().toString(36).slice(2, 10)}`;
  engineSessionId = "";
  cwd = "";
  private journal: Array<Ev & { params: { seq: number } }> = [];
  private pending = new Map<string, Ev["params"]>();
  private subscriber: Phone | undefined;
  private turnByClientId = new Map<string, string>();
  private waiters: Array<{ pred: (e: Ev) => boolean; res: (e: Ev) => void }> = [];

  adapter!: Adapter;
  private trace: Trace;
  constructor(adapter: Adapter, trace: Trace) {
    this.trace = trace;
    this.attach(adapter);
  }

  attach(adapter: Adapter): void {
    this.adapter = adapter;
    adapter.onEvent = (ev) => this.emit(ev);
  }

  /** Append to the Journal, then deliver live to a subscribed phone. */
  private emit(ev: Ev): void {
    const seq = this.journal.length + 1;
    const full = { method: ev.method, params: { sessionId: this.sessionId, seq, ...ev.params } };
    this.journal.push(full);
    this.trace.write("journal", full);
    if (ev.method === "approval/request" || ev.method === "input/request") {
      this.pending.set(ev.params.request.requestId, ev.params.request);
    }
    this.subscriber?.(full);
    for (const w of [...this.waiters]) {
      if (w.pred(full)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.res(full);
      }
    }
  }

  /** Host-side observer, used by the scenario while no phone is connected. */
  waitFor(pred: (e: Ev) => boolean, timeoutMs = 300_000): Promise<Ev> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("host waitFor timed out")), timeoutMs);
      this.waiters.push({ pred, res: (e) => (clearTimeout(t), res(e)) });
    });
  }

  head(): number {
    return this.journal.length;
  }

  disconnect(): void {
    this.subscriber = undefined;
  }

  /** The phone-facing request surface (protocol-v1 sections 5 to 7). */
  async request(method: string, params: any, phone?: Phone): Promise<any> {
    this.trace.write("phone->host", { method, params });
    switch (method) {
      case "session/start": {
        this.cwd = params.cwd;
        this.subscriber = phone;
        this.engineSessionId = await this.adapter.start(params.cwd);
        return { session: { sessionId: this.sessionId, agentId: params.agentId, cwd: params.cwd, status: "idle" } };
      }
      case "turn/start": {
        const existing = this.turnByClientId.get(params.clientMessageId);
        if (existing) return { turn: { turnId: existing } };
        const text = params.input.map((p: any) => p.text).join("\n");
        const turnId = await this.adapter.startTurn(text, params.clientMessageId);
        if (this.adapter.engineSessionId && !this.engineSessionId.match(/^[0-9a-f-]{36}$/)) this.engineSessionId = this.adapter.engineSessionId();
        this.turnByClientId.set(params.clientMessageId, turnId);
        return { turn: { turnId, status: "inProgress" } };
      }
      case "approval/resolve": {
        const req = this.pending.get(params.requestId);
        if (!req) return { error: { code: "not_found" } };
        this.pending.delete(params.requestId);
        this.adapter.resolve(params.requestId, params.decision);
        this.emit({
          method: "request/resolved",
          params: { requestId: params.requestId, kind: req.kind, resolvedBy: "phone", decision: params.decision },
        });
        return { ok: true };
      }
      case "session/open": {
        // Events mode only: this spike's Journal never compacts, so any cursor is still held.
        const events = this.journal.filter((e) => e.params.seq > (params.cursor ?? 0));
        this.subscriber = phone;
        const pending = { approvals: [...this.pending.values()].filter((r) => r.kind !== "input"), inputs: [...this.pending.values()].filter((r) => r.kind === "input") };
        return { mode: "events", session: { sessionId: this.sessionId }, events, cursor: this.head(), pending };
      }
      default:
        return { error: { code: "method_not_found" } };
    }
  }
}

/** The scripted fake phone: applies events in seq order, ignores seq <= lastApplied. */
export class FakePhone {
  lastApplied = 0;
  received: Ev[] = [];
  private waiters: Array<{ pred: (e: Ev) => boolean; res: (e: Ev) => void }> = [];
  private host: Host;
  constructor(host: Host) {
    this.host = host;
  }

  readonly onEvent = (ev: Ev & { params: { seq: number } }): void => {
    if (ev.params.seq <= this.lastApplied) return;
    this.lastApplied = ev.params.seq;
    this.received.push(ev);
    for (const w of [...this.waiters]) {
      if (w.pred(ev)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.res(ev);
      }
    }
  };

  call(method: string, params: any): Promise<any> {
    return this.host.request(method, params, this.onEvent);
  }

  waitFor(pred: (e: Ev) => boolean, timeoutMs = 300_000): Promise<Ev> {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("phone waitFor timed out")), timeoutMs);
      this.waiters.push({ pred, res: (e) => (clearTimeout(t), res(e)) });
    });
  }
}
