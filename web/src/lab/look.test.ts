import { describe, expect, it } from 'vitest';

import { SESSIONS } from './fixtures';
import { ALL_HOSTS, hostsOf, indicatorOf, loadLook, LOOK_KEY, onHost, previousMessages, saveLook, workedFor } from './look';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('look switch', () => {
  it('defaults to Now, round-trips New, and treats anything else as Now', () => {
    const storage = new MemoryStorage();
    expect(loadLook(storage)).toBe('now');
    saveLook(storage, 'new');
    expect(storage.getItem(LOOK_KEY)).toBe('new');
    expect(loadLook(storage)).toBe('new');
    saveLook(storage, 'now');
    expect(loadLook(storage)).toBe('now');
    storage.setItem(LOOK_KEY, 'fancy');
    expect(loadLook(storage)).toBe('now');
    expect(loadLook(null)).toBe('now');
    expect(() => saveLook(null, 'new')).not.toThrow();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => undefined,
    };
    expect(loadLook(broken)).toBe('now');
    expect(() => saveLook(broken, 'new')).not.toThrow();
  });
});

describe('new look wording', () => {
  it('says how long a turn worked in seconds, minutes or hours', () => {
    expect(workedFor(-5)).toBe('Worked for 0s');
    expect(workedFor(12_400)).toBe('Worked for 12s');
    expect(workedFor(59_600)).toBe('Worked for 1m 0s');
    expect(workedFor(192_000)).toBe('Worked for 3m 12s');
    expect(workedFor(8_000, 'Stopped after')).toBe('Stopped after 8s');
    expect(workedFor((3 * 60 + 42) * 60_000 + 20_000)).toBe('Worked for 3h 42m');
  });

  it('counts previous messages', () => {
    expect(previousMessages(1)).toBe('1 previous message');
    expect(previousMessages(3)).toBe('3 previous messages');
  });
});

describe('session row indicator', () => {
  it('shows one indicator per state', () => {
    expect(indicatorOf({ tone: 'busy', status: 'Working' })).toEqual({ kind: 'spinner', label: 'Working' });
    expect(indicatorOf({ tone: 'attention', status: 'Needs approval' })).toEqual({ kind: 'needs', label: 'Needs approval' });
    expect(indicatorOf({ tone: 'attention', status: 'Needs your input' })).toEqual({ kind: 'needs', label: 'Needs your answer' });
    expect(indicatorOf({ tone: 'error', status: 'Failed' }).kind).toBe('failed');
    expect(indicatorOf({ tone: 'ok', status: 'Finished' }).kind).toBe('none');
    expect(indicatorOf({ tone: 'muted', status: 'Idle' })).toEqual({ kind: 'none', label: 'Idle' });
  });
});

describe('host chips', () => {
  it('lists every host once after All and filters by it', () => {
    const hosts = hostsOf(SESSIONS);
    expect(hosts[0]).toBe(ALL_HOSTS);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts.length).toBeGreaterThan(2);
    expect(onHost(SESSIONS, ALL_HOSTS, (s) => s.host)).toEqual([...SESSIONS]);
    const one = onHost(SESSIONS, hosts[1]!, (s) => s.host);
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((s) => s.host === hosts[1])).toBe(true);
    expect(onHost(SESSIONS, 'nowhere', (s) => s.host)).toEqual([]);
  });
});
