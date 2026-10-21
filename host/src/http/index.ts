// The host's HTTPS origin (protocol-v1.md sections 1 and 8): web app, pairing endpoint, stream upgrade.
export {
  BindRefused,
  DEFAULT_TAILSCALE_CLI,
  LOOPBACK_RANGES,
  TAILNET_RANGES,
  checkBindAddresses,
  isLoopback,
  isTailnet,
  parseTailscaleStatus,
  resolveTailnet,
  tailscaleEnv,
} from './bind.js';
export type { BindPolicy, RunCommand, TailnetSelf } from './bind.js';
export {
  DEFAULT_PORT,
  HostServer,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
  defaultConfigDir,
  tlsFilesIn,
} from './server.js';
export type { HostServerOptions, TlsFiles } from './server.js';
export { CLIENT_ROUTES, PUBLIC_DIR, SECURITY_HEADERS, contentTypeFor, resolveStatic, serveStatic } from './static.js';
