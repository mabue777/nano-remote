// Where nano-host keeps its files on this Mac. Every function takes the home folder so tests can point
// everything at a temporary directory.
import { homedir } from 'node:os';
import path from 'node:path';

/** launchd label of the host job, also the plist file name. */
export const LAUNCHD_LABEL = 'dev.nano-remote.host';

/** `~/Library/Application Support/NanoHost`: config, TLS files, control secret, Journal. */
export function configDir(home = homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'NanoHost');
}

export function defaultConfigPath(home = homedir()): string {
  return path.join(configDir(home), 'config.json');
}

/** `~/Library/Logs/NanoHost`: the host's log file and launchd's stdout and stderr files. */
export function logsDir(home = homedir()): string {
  return path.join(home, 'Library', 'Logs', 'NanoHost');
}

export function launchAgentPath(home = homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** The control channel lives next to the config file it belongs to. */
export function controlSocketPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'control.sock');
}

export function controlSecretPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'control.secret');
}
