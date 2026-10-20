// Protocol ids minted by the host: `ses_` sessions, `trn_` turns, `itm_` items the host creates itself
// (user messages). Time-ordered (a base36 millisecond prefix) plus 64 random bits, so ids sort roughly by
// creation and never collide in practice.
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'ses' | 'trn' | 'itm' | 'req';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${Date.now().toString(36).padStart(9, '0')}${randomBytes(8).toString('hex')}`;
}
