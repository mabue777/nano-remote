// The protocol error type (spec 10). Handlers, the core and adapters throw it; the stream connection
// turns it into an error response. Kept apart from the transport so nothing outside src/stream needs to
// import the stream layer to report an error.
import type * as envelope from './generated/envelope.js';

export type ErrorCode = envelope.Error['code'];
export type ErrorBody = envelope.Error;

/** A protocol error (spec 10). Handlers throw it; the connection turns it into an error response. */
export class RpcError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  /** `invalid_params` always carries `data.path` (spec 10). */
  static invalidParams(path: string, message: string): RpcError {
    return new RpcError('invalid_params', message, { path });
  }

  toBody(): ErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
