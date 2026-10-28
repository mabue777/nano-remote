// The text file viewer of a session folder (docs/plan/file-viewer.md item P3; protocol-v1.md section 4.1):
// what the page shows for one file, kept apart from the DOM so it can be tested in Node.
//
// Loading. `fs/readFile` answers up to 256 KiB of text per call, cut after a newline when it can. The model
// keeps the text read so far; "Show more" asks for the next range (offset = previous offset + length) and
// appends it. A file the host calls binary shows a card (kind, size, modified) instead of text.
//
// Opening `src/parser.ts:42` (or a route with `line`) scrolls to line 42 and tints it once; when that line
// lies past the first range, the model reads on (up to MAX_AUTO_RANGES ranges) to reach it.
//
// Wrap. On by default for prose (markdown, plain text), off for code, and remembered per kind on this phone.
// Markdown shows rendered (the chat's markdown.ts) or raw; find and a line jump show it raw.
//
// Find. Plain text, not a pattern; case-insensitive unless the case toggle is on; "3 of 12" with next and
// previous wrapping around; at most MAX_MATCHES matches are counted.
//
// Windowing. Long files render only the lines near the viewport (FileViewer.tsx): the lines are grouped in
// blocks of BLOCK_LINES; `visibleBlocks` picks the blocks that meet the viewport plus an overscan, from each
// block's measured height or, before it was ever shown, an estimate (`estimateBlockHeight`).
import type { FsReadFileResult } from '../../../generated/methods';
import type { StorageLike } from '../../../replica/storage';
import { RequestError } from '../../../stream/client';
import { errorText, Model } from '../../model';

/** How many ranges a line jump reads on its own to reach its line (4 × 256 KiB). */
export const MAX_AUTO_RANGES = 4;
/** The most find matches counted; the count then reads "1 of 5000+". */
export const MAX_MATCHES = 5000;
/** Lines per rendering block. */
export const BLOCK_LINES = 100;
/** The storage key of the wrap choice per kind. */
export const WRAP_KEY = 'nano.files.wrap';

/** How the viewer treats a text file: prose wraps by default, code does not; markdown can render. */
export type TextKind = 'markdown' | 'text' | 'code';

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx', 'mdown']);
const TEXT_EXT = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc']);

/** The extension of a path, lower case, without the dot; '' for none (a dot-file such as `.env` has none). */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The kind of a text file, by extension, then by the host's media type. */
export function textKindOf(path: string, mediaType = ''): TextKind {
  const ext = extensionOf(path);
  if (MARKDOWN_EXT.has(ext) || mediaType === 'text/markdown') return 'markdown';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === '' && (mediaType === 'text/plain' || mediaType === '')) return /^(readme|license|licence|changelog|notice|authors|copying)$/i.test(fileName(path)) ? 'text' : 'code';
  return 'code';
}

/** Wrap is on by default for prose, off for code. */
export function wrapDefault(kind: TextKind): boolean {
  return kind !== 'code';
}

/** The wrap choice per kind, kept on this phone. */
export class WrapPrefs {
  constructor(private readonly storage: StorageLike | null) {}

  get(kind: TextKind): boolean {
    const saved = this.read()[kind];
    return typeof saved === 'boolean' ? saved : wrapDefault(kind);
  }

  set(kind: TextKind, on: boolean): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(WRAP_KEY, JSON.stringify({ ...this.read(), [kind]: on }));
    } catch {
      // storage full or blocked: the choice lasts for this page only
    }
  }

  private read(): Partial<Record<TextKind, unknown>> {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(WRAP_KEY) ?? '{}');
      return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<Record<TextKind, unknown>>) : {};
    } catch {
      return {};
    }
  }
}

/** A path with an optional `:line` (and `:column`, ignored) at its end, as agents write them. */
export function parseFileTarget(raw: string): { path: string; line?: number } {
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(raw);
  if (match === null) return { path: raw };
  const line = Number(match[2]);
  return line > 0 ? { path: match[1]!, line } : { path: match[1]! };
}

/** The last part of a path. */
export function fileName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.at(-1) ?? path;
}

/** The folder part of a relative path ('' for a file at the top of the session folder). */
export function folderOf(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.slice(0, -1).join('/');
}

/** A byte count the way the Files app writes it (decimal units): "512 bytes", "12 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${shown} ${units[unit]}`;
}

const BINARY_KINDS: Readonly<Record<string, string>> = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'image/heic': 'HEIC image',
  'image/heif': 'HEIF image',
  'image/avif': 'AVIF image',
  'application/pdf': 'PDF document',
  'application/zip': 'ZIP archive',
  'application/gzip': 'Gzip archive',
};

/** What a binary file is, in words: "PNG image", "PDF document", "SQLITE file", "Binary file". */
export function binaryKindLabel(mediaType: string, path: string): string {
  const known = BINARY_KINDS[mediaType];
  if (known !== undefined) return known;
  const ext = extensionOf(path);
  return ext === '' ? 'Binary file' : `${ext.toUpperCase()} file`;
}

/** The lines of a text: split on newlines, a final newline does not start an empty line, CRs dropped. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

// ---- find ---------------------------------------------------------------------------------------------

export interface Match {
  /** 0-based line index. */
  line: number;
  start: number;
  end: number;
}

/** Every match of `query` (plain text) in the lines, in order, at most `limit`; `capped` when more exist. */
export function findMatches(lines: readonly string[], query: string, matchCase: boolean, limit = MAX_MATCHES): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  if (query === '') return { matches, capped: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
  for (let line = 0; line < lines.length; line += 1) {
    for (const found of lines[line]!.matchAll(pattern)) {
      if (matches.length === limit) return { matches, capped: true };
      matches.push({ line, start: found.index, end: found.index + found[0].length });
    }
  }
  return { matches, capped: false };
}

/** The next (+1) or previous (-1) match index, wrapping around; -1 when there is none. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The first match at or after `line` (wrapping to the first), so a new query starts where the reader is. */
export function matchFrom(matches: readonly Match[], line: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((m) => m.line >= line);
  return index === -1 ? 0 : index;
}

/** One piece of a line as shown: plain, a match, or the current match. */
export interface Segment {
  text: string;
  mark?: 'match' | 'current';
}

/** A line cut at its matches. `ranges` belong to this line, in order and not overlapping. */
export function lineSegments(text: string, ranges: readonly { start: number; end: number; current: boolean }[]): Segment[] {
  if (ranges.length === 0) return [{ text }];
  const out: Segment[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) out.push({ text: text.slice(at, range.start) });
    out.push({ text: text.slice(range.start, range.end), mark: range.current ? 'current' : 'match' });
    at = range.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

// ---- windowing ----------------------------------------------------------------------------------------

/** How many rendering blocks `lineCount` lines make. */
export function blockCount(lineCount: number): number {
  return Math.ceil(lineCount / BLOCK_LINES);
}

/** The height of a block before it was measured: one row per line, or per `columns` characters when wrapped. */
export function estimateBlockHeight(lines: readonly string[], block: number, layout: { wrap: boolean; columns: number; lineHeight: number }): number {
  const first = block * BLOCK_LINES;
  const last = Math.min(lines.length, first + BLOCK_LINES);
  if (!layout.wrap) return (last - first) * layout.lineHeight;
  const columns = Math.max(1, layout.columns);
  let rows = 0;
  for (let i = first; i < last; i += 1) rows += Math.max(1, Math.ceil(lines[i]!.length / columns));
  return rows * layout.lineHeight;
}

/**
 * The blocks to render for a viewport [top, bottom) in the lines' own coordinates, widened by `overscan`
 * pixels each way: the first and last block, and the heights of the blocks above and below them (the
 * spacers). Always at least one block when there are any.
 */
export function visibleBlocks(heights: readonly number[], top: number, bottom: number, overscan: number): { first: number; last: number; before: number; after: number } {
  if (heights.length === 0) return { first: 0, last: -1, before: 0, after: 0 };
  const from = top - overscan;
  const to = bottom + overscan;
  let y = 0;
  let first = -1;
  let last = -1;
  let before = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const h = heights[i]!;
    if (y + h > from && y < to) {
      if (first === -1) {
        first = i;
        before = y;
      }
      last = i;
    }
    y += h;
  }
  if (first === -1) {
    // The viewport lies past the end (or before the start): show the nearest block.
    first = last = from >= y ? heights.length - 1 : 0;
    before = heights.slice(0, first).reduce((a, b) => a + b, 0);
  }
  const after = y - before - heights.slice(first, last + 1).reduce((a, b) => a + b, 0);
  return { first, last, before, after };
}

/** The block a 0-based line falls in. */
export function blockOf(line: number): number {
  return Math.floor(line / BLOCK_LINES);
}

// ---- the model ----------------------------------------------------------------------------------------

/** What the viewer needs from the stream client; StreamClient fits. */
export interface FileReader {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface FileInfo {
  /** The path inside the session folder after links were resolved. */
  path: string;
  size: number;
  mtimeMs: number;
  mediaType: string;
}

export type FileState =
  | { state: 'loading' }
  | { state: 'error'; message: string; missing: boolean }
  | { state: 'binary'; info: FileInfo; kindLabel: string }
  | { state: 'text'; info: FileInfo };

/** A place the page should scroll to: a line jump (tinted once) or the current find match. */
export interface ScrollTarget {
  /** 0-based line index. */
  line: number;
  /** Tint the line briefly (a path:line jump). */
  flash: boolean;
  /** Bumped per request, so the same line can be asked for twice. */
  token: number;
}

/** The message for a failed read. */
export function readErrorText(error: unknown): { message: string; missing: boolean } {
  if (error instanceof RequestError) {
    if (error.code === 'not_found') return { message: 'That file is not in the session folder.', missing: true };
    if (error.code === 'invalid_params') return { message: 'This is not a file that can be shown here.', missing: false };
    if (error.code === 'timeout' || error.code === 'connection_lost' || error.code === 'client_closed') {
      return { message: "Couldn't load this file. Check the connection to your Mac.", missing: false };
    }
  }
  return { message: errorText(error), missing: false };
}

export interface FileViewerOptions {
  sessionId: string;
  /** As in the route: may end in `:line`. */
  path: string;
  /** 1-based; wins over a `:line` in the path. */
  line?: number;
  reader: FileReader;
  storage: StorageLike | null;
}

export class FileViewerModel extends Model {
  readonly sessionId: string;
  /** The path asked for, without `:line`. */
  readonly path: string;
  /** The 1-based line to jump to once loaded. */
  readonly line: number | undefined;
  readonly kind: TextKind;
  /** Wrap long lines. */
  wrap: boolean;
  /** Markdown shown rendered (only for the markdown kind). */
  rendered: boolean;
  /** Find bar. */
  findOpen = false;
  query = '';
  matchCase = false;
  matches: Match[] = [];
  capped = false;
  /** Index into `matches`; -1 for none. */
  current = -1;
  scrollTarget: ScrollTarget | undefined;
  /** "Show more" is reading. */
  loadingMore = false;
  /** The last "Show more" failed. */
  moreError: string | undefined;

  private file: FileState = { state: 'loading' };
  private text = '';
  private linesCache: string[] = [];
  private nextOffset = 0;
  private more_ = false;
  private request = 0;
  private token = 0;
  private disposed = false;
  private readonly reader: FileReader;
  private readonly prefs: WrapPrefs;

  constructor(options: FileViewerOptions) {
    super();
    const target = parseFileTarget(options.path);
    this.sessionId = options.sessionId;
    this.path = target.path;
    this.line = options.line ?? target.line;
    this.kind = textKindOf(this.path);
    this.reader = options.reader;
    this.prefs = new WrapPrefs(options.storage);
    this.wrap = this.prefs.get(this.kind);
    this.rendered = this.kind === 'markdown' && this.line === undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  get state(): FileState {
    return this.file;
  }

  /** The text read so far, in lines. */
  get lines(): readonly string[] {
    return this.linesCache;
  }

  /** The text read so far. */
  get loadedText(): string {
    return this.text;
  }

  /** The file goes on past what was read. */
  get hasMore(): boolean {
    return this.more_;
  }

  /** Bytes read so far. */
  get loadedBytes(): number {
    return this.nextOffset;
  }

  /** The markdown can be shown rendered. */
  get canRender(): boolean {
    return this.kind === 'markdown';
  }

  /** "3 of 12", "0 results", "1 of 5000+"; '' with no query. */
  get findCount(): string {
    if (this.query === '') return '';
    if (this.matches.length === 0) return 'No results';
    return `${this.current + 1} of ${this.matches.length}${this.capped ? '+' : ''}`;
  }

  /** Reads the first range (again, after an error). */
  async load(): Promise<void> {
    const ticket = ++this.request;
    this.file = { state: 'loading' };
    this.text = '';
    this.linesCache = [];
    this.nextOffset = 0;
    this.more_ = false;
    this.changed();
    try {
      const result = await this.read(0);
      if (this.stale(ticket)) return;
      const info: FileInfo = { path: result.path, size: result.size, mtimeMs: result.mtimeMs, mediaType: result.mediaType };
      if (result.binary) {
        this.file = { state: 'binary', info, kindLabel: binaryKindLabel(result.mediaType, result.path) };
        this.changed();
        return;
      }
      this.append(result);
      this.file = { state: 'text', info };
      if (this.line !== undefined) {
        for (let ranges = 1; ranges < MAX_AUTO_RANGES && this.more_ && this.linesCache.length < this.line; ranges += 1) {
          const next = await this.read(this.nextOffset);
          if (this.stale(ticket)) return;
          this.append(next);
        }
        this.scrollTarget = { line: Math.min(this.line, Math.max(1, this.linesCache.length)) - 1, flash: true, token: ++this.token };
      }
      this.refind(false);
      this.changed();
    } catch (error) {
      if (this.stale(ticket)) return;
      this.file = { state: 'error', ...readErrorText(error) };
      this.changed();
    }
  }

  /** Reads the next range and appends it. */
  async more(): Promise<void> {
    if (!this.more_ || this.loadingMore || this.file.state !== 'text') return;
    const ticket = this.request;
    this.loadingMore = true;
    this.moreError = undefined;
    this.changed();
    try {
      const result = await this.read(this.nextOffset);
      if (this.stale(ticket)) return;
      this.append(result);
      this.refind(false);
    } catch (error) {
      if (this.stale(ticket)) return;
      this.moreError = readErrorText(error).message;
    }
    this.loadingMore = false;
    this.changed();
  }

  setWrap(on: boolean): void {
    if (this.wrap === on) return;
    this.wrap = on;
    this.prefs.set(this.kind, on);
    this.changed();
  }

  setRendered(on: boolean): void {
    if (!this.canRender || this.rendered === on) return;
    this.rendered = on;
    if (on) this.findOpen = false;
    this.changed();
  }

  /** Opens the find bar; rendered markdown switches to raw, where matches can be shown. */
  openFind(): void {
    this.findOpen = true;
    this.rendered = false;
    this.changed();
  }

  closeFind(): void {
    if (!this.findOpen) return;
    this.findOpen = false;
    this.changed();
  }

  /** A new query; the current match becomes the first one at or after `fromLine` (0-based). */
  setQuery(query: string, fromLine = 0): void {
    this.query = query;
    this.refind(true, fromLine);
    this.changed();
  }

  setMatchCase(on: boolean): void {
    if (this.matchCase === on) return;
    this.matchCase = on;
    this.refind(true, this.matches[this.current]?.line ?? 0);
    this.changed();
  }

  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  private step(direction: 1 | -1): void {
    const index = stepMatch(this.current, this.matches.length, direction);
    if (index === -1) return;
    this.current = index;
    this.scrollTarget = { line: this.matches[index]!.line, flash: false, token: ++this.token };
    this.changed();
  }

  /** Recomputes the matches; `jump` moves to the first one from `fromLine` and asks to scroll there. */
  private refind(jump: boolean, fromLine = 0): void {
    const kept = this.matches[this.current];
    const { matches, capped } = findMatches(this.linesCache, this.query, this.matchCase);
    this.matches = matches;
    this.capped = capped;
    if (jump) {
      this.current = matchFrom(matches, fromLine);
      if (this.current >= 0) this.scrollTarget = { line: matches[this.current]!.line, flash: false, token: ++this.token };
      return;
    }
    // More text arrived: keep the same match current.
    this.current = kept === undefined ? matchFrom(matches, 0) : matches.findIndex((m) => m.line === kept.line && m.start === kept.start);
    if (this.current === -1 && matches.length > 0) this.current = 0;
  }

  private append(result: FsReadFileResult): void {
    this.text += result.content ?? '';
    this.linesCache = splitLines(this.text);
    this.nextOffset = result.offset + result.length;
    this.more_ = result.truncated;
  }

  private read(offset: number): Promise<FsReadFileResult> {
    return this.reader.request<FsReadFileResult>('fs/readFile', { sessionId: this.sessionId, path: this.path, ...(offset > 0 ? { offset } : {}) });
  }

  private stale(ticket: number): boolean {
    return this.disposed || ticket !== this.request;
  }
}

/** The URL of a session file's bytes (protocol 4.1 `GET /v1/file`), for Share and download. */
export function fileUrl(sessionId: string, path: string): string {
  return `/v1/file?${new URLSearchParams({ sessionId, path }).toString()}`;
}
