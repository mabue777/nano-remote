// Attachments as adapters hand them to their engines (protocol-v1.md sections 8.1 and 11). The core has
// resolved every `/v1/blob` URL to a path on this Mac (AdapterInputPart); these helpers give the two
// forms an engine can take: the line a prompt carries for a file, and an image's bytes as base64.
import { readFile } from 'node:fs/promises';

import type { AdapterInputPart } from '../../core/adapter.js';

/** The prompt line of a file the agent reads itself (spec 8.1). */
export function attachedFileLine(path: string): string {
  return `Attached file: ${path}`;
}

/**
 * The line for a part that reaches the engine as a path: a file, or an image the engine cannot take
 * natively. A file part without a path (a blob the core did not resolve) names its URL.
 */
export function fileLine(part: { path?: string; url: string }): string {
  return attachedFileLine(part.path ?? part.url);
}

/** Image media types every engine's native image input takes (the Anthropic API's list). */
export const NATIVE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** A data URL's media type and base64 data, or undefined for anything else. */
export function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1]!.toLowerCase(), data: match[2]! } : undefined;
}

/** An image ready for an engine that wants bytes: media type and base64 data. */
export interface InlineImage {
  mediaType: string;
  data: string;
}

/**
 * The image of a part as bytes, when it is a stored attachment (read from its path) or a data URL, and
 * of a type the engines take natively. Undefined otherwise: the caller sends it as a file line, or as its
 * URL when it has no path.
 */
export async function inlineImage(part: Extract<AdapterInputPart, { type: 'image' }>): Promise<InlineImage | undefined> {
  if (part.path !== undefined) {
    const mediaType = part.mediaType ?? '';
    if (!NATIVE_IMAGE_TYPES.has(mediaType)) return undefined;
    return { mediaType, data: (await readFile(part.path)).toString('base64') };
  }
  const parsed = parseDataUrl(part.url);
  return parsed !== undefined && NATIVE_IMAGE_TYPES.has(parsed.mediaType) ? parsed : undefined;
}
