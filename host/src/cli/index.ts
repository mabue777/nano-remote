// The nano-host command line: config file, control channel, launchd job, and the running service.
export { parseArgs, USAGE, UsageError } from './args.js';
export type { Command } from './args.js';
export { EXIT_FAILURE, EXIT_NOT_RUNNING, EXIT_OK, EXIT_USAGE, defaultEnv, formatDevices, formatPairing, formatStatus, runCli } from './commands.js';
export type { CliEnv } from './commands.js';
export { ConfigError, DEFAULT_HOST_PORT, KNOWN_AGENTS, defaultConfig, loadConfig, validateConfig, writeConfig } from './config.js';
export type { AgentId, HostConfig, LoadedConfig } from './config.js';
export { CONTROL_SECRET_HEADER, ControlRequestError, ControlServer, HostNotRunning, controlRequest, ensureControlSecret } from './control.js';
export type { ControlHandlers, ControlStatus } from './control.js';
export { JOB_PATH, LAUNCHCTL, install, isLoaded, renderPlist, uninstall } from './launchd.js';
export type { PlistOptions, Run } from './launchd.js';
export { REDACTED_FIELD, createLogger, formatLine, redact } from './log.js';
export type { LogFields, LogLevel, Logger } from './log.js';
export * from './paths.js';
export { encodeQr, renderQr } from './qr.js';
export type { EccLevel, QrMatrix } from './qr.js';
export { DEFAULT_DRAIN_MS, HostService, listenPlan, shortHostname } from './service.js';
export type { ServiceOptions } from './service.js';
export { HOST_VERSION } from './version.js';
