// WCAG contrast for the colour tokens in tokens.css: reads the light and dark palettes from the stylesheet's
// text and computes the ratio of a text token on a surface token. Used by contrast.test.ts, which holds the
// list of pairs the screens actually use; the ratios in tokens.css comments come from it.

export type Palette = Record<string, string>;

/** The light palette (the first :root block) and the dark one (the prefers-color-scheme: dark block), each
 *  with the dark values laid over the light ones. Only #rrggbb values are kept. */
export function palettes(css: string): { light: Palette; dark: Palette } {
  const darkAt = css.indexOf('prefers-color-scheme: dark');
  const lightPart = darkAt === -1 ? css : css.slice(0, darkAt);
  const light = hexTokens(lightPart);
  const dark = darkAt === -1 ? { ...light } : { ...light, ...hexTokens(css.slice(darkAt)) };
  return { light, dark };
}

function hexTokens(css: string): Palette {
  const out: Palette = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[match[1]!] = match[2]!.toLowerCase();
  return out;
}

/** Relative luminance of a #rrggbb colour (WCAG 2.x). */
export function luminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The ratio of token `text` on token `surface` in a palette; throws if either token is missing. */
export function tokenContrast(palette: Palette, text: string, surface: string): number {
  const fg = palette[text];
  const bg = palette[surface];
  if (fg === undefined || bg === undefined) throw new Error(`unknown token: ${fg === undefined ? text : surface}`);
  return contrast(fg, bg);
}
