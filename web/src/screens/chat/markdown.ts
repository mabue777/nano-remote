// The small markdown subset a chat reply uses, parsed into blocks the chat view renders as elements (never
// as HTML, so a reply cannot inject markup). Paragraphs, headings, fenced code, bullet and numbered lists,
// quotes; inline code, bold, italic and http(s) links. Built for streaming: an unclosed fence is a code
// block that is still growing, and a half-typed `**` stays plain text until it closes.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'p'; inlines: Inline[] }
  | { kind: 'h'; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; start: number; items: Inline[][] }
  | { kind: 'quote'; inlines: Inline[] };

const FENCE = /^\s*(```|~~~)\s*([\w+.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', inlines: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== fence[1]) body.push(lines[j++]!);
      blocks.push({ kind: 'code', lang: fence[2]!, text: body.join('\n') });
      i = j;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ kind: 'h', level, inlines: parseInline(heading[2]!.trim()) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet !== null || numbered !== null) {
      flush();
      const last = blocks.at(-1);
      const item = parseInline((bullet?.[1] ?? numbered?.[2])!);
      if (bullet !== null) {
        if (last?.kind === 'ul') last.items.push(item);
        else blocks.push({ kind: 'ul', items: [item] });
      } else if (last?.kind === 'ol') last.items.push(item);
      else blocks.push({ kind: 'ol', start: Number(numbered![1]), items: [item] });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flush();
      const last = blocks.at(-1);
      const text = quote[1]!;
      if (last?.kind === 'quote') last.inlines = parseInline(`${inlineText(last.inlines)}\n${text}`);
      else blocks.push({ kind: 'quote', inlines: parseInline(text) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > at) out.push({ kind: 'text', text: text.slice(at, index) });
    if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] });
    else if (match[2] !== undefined || match[3] !== undefined) out.push({ kind: 'strong', text: (match[2] ?? match[3])! });
    else if (match[4] !== undefined) out.push({ kind: 'em', text: match[4] });
    else out.push({ kind: 'link', text: match[5]!, href: match[6]! });
    at = index + match[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

function inlineText(inlines: Inline[]): string {
  return inlines
    .map((i) => {
      switch (i.kind) {
        case 'code':
          return `\`${i.text}\``;
        case 'strong':
          return `**${i.text}**`;
        case 'em':
          return `*${i.text}*`;
        case 'link':
          return `[${i.text}](${i.href})`;
        case 'text':
          return i.text;
      }
    })
    .join('');
}
