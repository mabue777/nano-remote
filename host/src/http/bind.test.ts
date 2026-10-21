import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BindRefused,
  DEFAULT_TAILSCALE_CLI,
  checkBindAddresses,
  isLoopback,
  isTailnet,
  parseTailscaleStatus,
  resolveTailnet,
  tailscaleEnv,
} from './index.js';

/** What the Mac app binary prints, with exit 0, when launched without a terminal and without TAILSCALE_BE_CLI. */
const GUI_FAILURE = "The Tailscale GUI failed to start: The operation couldn't be completed. (Tailscale.CLIError error 3.)";

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'mabue-mbp.tail1234.ts.net.', TailscaleIPs: ['100.88.1.2', 'fd7a:115c:a1e0::1', 7] },
});

describe('bind check', () => {
  it('refuses wildcards, hostnames and non-tailnet interfaces', () => {
    for (const address of ['0.0.0.0', '::', '::0', '192.168.1.10', '10.0.0.1', '100.128.0.1', 'fd00::1', 'localhost', '']) {
      expect(() => checkBindAddresses([address], { tls: true })).toThrow(BindRefused);
    }
    expect(() => checkBindAddresses(['100.88.1.2', '0.0.0.0'], { tls: true })).toThrow(/0\.0\.0\.0/);
    expect(() => checkBindAddresses([], { tls: true })).toThrow(/no listen address/);
  });

  it('accepts tailnet and loopback addresses with TLS', () => {
    expect(checkBindAddresses(['100.88.1.2', 'fd7a:115c:a1e0::f739:b97c'], { tls: true })).toHaveLength(2);
    expect(checkBindAddresses(['127.0.0.1', '::1'], { tls: true })).toHaveLength(2);
  });

  it('allows plain HTTP only on loopback with insecureDev', () => {
    expect(() => checkBindAddresses(['127.0.0.1'], { tls: false })).toThrow(/insecureDev is not set/);
    expect(() => checkBindAddresses(['100.88.1.2'], { tls: false, insecureDev: true })).toThrow(/loopback only/);
    expect(checkBindAddresses(['127.0.0.1'], { tls: false, insecureDev: true })).toEqual(['127.0.0.1']);
  });

  it('classifies addresses', () => {
    expect(isTailnet('100.64.0.1')).toBe(true);
    expect(isTailnet('100.127.255.255')).toBe(true);
    expect(isTailnet('100.63.255.255')).toBe(false);
    expect(isTailnet('nope')).toBe(false);
    expect(isLoopback('127.0.0.2')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::2')).toBe(false);
    expect(isLoopback('host')).toBe(false);
  });
});

describe('tailnet resolution', () => {
  it('parses tailscale status --json', () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({
      dnsName: 'mabue-mbp.tail1234.ts.net',
      addresses: ['100.88.1.2', 'fd7a:115c:a1e0::1'],
    });
  });

  it('refuses a stopped, addressless or nameless tailnet', () => {
    expect(() => parseTailscaleStatus('not json')).toThrow(/not JSON: "not json"/);
    expect(() => parseTailscaleStatus('{"BackendState":"Stopped"}')).toThrow(/not running.*Stopped/);
    expect(() => parseTailscaleStatus('{}')).toThrow(/not running \(state null\)/);
    expect(() => parseTailscaleStatus('{"BackendState":"Running"}')).toThrow(/no tailnet address/);
    expect(() => parseTailscaleStatus('{"BackendState":"Running","Self":{"TailscaleIPs":"x"}}')).toThrow(/no tailnet address/);
    expect(() =>
      parseTailscaleStatus('{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.9"]}}'),
    ).toThrow(/no MagicDNS name/);
  });

  it('runs the Tailscale CLI', async () => {
    const calls: string[][] = [];
    const self = await resolveTailnet('/bin/tailscale', async (binary, args) => {
      calls.push([binary, ...args]);
      return STATUS;
    });
    expect(calls).toEqual([['/bin/tailscale', 'status', '--json']]);
    expect(self.addresses).toEqual(['100.88.1.2', 'fd7a:115c:a1e0::1']);
    expect(DEFAULT_TAILSCALE_CLI).toMatch(/Tailscale\.app/);
  });

  it('puts an excerpt of non-JSON output into the error, so host.log shows why', () => {
    expect(() => parseTailscaleStatus(`${GUI_FAILURE}\n`)).toThrow(`tailscale status: output is not JSON: ${JSON.stringify(GUI_FAILURE)}`);
    const long = 'x'.repeat(500);
    expect(() => parseTailscaleStatus(long)).toThrow(`output is not JSON: "${'x'.repeat(200)}"`);
  });

  it('forces CLI mode with TAILSCALE_BE_CLI=1, keeping the rest of the environment', () => {
    expect(tailscaleEnv({ PATH: '/bin', TAILSCALE_BE_CLI: '0' })).toEqual({ PATH: '/bin', TAILSCALE_BE_CLI: '1' });
    expect(tailscaleEnv().TAILSCALE_BE_CLI).toBe('1');
    expect(tailscaleEnv().PATH).toBe(process.env.PATH);
  });

  it('the default runner sets TAILSCALE_BE_CLI=1 on the Tailscale process', async () => {
    // A stand-in binary that behaves like the Mac app: GUI failure unless TAILSCALE_BE_CLI=1.
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-tailscale-'));
    try {
      const fake = path.join(dir, 'Tailscale');
      writeFileSync(
        fake,
        `#!/bin/sh\nif [ "$TAILSCALE_BE_CLI" = 1 ] && [ "$1 $2" = "status --json" ]; then printf '%s' '${STATUS}'; else echo "${GUI_FAILURE}"; fi\n`,
      );
      chmodSync(fake, 0o755);
      const self = await resolveTailnet(fake);
      expect(self).toEqual({ dnsName: 'mabue-mbp.tail1234.ts.net', addresses: ['100.88.1.2', 'fd7a:115c:a1e0::1'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a CLI failure', async () => {
    await expect(resolveTailnet('/nonexistent/tailscale')).rejects.toThrow();
  });
});
