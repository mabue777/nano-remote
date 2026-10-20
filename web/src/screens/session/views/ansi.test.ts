import { describe, expect, it } from 'vitest';

import { cleanOutput, stripAnsi } from './ansi';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('removes SGR colors, including 256 and true color', () => {
    expect(stripAnsi(`${ESC}[31merror${ESC}[0m: ${ESC}[1;4mbold${ESC}[m`)).toBe('error: bold');
    expect(stripAnsi(`${ESC}[38;5;208morange${ESC}[39m ${ESC}[38;2;10;20;30mrgb${ESC}[0m`)).toBe('orange rgb');
  });

  it('removes cursor moves, erases and private modes', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone${ESC}[?25h${ESC}[?25l${ESC}[3A`)).toBe('done');
  });

  it('removes OSC sequences ended by BEL or ST (titles, hyperlinks)', () => {
    expect(stripAnsi(`${ESC}]0;my title\u0007text`)).toBe('text');
    expect(stripAnsi(`${ESC}]8;;https://x.dev${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
  });

  it('removes short escapes, DCS strings and the 8-bit CSI', () => {
    expect(stripAnsi(`${ESC}(Bplain${ESC}=${ESC}>`)).toBe('plain');
    expect(stripAnsi(`${ESC}Pq#0;2;0;0;0${ESC}\\after`)).toBe('after');
    expect(stripAnsi('\u009b32mgreen\u009b0m')).toBe('green');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('a [31m b\n\tc')).toBe('a [31m b\n\tc');
  });
});

describe('cleanOutput', () => {
  it('makes CRLF into LF', () => {
    expect(cleanOutput('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('settles carriage-return redraws the way a terminal shows them', () => {
    expect(cleanOutput('10%\r50%\r100%\nnext')).toBe('100%\nnext');
    expect(cleanOutput('downloading...\rok')).toBe('okwnloading...');
    expect(cleanOutput(`${ESC}[2K\r[==  ] 50%\r${ESC}[2K\r[====] 100%\n`)).toBe('[====] 100%\n');
    expect(cleanOutput('half\r')).toBe('half');
  });

  it('applies backspaces and drops other control characters but keeps tabs', () => {
    expect(cleanOutput('abc\b\bX')).toBe('aX');
    expect(cleanOutput('\bstart')).toBe('start');
    expect(cleanOutput('bell\u0007 and\u0000 nul\tTab')).toBe('bell and nul\tTab');
  });
});
