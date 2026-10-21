// Where the host may listen (protocol-v1.md section 1, ADR 0001): only this Mac's tailnet addresses,
// never a wildcard. Tests and development use loopback. Plain HTTP is allowed only on loopback and only
// with an explicit insecureDev flag.
//
// The addresses come from the Tailscale CLI (`tailscale status --json`, field Self.TailscaleIPs); the
// same call gives the MagicDNS name the QR URL uses (Self.DNSName). The resolver is injectable.
import { execFile } from 'node:child_process';
import { BlockList, isIP } from 'node:net';

/** Tailscale's CGNAT IPv4 range and its IPv6 ULA prefix: the only non-loopback addresses allowed. Security-pass seam. */
export const TAILNET_RANGES: readonly { network: string; prefix: number; type: 'ipv4' | 'ipv6' }[] = [
  { network: '100.64.0.0', prefix: 10, type: 'ipv4' },
  { network: 'fd7a:115c:a1e0::', prefix: 48, type: 'ipv6' },
];

/** Loopback ranges: allowed for tests and development, and the only ones allowed without TLS. */
export const LOOPBACK_RANGES: readonly { network: string; prefix: number; type: 'ipv4' | 'ipv6' }[] = [
  { network: '127.0.0.0', prefix: 8, type: 'ipv4' },
  { network: '::1', prefix: 128, type: 'ipv6' },
];

/** The Tailscale CLI inside the Mac app (the App Store and standalone builds both ship it here). */
export const DEFAULT_TAILSCALE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * The environment for every Tailscale CLI call. The Mac app binary picks CLI or GUI mode from how it is
 * launched: without a terminal (under launchd) it tries to start the GUI and prints an error with exit 0.
 * TAILSCALE_BE_CLI=1 forces CLI mode.
 */
export function tailscaleEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, TAILSCALE_BE_CLI: '1' };
}

function blockList(ranges: typeof TAILNET_RANGES): BlockList {
  const list = new BlockList();
  for (const range of ranges) list.addSubnet(range.network, range.prefix, range.type);
  return list;
}

const TAILNET = blockList(TAILNET_RANGES);
const LOOPBACK = blockList(LOOPBACK_RANGES);

function family(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

export function isLoopback(address: string): boolean {
  const type = family(address);
  return type !== null && LOOPBACK.check(address, type);
}

export function isTailnet(address: string): boolean {
  const type = family(address);
  return type !== null && TAILNET.check(address, type);
}

export class BindRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindRefused';
  }
}

export interface BindPolicy {
  /** True when the server has a TLS certificate and key. */
  tls: boolean;
  /** Allows plain HTTP; only on loopback. */
  insecureDev?: boolean;
}

/**
 * Throws BindRefused unless every address is a literal tailnet or loopback IP. Wildcards (`0.0.0.0`,
 * `::`), hostnames and other interfaces are refused; without TLS, so is anything but loopback, and only
 * with `insecureDev`. Returns the addresses.
 */
export function checkBindAddresses(addresses: readonly string[], policy: BindPolicy): readonly string[] {
  if (addresses.length === 0) throw new BindRefused('no listen address: is Tailscale running and logged in?');
  for (const address of addresses) {
    if (family(address) === null) throw new BindRefused(`listen address ${JSON.stringify(address)} is not an IP address`);
    if (!isTailnet(address) && !isLoopback(address)) {
      throw new BindRefused(`refusing to listen on ${address}: only tailnet or loopback addresses are allowed, never a wildcard`);
    }
  }
  if (!policy.tls) {
    if (!policy.insecureDev) throw new BindRefused('refusing plain HTTP: no TLS certificate, and insecureDev is not set');
    const outside = addresses.find((address) => !isLoopback(address));
    if (outside !== undefined) throw new BindRefused(`refusing plain HTTP on ${outside}: insecureDev is loopback only`);
  }
  return addresses;
}

/** This Mac on the tailnet. */
export interface TailnetSelf {
  /** MagicDNS name without the trailing dot, e.g. `mabue-mbp.tail1234.ts.net`. */
  dnsName: string;
  addresses: string[];
}

/** Parses `tailscale status --json`. Throws when Tailscale is not running or reports no addresses. */
export function parseTailscaleStatus(text: string): TailnetSelf {
  let status: { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  try {
    status = JSON.parse(text) as typeof status;
  } catch {
    const excerpt = text.trim().slice(0, 200);
    throw new Error(`tailscale status: output is not JSON: ${JSON.stringify(excerpt)}`);
  }
  if (status.BackendState !== 'Running') {
    throw new Error(`tailscale is not running (state ${JSON.stringify(status.BackendState ?? null)})`);
  }
  const self = status.Self ?? {};
  const addresses = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((a): a is string => typeof a === 'string' && isTailnet(a))
    : [];
  if (addresses.length === 0) throw new Error('tailscale status: this device has no tailnet address');
  if (typeof self.DNSName !== 'string' || self.DNSName.length === 0) throw new Error('tailscale status: no MagicDNS name');
  return { dnsName: self.DNSName.replace(/\.$/, ''), addresses };
}

export type RunCommand = (binary: string, args: string[]) => Promise<string>;

const runCommand: RunCommand = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { env: tailscaleEnv(), timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** Asks the Tailscale CLI for this Mac's tailnet name and addresses. */
export async function resolveTailnet(binary = DEFAULT_TAILSCALE_CLI, run: RunCommand = runCommand): Promise<TailnetSelf> {
  return parseTailscaleStatus(await run(binary, ['status', '--json']));
}
