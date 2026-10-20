import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, appTitle } from './version';

describe('web scaffold', () => {
  it('speaks protocol v1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('has the app title the smoke test looks for', () => {
    expect(appTitle()).toBe('Nano Remote');
  });
});
