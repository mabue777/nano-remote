// Pairing (protocol-v1.md section 8): short-lived single-use codes that turn into device tokens.
export {
  MAX_OUTSTANDING_CODES,
  PAIRING_CODE_DIGITS,
  PAIRING_CODE_LIFETIME_MS,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_MAX_FAILURES,
  PAIR_PATH,
  PairingCodes,
  pairingUrl,
  randomCode,
} from './codes.js';
export type { IssuedCode, PairingCodesOptions, RedeemResult } from './codes.js';
export {
  DEVICE_COOKIE_ATTRIBUTES,
  MAX_PAIR_BODY_BYTES,
  PAIR_ENDPOINT,
  deviceCookie,
  handlePair,
  parsePairRequest,
} from './endpoint.js';
export type { PairEndpointOptions, PairRequest, PairResponse } from './endpoint.js';
