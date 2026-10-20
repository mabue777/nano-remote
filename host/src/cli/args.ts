// Command-line parsing for nano-host. Pure: argv in, a Command or a UsageError out.
export type Command =
  | { name: 'start'; config?: string; insecureDev: boolean }
  | { name: 'status'; config?: string }
  | { name: 'pair'; config?: string }
  | { name: 'devices'; action: 'list'; config?: string }
  | { name: 'devices'; action: 'revoke'; clientId: string; config?: string }
  | { name: 'devices'; action: 'rename'; clientId: string; displayName: string; config?: string }
  | { name: 'cert'; config?: string }
  | { name: 'install'; config?: string }
  | { name: 'uninstall' }
  | { name: 'version' }
  | { name: 'help' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `usage: nano-host <command> [options]

commands:
  start [--config <path>] [--insecure-dev]   run the host in the foreground (launchd runs this)
  status [--config <path>]                   ask the running host how it is doing
  pair [--config <path>]                     show a pairing QR code, the code and the URL
  devices list [--config <path>]             list paired devices
  devices revoke <clientId>                  unpair a device and close its streams
  devices rename <clientId> <name>           change a device's display name
  cert [--config <path>]                     get the TLS certificate with \`tailscale cert\`
  install [--config <path>]                  install and load the launchd job
  uninstall                                  unload and remove the launchd job
  version                                    print the version

--config defaults to ~/Library/Application Support/NanoHost/config.json.
--insecure-dev serves plain HTTP on loopback addresses only; never use it on the tailnet.`;

/** Splits flags from positionals. `--config` takes a value (`--config x` or `--config=x`). */
function split(argv: readonly string[]): { positionals: string[]; config?: string; flags: Set<string> } {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let config: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length);
      if (value === undefined || value.length === 0) throw new UsageError('--config needs a path');
      if (config !== undefined) throw new UsageError('--config given twice');
      config = value;
    } else if (arg.startsWith('-') && arg !== '-') {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return config === undefined ? { positionals, flags } : { positionals, config, flags };
}

export function parseArgs(argv: readonly string[]): Command {
  const { positionals, config, flags } = split(argv);
  const [name, ...rest] = positionals;
  if (flags.has('--help') || flags.has('-h') || name === 'help') return { name: 'help' };
  if (flags.has('--version') || flags.has('-v')) return { name: 'version' };
  if (name === undefined) throw new UsageError('no command given');

  const allow = (...allowed: string[]) => {
    for (const flag of flags) if (!allowed.includes(flag)) throw new UsageError(`${name}: unknown option ${flag}`);
  };
  const noConfig = () => {
    if (config !== undefined) throw new UsageError(`${name}: --config is not accepted`);
  };
  const arity = (count: number, what: string) => {
    if (rest.length !== count) throw new UsageError(`${name}: expected ${what}`);
  };
  const withConfig = <T extends object>(command: T): T & { config?: string } =>
    config === undefined ? command : { ...command, config };

  switch (name) {
    case 'start':
      allow('--insecure-dev');
      arity(0, 'no arguments');
      return withConfig({ name: 'start' as const, insecureDev: flags.has('--insecure-dev') });
    case 'status':
    case 'pair':
    case 'cert':
    case 'install':
      allow();
      arity(0, 'no arguments');
      return withConfig({ name });
    case 'uninstall':
    case 'version':
      allow();
      noConfig();
      arity(0, 'no arguments');
      return { name };
    case 'devices': {
      allow();
      const [action, ...args] = rest;
      if (action === undefined || action === 'list') {
        if (args.length > 0) throw new UsageError('devices list: expected no arguments');
        return withConfig({ name: 'devices' as const, action: 'list' as const });
      }
      if (action === 'revoke') {
        if (args.length !== 1) throw new UsageError('devices revoke: expected <clientId>');
        return withConfig({ name: 'devices' as const, action: 'revoke' as const, clientId: args[0]! });
      }
      if (action === 'rename') {
        if (args.length < 2) throw new UsageError('devices rename: expected <clientId> <name>');
        // The name may be given unquoted: `devices rename dev_1 Work iPhone`.
        return withConfig({
          name: 'devices' as const,
          action: 'rename' as const,
          clientId: args[0]!,
          displayName: args.slice(1).join(' '),
        });
      }
      throw new UsageError(`devices: unknown action ${JSON.stringify(action)} (list, revoke, rename)`);
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(name)}`);
  }
}
