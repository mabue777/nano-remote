import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { encodeQr, renderQr, type QrMatrix } from './qr.js';

const URL = 'https://mabue-mbp.tail1234.ts.net:7420/pair#code=12345678';

function fingerprint(matrix: QrMatrix): string {
  return createHash('sha256')
    .update(matrix.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join('\n'))
    .digest('hex');
}

function finderAt(matrix: QrMatrix, x0: number, y0: number): boolean {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (matrix.modules[y0 + y]![x0 + x] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe('QR encoder', () => {
  it('matches a symbol that macOS CoreImage decodes back to the pairing URL', () => {
    // Golden value: this exact matrix was rendered to PNG and decoded with CIDetector (CIDetectorTypeQRCode)
    // to the input string, along with a version 1, an 11 and a 15 symbol (multi-block, version info).
    const matrix = encodeQr(URL);
    expect(matrix.version).toBe(4);
    expect(matrix.size).toBe(33);
    expect(fingerprint(matrix)).toBe('f5a0c1ba2b59124fd18db65a18b2f7d0922e446ea85320991aedad5adaec8155');
  });

  it('draws the three finder patterns, the timing lines and the dark module', () => {
    for (const text of ['hi', URL, 'x'.repeat(300)]) {
      const m = encodeQr(text);
      expect(m.size).toBe(m.version * 4 + 17);
      expect(finderAt(m, 0, 0)).toBe(true);
      expect(finderAt(m, m.size - 7, 0)).toBe(true);
      expect(finderAt(m, 0, m.size - 7)).toBe(true);
      for (let i = 8; i < m.size - 8; i += 1) {
        expect(m.modules[6]![i]).toBe(i % 2 === 0);
        expect(m.modules[i]![6]).toBe(i % 2 === 0);
      }
      expect(m.modules[m.size - 8]![8]).toBe(true);
    }
  });

  it('picks the smallest version that fits and refuses text beyond version 40', () => {
    expect(encodeQr('hi').version).toBe(1);
    expect(encodeQr('a'.repeat(14)).version).toBe(1); // version 1-M holds 14 bytes
    expect(encodeQr('a'.repeat(15)).version).toBe(2);
    expect(encodeQr('a'.repeat(300)).version).toBeGreaterThan(9); // 16-bit length field
    expect(() => encodeQr('a'.repeat(3000))).toThrow(/too long/);
  });

  it('renders two module rows per line with a quiet zone', () => {
    const m = encodeQr('hi');
    const lines = renderQr(m, 2).split('\n');
    expect(lines).toHaveLength(Math.ceil((m.size + 4) / 2));
    for (const line of lines) expect([...line]).toHaveLength(m.size + 4);
    expect(lines[0]).toBe('█'.repeat(m.size + 4)); // margin rows are all light
    expect(renderQr(m, 2)).toMatch(/^[█▀▄ \n]+$/);
  });
});
