export type * as protocol from './generated/index';

/** Protocol major version this client speaks (protocol/protocol-v1.md). */
export const PROTOCOL_VERSION = 1;

export function appTitle(): string {
  return 'Nano Remote';
}
