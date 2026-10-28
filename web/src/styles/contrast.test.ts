import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { contrast, luminance, palettes, tokenContrast } from './contrast';

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

// Every text token on the surfaces the screens put it on (WCAG AA for body text, 4.5:1), in light and dark.
// A new pairing in a stylesheet belongs here.
const TEXT_PAIRS: [text: string, surface: string][] = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text', '--fill'],
  ['--text', '--fill-strong'],
  ['--muted', '--bg'],
  ['--muted', '--surface'],
  ['--muted', '--fill'],
  ['--text-tertiary', '--bg'],
  ['--text-tertiary', '--surface'],
  ['--text-tertiary', '--fill'], // placeholders in fields
  ['--primary-text', '--primary'],
  ['--bg', '--text'], // the Undo toast and the chat toast: page colour on ink
  ['--error', '--bg'],
  ['--error', '--surface'],
  ['--primary-text', '--error'], // destructive buttons
  ['--ok', '--bg'],
  ['--ok', '--surface'], // the keep-awake status in its card
  ['--ok', '--fill'], // "Approved" on an answered approval card
  ['--diff-add', '--bg'],
  ['--diff-add', '--surface'],
  ['--diff-add', '--fill'], // counts on the diff file rows
  ['--diff-del', '--bg'],
  ['--diff-del', '--surface'],
  ['--diff-del', '--fill'],
  ['--warn-text', '--warn-bg'], // a warn word on its tint
  ['--warn-text', '--bg'], // "Needs approval" / "Needs your answer" at the end of a Home row (look step 6)
  ['--warn-text', '--surface'], // the same on a row whose swipe actions show (a raised band)
];

const { light, dark } = palettes(tokensCss);

describe('token contrast', () => {
  it.each(TEXT_PAIRS)('light: %s on %s is at least 4.5:1', (text, surface) => {
    expect(tokenContrast(light, text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TEXT_PAIRS)('dark: %s on %s is at least 4.5:1', (text, surface) => {
    expect(tokenContrast(dark, text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the warm light palette and keeps dark as it was', () => {
    expect(light['--bg']).toBe('#fafaf8');
    expect(light['--fill']).toBe('#f2f1ee');
    expect(light['--fill-strong']).toBe('#e7e5e1');
    expect(light['--text']).toBe('#1a1917');
    expect(dark['--bg']).toBe('#0d0d0d');
    expect(dark['--surface']).toBe('#212121');
    expect(dark['--text']).toBe('#ffffff');
  });
});

describe('contrast helper', () => {
  it('computes the WCAG ratios of known pairs', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#ffffff', '#767676')).toBe(contrast('#767676', '#ffffff'));
  });

  it('computes luminance at both ends of the sRGB curve', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(luminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 10); // the linear segment
  });

  it('rejects colours that are not #rrggbb', () => {
    expect(() => luminance('#fff')).toThrow(/not a #rrggbb/);
    expect(() => luminance('rgb(0 0 0)')).toThrow(/not a #rrggbb/);
  });

  it('parses light and dark blocks, the dark one laid over the light', () => {
    const css = ':root { --a: #111111; --b: #FFFFFF; --c: rgb(0 0 0 / 0.1); }\n@media (prefers-color-scheme: dark) { :root { --a: #eeeeee; } }';
    const p = palettes(css);
    expect(p.light).toEqual({ '--a': '#111111', '--b': '#ffffff' });
    expect(p.dark).toEqual({ '--a': '#eeeeee', '--b': '#ffffff' });
  });

  it('uses the light palette for dark when there is no dark block', () => {
    const p = palettes(':root { --a: #123456; }');
    expect(p.dark).toEqual(p.light);
  });

  it('names a missing token', () => {
    const p = palettes(':root { --a: #123456; }');
    expect(() => tokenContrast(p.light, '--a', '--nope')).toThrow('unknown token: --nope');
    expect(() => tokenContrast(p.light, '--nope', '--a')).toThrow('unknown token: --nope');
  });
});
