// Throwaway spike. A minimal ACP (Agent Client Protocol) client for `kimi acp`: newline-delimited
// JSON-RPC 2.0 over stdio, with reverse requests (session/request_permission) answered by the client.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { KIMI_BIN, Trace } from "./log.ts";

export type Notification = { method: string; params: any };
export type PermissionRequest = { rpcId: number | string; params: any };

export class AcpClient {
  proc!: ChildProcess;
  private nextId = 1;
  private calls = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; method: string }>();
  notifications: Notification[] = [];
  onNotification: (n: Notification) => void = () => {};
  onPermission: (r: PermissionRequest) => void = () => {};
  exit: Promise<{ code: number | null; signal: string | null }>;

  private trace: Trace;
  constructor(trace: Trace, env: Record<string, string | undefined>, cwd: string) {
    this.trace = trace;
    this.proc = spawn(KIMI_BIN, ["acp"], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr!.on("data", (d) => this.trace.write("kimi.stderr", String(d).slice(0, 2000)));
    createInterface({ input: this.proc.stdout! }).on("line", (l) => this.onLine(l));
    this.exit = new Promise((r) => this.proc.on("exit", (code, signal) => r({ code, signal })));
    this.exit.then((e) => {
      for (const c of this.calls.values()) c.rej(new Error(`kimi acp exited ${JSON.stringify(e)} during ${c.method}`));
      this.calls.clear();
    });
  }

  private send(msg: object): void {
    this.trace.write("client->kimi", msg);
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  call(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((res, rej) => this.calls.set(id, { res, rej, method }));
  }

  respond(rpcId: number | string, result: object): void {
    this.send({ id: rpcId, result });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.trace.write("kimi->client.unparsed", line.slice(0, 500));
      return;
    }
    this.trace.write("kimi->client", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const c = this.calls.get(msg.id);
      if (!c) return;
      this.calls.delete(msg.id);
      if (msg.error) c.rej(Object.assign(new Error(`${c.method}: ${msg.error.message}`), { rpc: msg.error }));
      else c.res(msg.result);
    } else if (msg.id !== undefined && msg.method === "session/request_permission") {
      this.onPermission({ rpcId: msg.id, params: msg.params });
    } else if (msg.id !== undefined) {
      // Unhandled reverse request (fs/*, terminal/*): we did not advertise those capabilities.
      this.send({ id: msg.id, error: { code: -32601, message: `spike client does not implement ${msg.method}` } });
    } else {
      const n = { method: msg.method, params: msg.params };
      this.notifications.push(n);
      this.onNotification(n);
    }
  }

  async kill(): Promise<{ pid: number; code: number | null; signal: string | null }> {
    const pid = this.proc.pid!;
    this.proc.kill("SIGKILL");
    const e = await this.exit;
    return { pid, ...e };
  }
}
