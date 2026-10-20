// An in-memory ReplicaTransport: records requests and lets a test answer them by hand or by rule.
import type { ReplicaTransport } from '../src/replica/replica';
import type { StorageLike } from '../src/replica/storage';
import { RequestError, type ClientState } from '../src/stream/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Call {
  method: string;
  params: any;
  resolve: (result: any) => void;
  reject: (error: RequestError) => void;
  settled: boolean;
}

type Rule = (params: any) => any;

export class FakeTransport implements ReplicaTransport {
  state: ClientState = 'idle';
  readonly calls: Call[] = [];
  private readonly rules = new Map<string, Rule>();
  private readonly ready = new Set<() => void>();
  private readonly suspend = new Set<() => void>();
  private readonly notes = new Set<(params: any, method: string) => void>();

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const call: Call = {
        method,
        params,
        resolve: (r) => {
          call.settled = true;
          resolve(r);
        },
        reject: (e) => {
          call.settled = true;
          reject(e);
        },
        settled: false,
      };
      this.calls.push(call);
      const rule = this.rules.get(method);
      if (rule === undefined) return;
      try {
        call.resolve(rule(params));
      } catch (error) {
        call.reject(error as RequestError);
      }
    });
  }

  on(event: 'ready' | 'suspend', listener: () => void): () => void {
    const set = event === 'ready' ? this.ready : this.suspend;
    set.add(listener);
    return () => set.delete(listener);
  }

  onNotification(_method: string, handler: (params: any, method: string) => void): () => void {
    this.notes.add(handler);
    return () => this.notes.delete(handler);
  }

  /** Answers every future `method` request with rule(params); a thrown RequestError rejects. */
  rule(method: string, rule: Rule): void {
    this.rules.set(method, rule);
  }

  goReady(): void {
    this.state = 'ready';
    for (const fn of this.ready) fn();
  }

  fireSuspend(): void {
    for (const fn of this.suspend) fn();
  }

  notify(method: string, params: any): void {
    for (const fn of this.notes) fn(params, method);
  }

  /** Unsettled calls of a method, oldest first. */
  open(method: string): Call[] {
    return this.calls.filter((c) => c.method === method && !c.settled);
  }

  last(method: string): Call {
    const call = [...this.calls].reverse().find((c) => c.method === method);
    if (call === undefined) throw new Error(`no ${method} call`);
    return call;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

export function rpcError(code: string, data?: Record<string, unknown>): RequestError {
  return new RequestError(code, code, data);
}

export class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failWhenLongerThan = Infinity;
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (value.length > this.failWhenLongerThan) throw new Error('QuotaExceededError');
    this.writes += 1;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
