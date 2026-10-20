// The running service end to end on loopback: config -> HostService -> control channel -> pairing ->
// stream -> graceful shutdown. Also the bin's commands through runCli with an injected environment.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeAgent } from '../core/testing/fake-adapter.js';
import { text, waitEvent } from '../core/testing/harness.js';
import { Journal } from '../journal/journal.js';
import { CloseCode } from '../stream/constants.js';
import { TestClient } from '../stream/testing/client.js';
import { EXIT_FAILURE, EXIT_NOT_RUNNING, EXIT_OK, EXIT_USAGE, runCli, stableNodePath, type CliEnv } from './commands.js';
import { defaultConfig, type HostConfig } from './config.js';
import { controlRequest } from './control.js';
import { createLogger } from './log.js';
import { controlSecretPath, controlSocketPath } from './paths.js';
import { HostService, listenPlan, shortHostname } from './service.js';
import { HOST_VERSION } from './version.js';

let home: string;
let services: HostService[] = [];
let clients: TestClient[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nano-svc-'));
});

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  for (const service of services) await service.shutdown('test');
  services = [];
  rmSync(home, { recursive: true, force: true });
});

function testConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    ...defaultConfig(home, 'host_test'),
    listenAddresses: ['127.0.0.1'],
    port: 0,
    journalPath: path.join(home, 'journal.sqlite'),
    logFile: path.join(home, 'logs', 'host.log'),
    ...overrides,
  };
}

interface Started {
  service: HostService;
  lines: Record<string, unknown>[];
  configPath: string;
  target: { socketPath: string; secretPath: string };
}

async function startService(options: { drainMs?: number } = {}): Promise<Started> {
  const config = testConfig();
  const configPath = path.join(home, 'config.json');
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ file: config.logFile, stdout: { write: (t: string) => lines.push(JSON.parse(t)) } });
  const service = await HostService.start({
    config,
    configPath,
    logger,
    insecureDev: true,
    agents: [new FakeAgent()],
    publicDir: home,
    drainMs: options.drainMs ?? 0,
  });
  services.push(service);
  return { service, lines, configPath, target: { socketPath: controlSocketPath(configPath), secretPath: controlSecretPath(configPath) } };
}

async function pairDevice(started: Started, name = 'iPhone'): Promise<{ clientId: string; deviceToken: string }> {
  const { code } = await controlRequest<{ code: string }>(started.target, 'POST', '/v1/pair');
  const response = await fetch(`http://127.0.0.1:${started.service.server.port}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, client: { name, platform: 'ios-web' } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { clientId: string; deviceToken: string };
}

async function connect(started: Started, device: { clientId: string; deviceToken: string }): Promise<TestClient> {
  const client = await TestClient.connect(`ws://127.0.0.1:${started.service.server.port}/v1/stream`, {
    token: device.deviceToken,
    clientId: device.clientId,
  });
  clients.push(client);
  return client;
}

describe('listen plan', () => {
  const tailnet = async () => ({ dnsName: 'mac.tail1.ts.net', addresses: ['100.64.0.7'] });

  it('asks Tailscale when no addresses are configured', async () => {
    expect(await listenPlan(testConfig({ listenAddresses: [] }), false, tailnet)()).toEqual({
      dnsName: 'mac.tail1.ts.net',
      addresses: ['100.64.0.7'],
    });
  });

  it('uses 127.0.0.1 in insecure-dev and explicit loopback without Tailscale', async () => {
    const never = () => Promise.reject(new Error('no tailscale'));
    expect(await listenPlan(testConfig({ listenAddresses: [] }), true, never)()).toEqual({ dnsName: '127.0.0.1', addresses: ['127.0.0.1'] });
    expect(await listenPlan(testConfig({ listenAddresses: ['::1'] }), false, never)()).toEqual({ dnsName: '::1', addresses: ['::1'] });
  });

  it('keeps configured tailnet addresses but takes the MagicDNS name from Tailscale', async () => {
    expect(await listenPlan(testConfig({ listenAddresses: ['100.64.0.9'] }), false, tailnet)()).toEqual({
      dnsName: 'mac.tail1.ts.net',
      addresses: ['100.64.0.9'],
    });
  });

  it('shortens the Mac name', () => {
    expect(shortHostname('mabue-mbp.local')).toBe('mabue-mbp');
    expect(shortHostname('mabue-mbp.tail1.ts.net')).toBe('mabue-mbp');
    expect(shortHostname('')).toBe('mac');
  });
});

describe('host service', () => {
  it('logs the start line, pairs a device through the control channel, and answers initialize', async () => {
    const started = await startService();
    expect(started.lines[0]).toMatchObject({ level: 'info', event: 'host.start', version: HOST_VERSION, hostId: 'host_test' });
    expect(started.lines[1]).toMatchObject({ event: 'host.listening', addresses: ['127.0.0.1'] });
    expect(readFileSync(path.join(home, 'logs', 'host.log'), 'utf8')).toContain('"event":"host.start"');

    const device = await pairDevice(started);
    const client = await connect(started, device);
    const init = (await client.handshake()).result as Record<string, unknown>;
    expect(init).toMatchObject({
      protocolVersion: 1,
      host: { hostId: 'host_test', version: HOST_VERSION, os: process.platform },
      device: { clientId: device.clientId, displayName: 'iPhone' },
      agents: [{ id: 'fake', status: 'ready' }],
      limits: { maxMessageBytes: 16 * 1024 * 1024, snapshotTurns: 5 },
    });

    const status = await controlRequest<Record<string, unknown>>(started.target, 'GET', '/v1/status');
    expect(status).toMatchObject({ state: 'running', pid: process.pid, hostId: 'host_test', devices: 1, streams: 1 });

    // Neither the pairing code nor the device token reaches the log.
    const log = readFileSync(path.join(home, 'logs', 'host.log'), 'utf8');
    expect(log).not.toContain(device.deviceToken);
    expect(log).toMatch(/"event":"control.pair"/);
  });

  it('revoking through the control channel closes the device stream with 4003', async () => {
    const started = await startService();
    const device = await pairDevice(started);
    const client = await connect(started, device);
    await client.handshake();
    await controlRequest(started.target, 'POST', '/v1/devices/rename', { clientId: device.clientId, displayName: '  Work phone ' });
    expect(started.service.devices.get(device.clientId)?.displayName).toBe('Work phone');
    await expect(
      controlRequest(started.target, 'POST', '/v1/devices/rename', { clientId: device.clientId, displayName: '   ' }),
    ).rejects.toThrow(/1 to 100 characters/);
    await controlRequest(started.target, 'POST', '/v1/devices/revoke', { clientId: device.clientId });
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(await controlRequest(started.target, 'GET', '/v1/devices')).toEqual({ devices: [] });
  });

  it('security: no token, code, cookie or session content in the log; private files; VAPID key in initialize', async () => {
    const started = await startService();
    const origin = started.service.server.origin;
    // Wrong codes, then the real one: none of them may reach the log.
    const wrong = await fetch(`${origin}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '13572468', client: { name: 'x', platform: 'ios-web' } }),
    });
    expect(wrong.status).toBe(403);
    const { code } = await controlRequest<{ code: string }>(started.target, 'POST', '/v1/pair');
    const response = await fetch(`${origin}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client: { name: 'iPhone', platform: 'ios-web' } }),
    });
    const device = (await response.json()) as { clientId: string; deviceToken: string };
    const cookie = response.headers.get('set-cookie')!;

    // The browser path: the host's own origin and the cookie.
    const client = await TestClient.connect(`ws://127.0.0.1:${started.service.server.port}/v1/stream`, {
      token: null,
      cookie: cookie.split(';')[0]!,
      clientId: device.clientId,
      headers: { origin },
    });
    clients.push(client);
    const init = (await client.handshake()).result as { push: { vapidPublicKey: string; subscribed: boolean } };
    const vapidFile = path.join(home, 'vapid.json');
    expect(init.push).toEqual({ vapidPublicKey: JSON.parse(readFileSync(vapidFile, 'utf8')).publicKey, subscribed: false });
    expect(Buffer.from(init.push.vapidPublicKey, 'base64url')).toHaveLength(65);

    const secretText = 'SESSION-CONTENT-7f3a';
    const { session } = (await client.call('session/start', { agentId: 'fake', cwd: home })).result as { session: { sessionId: string } };
    await client.call('session/open', { sessionId: session.sessionId });
    await client.call('turn/start', { sessionId: session.sessionId, input: text(secretText), clientMessageId: randomUUID() });
    await waitEvent(client, 'turn/completed');
    expect(JSON.stringify(client.messages)).toContain(secretText); // the content did flow through the host

    await controlRequest(started.target, 'POST', '/v1/devices/revoke', { clientId: device.clientId });
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    const retry = await TestClient.connect(`ws://127.0.0.1:${started.service.server.port}/v1/stream`, {
      token: device.deviceToken,
      clientId: device.clientId,
    });
    clients.push(retry);
    expect(await retry.closed).toMatchObject({ code: CloseCode.unauthorized });

    const logFile = path.join(home, 'logs', 'host.log');
    const log = readFileSync(logFile, 'utf8');
    const stdout = JSON.stringify(started.lines);
    for (const secret of [device.deviceToken, code, '13572468', secretText, readFileSync(started.target.secretPath, 'utf8').trim()]) {
      expect(log).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
    expect(log).toContain('"event":"control.device.revoke"');

    // Item 5: the folder 0700, every secret-bearing file 0600.
    const mode = (file: string) => statSync(file).mode & 0o777;
    expect(mode(home)).toBe(0o700);
    for (const file of [started.target.secretPath, vapidFile, path.join(home, 'journal.sqlite'), logFile]) {
      expect(mode(file)).toBe(0o600);
    }
    expect(mode(started.target.socketPath)).toBe(0o600);
  });

  it('shuts down gracefully: pongs say draining, streams close with 4010, the Journal is flushed', async () => {
    const started = await startService({ drainMs: 300 });
    const { service } = started;
    const device = await pairDevice(started);
    const client = await connect(started, device);
    await client.handshake();
    const { session } = (await client.call('session/start', { agentId: 'fake', cwd: home })).result as { session: { sessionId: string } };

    const stopping = service.shutdown('SIGTERM');
    expect(service.shutdown('SIGTERM')).toBe(stopping);
    client.ping();
    const pong = await client.until(() => client.frames.find((f) => f.type === 'pong'), 'pong');
    expect(pong).toMatchObject({ status: 'draining' });
    expect(await controlRequest(started.target, 'GET', '/v1/status')).toMatchObject({ state: 'draining' });

    expect(await client.closed).toEqual({ code: CloseCode.draining, reason: 'host is shutting down' });
    await stopping;
    services = [];

    expect(started.lines.at(-1)).toMatchObject({ event: 'host.stopped', reason: 'SIGTERM' });
    const events = started.lines.map((l) => l.event);
    expect(events.indexOf('host.draining')).toBeLessThan(events.indexOf('host.streams_closed'));
    expect(events.indexOf('host.streams_closed')).toBeLessThan(events.indexOf('host.stopped'));
    expect(started.lines.find((l) => l.event === 'host.draining')).toMatchObject({ reason: 'SIGTERM', streams: 1 });

    // Journal and device store are closed; the control socket is gone; the data is on disk.
    expect(() => service.journal.summary(session.sessionId)).toThrow();
    expect(() => statSync(started.target.socketPath)).toThrow();
    const reopened = new Journal({ path: path.join(home, 'journal.sqlite') });
    try {
      expect(reopened.summary(session.sessionId)).toMatchObject({ sessionId: session.sessionId, agentId: 'fake' });
    } finally {
      reopened.close();
    }
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function cliEnv(overrides: Partial<CliEnv> = {}): CliEnv & { output: string[]; errors: string[]; logs: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    output,
    errors,
    logs,
    home,
    uid: 501,
    out: (t) => output.push(t),
    err: (t) => errors.push(t),
    logStream: { write: (t: string) => logs.push(t) },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    tailnet: async () => ({ dnsName: 'mac.tail1.ts.net', addresses: ['100.64.0.7'] }),
    nodePath: '/opt/homebrew/bin/node',
    binPath: '/repo/host/dist/cli/main.js',
    waitForStop: () => new Promise(() => {}),
    ...overrides,
  };
}

describe('nano-host commands', () => {
  it('start, status, pair, devices and the SIGTERM exit code, through runCli', async () => {
    const configPath = path.join(home, 'NanoHost', 'config.json');
    const port = await freePort();
    let stop: (signal: string) => void = () => {};
    let running: (() => void) | undefined;
    const isRunning = new Promise<void>((resolve) => (running = resolve));
    const env = cliEnv({
      waitForStop: () => {
        running!();
        return new Promise((resolve) => (stop = resolve));
      },
    });
    // First start writes the config; this one would listen on the tailnet, so give it loopback instead.
    writeFileSync(
      path.join(home, 'seed.json'),
      JSON.stringify({ listenAddresses: ['127.0.0.1'], port, journalPath: path.join(home, 'j.sqlite'), logFile: path.join(home, 'h.log'), codexBinary: '/nonexistent/codex' }),
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    copyFileSync(path.join(home, 'seed.json'), configPath);

    const exit = runCli(['start', '--insecure-dev', '--config', configPath], env);
    await isRunning;

    const status = cliEnv();
    expect(await runCli(['status', '--config', configPath], status)).toBe(EXIT_OK);
    expect(status.output.join('\n')).toMatch(/state: +running/);
    expect(status.output.join('\n')).toContain(`listening: 127.0.0.1 port ${port}`);
    expect(status.output.join('\n')).toMatch(/codex unavailable \(Codex is not installed at \/nonexistent\/codex\)/);
    expect(status.output.join('\n')).toContain('launchd:   not installed');

    const pair = cliEnv();
    expect(await runCli(['pair', '--config', configPath], pair)).toBe(EXIT_OK);
    const text = pair.output.join('\n');
    const code = /code: (\d{8})/.exec(text)?.[1];
    expect(code).toBeDefined();
    expect(text).toContain(`url:  http://127.0.0.1:${port}/pair#code=${code}`);
    expect(text).toMatch(/[█▀▄]/);

    const devices = cliEnv();
    expect(await runCli(['devices', 'list', '--config', configPath], devices)).toBe(EXIT_OK);
    expect(devices.output).toEqual(['no paired devices; pair one with `nano-host pair`']);

    const revoke = cliEnv();
    expect(await runCli(['devices', 'revoke', 'dev_nope', '--config', configPath], revoke)).toBe(EXIT_FAILURE);
    expect(revoke.errors).toEqual(['nano-host: no such device: dev_nope']);

    // The code never reaches the service's log lines.
    expect(env.logs.join('')).not.toContain(code!);
    expect(readFileSync(path.join(home, 'h.log'), 'utf8')).not.toContain(code!);
    expect(env.logs[0]).toContain('"event":"host.start"');

    stop('SIGTERM');
    expect(await exit).toBe(EXIT_OK);
    expect(env.logs.at(-1)).toContain('"event":"host.stopped"');

    const after = cliEnv();
    const afterCode = await runCli(['status', '--config', configPath], after);
    expect(after.errors).toEqual([]);
    expect(afterCode).toBe(EXIT_NOT_RUNNING);
    expect(after.output).toEqual(['not running']);
    expect(await runCli(['pair', '--config', configPath], after)).toBe(EXIT_NOT_RUNNING);
    expect(after.errors.at(-1)).toMatch(/the host is not running/);
  });

  it('start fails with exit 1 and a log line when it cannot listen', async () => {
    const configPath = path.join(home, 'c.json');
    writeFileSync(configPath, JSON.stringify({ listenAddresses: ['127.0.0.1'], journalPath: path.join(home, 'j.sqlite'), logFile: path.join(home, 'h.log') }));
    const env = cliEnv();
    // No --insecure-dev and no certificate: plain HTTP is refused.
    expect(await runCli(['start', '--config', configPath], env)).toBe(EXIT_FAILURE);
    expect(env.logs.at(-1)).toMatch(/"event":"host.start_failed".*(TLS certificate|plain HTTP)/);
  });

  it('start refuses an invalid config file', async () => {
    const configPath = path.join(home, 'c.json');
    writeFileSync(configPath, JSON.stringify({ port: 'x' }));
    const env = cliEnv();
    expect(await runCli(['start', '--config', configPath], env)).toBe(EXIT_FAILURE);
    expect(env.errors).toEqual([`nano-host: ${configPath}: port must be an integer from 1 to 65535`]);
  });

  it('install writes the default config and the plist, then loads it; uninstall removes it', async () => {
    const calls: string[][] = [];
    const env = cliEnv({
      run: async (binary, args) => {
        calls.push([binary, ...args]);
        return args[0] === 'print' ? { code: 113, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runCli(['install'], env)).toBe(EXIT_OK);
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'dev.nano-remote.host.plist');
    const plist = readFileSync(plistPath, 'utf8');
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>/repo/host/dist/cli/main.js</string>\n    <string>start</string>\n  </array>');
    expect(plist).toContain(`<string>${path.join(home, 'Library', 'Logs', 'NanoHost', 'stdout.log')}</string>`);
    expect(statSync(path.join(home, 'Library', 'Application Support', 'NanoHost', 'config.json')).mode & 0o777).toBe(0o600);
    expect(calls.at(-1)).toEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plistPath]);

    expect(await runCli(['uninstall'], env)).toBe(EXIT_OK);
    expect(env.output.at(-1)).toBe(`unloaded dev.nano-remote.host and removed ${plistPath}`);
  });

  it('install passes a non-default config path to start', async () => {
    const configPath = path.join(home, 'other', 'config.json');
    const env = cliEnv({ run: async (_b, args) => ({ code: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' }) });
    expect(await runCli(['install', '--config', configPath], env)).toBe(EXIT_OK);
    const plist = readFileSync(path.join(home, 'Library', 'LaunchAgents', 'dev.nano-remote.host.plist'), 'utf8');
    expect(plist).toContain(`<string>start</string>\n    <string>--config</string>\n    <string>${configPath}</string>`);
  });

  it('cert runs tailscale cert for the MagicDNS name into the config folder', async () => {
    const calls: string[][] = [];
    const env = cliEnv({
      run: async (binary, args) => {
        calls.push([binary, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runCli(['cert'], env)).toBe(EXIT_OK);
    const dir = path.join(home, 'Library', 'Application Support', 'NanoHost');
    expect(calls).toEqual([
      [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        'cert',
        '--cert-file',
        path.join(dir, 'tls-cert.pem'),
        '--key-file',
        path.join(dir, 'tls-key.pem'),
        'mac.tail1.ts.net',
      ],
    ]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const failing = cliEnv({ run: async () => ({ code: 1, stdout: '', stderr: 'your tailnet does not have HTTPS enabled' }) });
    expect(await runCli(['cert'], failing)).toBe(EXIT_FAILURE);
    expect(failing.errors[0]).toContain('your tailnet does not have HTTPS enabled');
  });

  it('prefers a stable node link over the versioned path it points to', () => {
    const real = path.join(home, 'Cellar', 'node', '26.5.0', 'bin', 'node');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, '');
    const link = path.join(home, 'bin-node');
    symlinkSync(real, link);
    expect(stableNodePath(real, [path.join(home, 'missing'), link])).toBe(link);
    expect(stableNodePath(real, [path.join(home, 'missing')])).toBe(real);
  });

  it('prints the version, the usage, and usage errors with exit 2', async () => {
    const env = cliEnv();
    expect(await runCli(['version'], env)).toBe(EXIT_OK);
    expect(env.output).toEqual([HOST_VERSION]);
    expect(await runCli(['help'], env)).toBe(EXIT_OK);
    expect(env.output[1]).toMatch(/^usage: nano-host/);
    expect(await runCli(['bogus'], env)).toBe(EXIT_USAGE);
    expect(env.errors[0]).toMatch(/unknown command "bogus"/);
  });
});
