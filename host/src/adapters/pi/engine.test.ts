// The pi process wrapper: LF-only framing, command correlation, failures and supervision.
import { describe, expect, it } from 'vitest';

import { piConfig } from '../../config/pi.js';
import { LineSplitter, PiEngine } from './engine.js';
import { fakePi, until } from './testing/fake-pi-config.js';

describe('LineSplitter', () => {
  it('splits on LF only, keeps U+2028 and U+2029 inside records, drops a CR before the LF', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter();
    splitter.push('{"a":"x y z"}\r\n{"b"', (l) => lines.push(l));
    splitter.push(Buffer.from(':1}\n'), (l) => lines.push(l));
    // A multi-byte character cut between two chunks.
    const euro = Buffer.from('"€"\n');
    splitter.push(euro.subarray(0, 2), (l) => lines.push(l));
    splitter.push(euro.subarray(2), (l) => lines.push(l));
    expect(lines).toEqual(['{"a":"x y z"}', '{"b":1}', '"€"']);
  });
});

describe('PiEngine', () => {
  const quiet = { onEvent: () => {}, onUiRequest: () => {}, onExit: () => {} };

  it('correlates responses by id and rejects failed commands with pi error', async () => {
    const fake = fakePi({ fail: { compact: 'nothing to compact' } });
    const engine = new PiEngine(fake.config, quiet);
    engine.start(['--no-session'], fake.cwd);
    const [state, models] = await Promise.all([engine.call('get_state'), engine.call('get_available_models')]);
    expect(state).toMatchObject({ model: { provider: 'llamacpp', id: 'bonsai-27b' } });
    expect((models as { models: unknown[] }).models).toHaveLength(2);
    await expect(engine.call('compact')).rejects.toThrow('compact failed: nothing to compact');
    expect(engine.alive).toBe(true);
    await engine.kill();
    expect(engine.alive).toBe(false);
    await expect(engine.call('get_state')).rejects.toMatchObject({ code: 'agent_unavailable' });
    // Answers after the end go nowhere.
    engine.respondUi('x', { confirmed: true });
  });

  it('a command pi never answers times out as agent_unavailable', async () => {
    const fake = fakePi({ ignore: ['get_state'] }, { requestTimeoutMs: 100 });
    const logs: string[] = [];
    const engine = new PiEngine(fake.config, { ...quiet, log: (m) => logs.push(m) });
    engine.start([], fake.cwd);
    await expect(engine.call('get_state')).rejects.toThrow(/get_state timed out after 100 ms/);
    await engine.kill();
  });

  it('a command pi does not know rejects with pi error', async () => {
    const fake = fakePi();
    const engine = new PiEngine(fake.config, quiet);
    engine.start([], fake.cwd);
    await expect(engine.call('nonsense')).rejects.toThrow('nonsense failed: Unknown command: nonsense');
    await engine.kill();
  });

  it('a program that cannot run reports the loss once', async () => {
    const reasons: string[] = [];
    const engine = new PiEngine(piConfig({ binary: '/nonexistent/pi' }, {}), { ...quiet, onExit: (r) => reasons.push(r) });
    engine.start([], '/');
    await expect(engine.call('get_state')).rejects.toMatchObject({ code: 'agent_unavailable' });
    await until(() => (reasons.length > 0 ? true : undefined), 'onExit');
    expect(reasons).toEqual([expect.stringMatching(/^cannot run \/nonexistent\/pi: .*ENOENT/)]);
    await engine.kill();
  });

  it('NANO_PI_TRACE=1 logs record types, never content', async () => {
    const fake = fakePi();
    const logs: string[] = [];
    const engine = new PiEngine(fake.config, { ...quiet, log: (m) => logs.push(m) });
    process.env.NANO_PI_TRACE = '1';
    try {
      engine.start([], fake.cwd);
      await engine.call('get_state');
    } finally {
      delete process.env.NANO_PI_TRACE;
      await engine.kill();
    }
    expect(logs).toContain('pi record response');
  });

  it('kill on an engine that never started does nothing', async () => {
    await new PiEngine(piConfig({}, {}), quiet).kill();
  });
});
