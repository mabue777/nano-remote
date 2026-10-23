import { describe, expect, it } from 'vitest';

import type { ClientState } from '../../../stream/client';
import { KEEP_AWAKE_FAILED, KEEP_AWAKE_LINES, KeepAwakeModel, lineKind, type KeepAwakeLink } from './keep-awake-model';

type Handler = (params: Record<string, unknown>) => void;

class FakeLink implements KeepAwakeLink {
  state: ClientState = 'ready';
  readonly calls: { method: string; params?: Record<string, unknown> }[] = [];
  readonly notifications = new Map<string, Set<Handler>>();
  readonly readies = new Set<() => void>();
  status: Record<string, unknown> | undefined = { setting: 'pluggedIn', active: true, onBattery: false };
  failStatus = false;
  /** When set, host/settings/update waits for release(). */
  hold = false;
  failUpdate = false;
  private release: (() => void) | undefined;

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push(params === undefined ? { method } : { method, params });
    if (method === 'host/status') {
      if (this.failStatus) throw new Error('connection_lost');
      return (this.status === undefined ? { uptimeSeconds: 1 } : { uptimeSeconds: 1, keepAwake: this.status }) as T;
    }
    if (method === 'host/settings/update') {
      if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
      if (this.failUpdate) throw new Error('timeout');
      const setting = params?.keepAwake as string;
      this.status = { setting, active: setting === 'pluggedIn', onBattery: false };
      return { keepAwake: this.status } as T;
    }
    throw new Error(`unexpected ${method}`);
  }

  onNotification(method: string, handler: Handler): () => void {
    const set = this.notifications.get(method) ?? new Set();
    set.add(handler);
    this.notifications.set(method, set);
    return () => set.delete(handler);
  }

  on(_event: 'ready', listener: () => void): () => void {
    this.readies.add(listener);
    return () => this.readies.delete(listener);
  }

  notify(method: string, params: Record<string, unknown>): void {
    for (const handler of this.notifications.get(method) ?? []) handler(params);
  }

  ready(): void {
    for (const listener of this.readies) listener();
  }

  finish(): void {
    this.release?.();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(link = new FakeLink()): Promise<{ link: FakeLink; model: KeepAwakeModel }> {
  const model = new KeepAwakeModel(link);
  model.start();
  await settle();
  return { link, model };
}

describe('keep this Mac awake', () => {
  it('has the three status lines the phone shows, plus the restarting case', () => {
    expect(KEEP_AWAKE_LINES.active).toBe('Active');
    expect(KEEP_AWAKE_LINES.battery).toBe('On battery: the Mac may sleep');
    expect(KEEP_AWAKE_LINES.off).toBe('Off');
    expect(lineKind({ setting: 'pluggedIn', active: true, onBattery: false })).toBe('active');
    expect(lineKind({ setting: 'pluggedIn', active: false, onBattery: true })).toBe('battery');
    expect(lineKind({ setting: 'off', active: false, onBattery: true })).toBe('off');
    expect(lineKind({ setting: 'pluggedIn', active: false, onBattery: false })).toBe('inactive');
  });

  it('reads host/status on start: switch on, "Active"', async () => {
    const { link, model } = await started();
    expect(link.calls).toEqual([{ method: 'host/status' }]);
    expect(model.status).toEqual({ setting: 'pluggedIn', active: true, onBattery: false });
    expect(model.checked).toBe(true);
    expect(model.line).toBe('Active');
    expect(model.kind).toBe('active');
  });

  it('follows host/status/changed: unplugged says "On battery: the Mac may sleep"', async () => {
    const { link, model } = await started();
    let renders = 0;
    model.subscribe(() => (renders += 1));
    link.notify('host/status/changed', { keepAwake: { setting: 'pluggedIn', active: false, onBattery: true } });
    expect(model.line).toBe('On battery: the Mac may sleep');
    expect(model.checked).toBe(true);
    expect(renders).toBe(1);
    // A status without the field (or a malformed one) changes nothing.
    link.notify('host/status/changed', { uptimeSeconds: 3 });
    link.notify('host/status/changed', { keepAwake: { setting: 'always', active: true, onBattery: false } });
    link.notify('host/status/changed', { keepAwake: null });
    expect(model.line).toBe('On battery: the Mac may sleep');
    expect(renders).toBe(1);
  });

  it('turning the switch off sends host/settings/update {keepAwake: "off"} and shows "Off"', async () => {
    const { link, model } = await started();
    link.hold = true;
    const done = model.set(false);
    expect(model.pending).toBe('off');
    expect(model.checked).toBe(false); // the switch moves at once
    // A second tap while the first is in flight is ignored.
    await model.set(true);
    link.finish();
    await done;
    expect(link.calls.filter((c) => c.method === 'host/settings/update')).toEqual([{ method: 'host/settings/update', params: { keepAwake: 'off' } }]);
    expect(model.pending).toBeUndefined();
    expect(model.line).toBe('Off');
    expect(model.checked).toBe(false);

    link.hold = false;
    await model.set(true);
    expect(link.calls.at(-1)).toEqual({ method: 'host/settings/update', params: { keepAwake: 'pluggedIn' } });
    expect(model.line).toBe('Active');
  });

  it('setting what is already set sends nothing; before the host answered there is nothing to set', async () => {
    const { link, model } = await started();
    await model.set(true);
    expect(link.calls).toHaveLength(1);
    const fresh = new KeepAwakeModel(new FakeLink());
    await fresh.set(false);
    expect(fresh.pending).toBeUndefined();
  });

  it('a failed change puts the switch back and says why', async () => {
    const { link, model } = await started();
    link.failUpdate = true;
    await model.set(false);
    expect(model.checked).toBe(true);
    expect(model.error).toBe(KEEP_AWAKE_FAILED);
    link.failUpdate = false;
    await model.set(false);
    expect(model.error).toBeUndefined();
    expect(model.line).toBe('Off');
  });

  it('a host that sends no keepAwake shows no section; a host/status that fails is asked again on the next stream', async () => {
    const old = new FakeLink();
    old.status = undefined;
    const { model } = await started(old);
    expect(model.status).toBeUndefined();
    expect(model.line).toBeUndefined();
    expect(model.kind).toBeUndefined();

    const link = new FakeLink();
    link.failStatus = true;
    const second = await started(link);
    expect(second.model.status).toBeUndefined();
    link.failStatus = false;
    link.status = { setting: 'off', active: false, onBattery: false };
    link.ready();
    await settle();
    expect(second.model.line).toBe('Off');
  });

  it('dispose stops listening, and a late answer is dropped', async () => {
    const { link, model } = await started();
    link.hold = true;
    const done = model.set(false);
    model.dispose();
    link.finish();
    await done;
    link.notify('host/status/changed', { keepAwake: { setting: 'pluggedIn', active: false, onBattery: true } });
    expect(link.notifications.get('host/status/changed')?.size).toBe(0);
    expect(link.readies.size).toBe(0);
    expect(model.line).toBe('Active');
  });
});
