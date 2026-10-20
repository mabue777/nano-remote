/** The source SVG every icon is rendered from. */
export const ICON_SOURCE: string;
/** Every PNG the app ships, by file name, with its edge length in pixels. */
export const ICON_SIZES: Readonly<Record<string, number>>;
/** Renders `svg` once per entry of `sizes`; resolves to file name -> PNG bytes. */
export function renderIcons(svg: string, sizes?: Readonly<Record<string, number>>): Promise<Map<string, Buffer>>;
