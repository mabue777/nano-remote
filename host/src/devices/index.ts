// Paired devices (protocol-v1.md section 8): the device store and the device methods on the stream.
export {
  CLIENT_ID_PREFIX,
  DEVICE_TOKEN_BYTES,
  DeviceStore,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLATFORM_LENGTH,
  MAX_USER_AGENT_LENGTH,
  TOKEN_HASH_ALGORITHM,
  clip,
  hashToken,
  newClientId,
  newDeviceToken,
} from './store.js';
export type { DeviceRecord, DeviceStoreOptions, NewDevice } from './store.js';
export { registerDeviceMethods } from './methods.js';
export type { DeviceMethodsOptions } from './methods.js';
