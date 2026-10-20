import { describe, expect, it } from 'vitest';

import {
  BindRefused,
  DEFAULT_TAILSCALE_CLI,
  checkBindAddresses,
  isLoopback,
  isTailnet,
  parseTailscaleStatus,
  resolveTailnet,
} from './index.js';

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
    expect(() => parseTailscaleStatus('not json')).toThrow(/not JSON/);
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

  it('reports a CLI failure', async () => {
    await expect(resolveTailnet('/nonexistent/tailscale')).rejects.toThrow();
  });
});
