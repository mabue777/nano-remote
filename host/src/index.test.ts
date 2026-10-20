import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, PUBLIC_DIR, contentTypeFor } from './index.js';

describe('host scaffold', () => {
  it('speaks protocol v1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('serves the web client from host/public', () => {
    expect(path.basename(PUBLIC_DIR)).toBe('public');
    expect(path.basename(path.dirname(PUBLIC_DIR))).toBe('host');
  });

  it('maps static file extensions to content types', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('assets/app-abc123.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('ICON.PNG')).toBe('image/png');
    expect(contentTypeFor('unknown.bin')).toBe('application/octet-stream');
  });
});
