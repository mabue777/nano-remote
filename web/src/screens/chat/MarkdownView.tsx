// The chat's markdown subset (markdown.ts) as elements, never as HTML: used by chat replies and by the file
// viewer's rendered markdown (screens/session/files/FileViewer.tsx). Styles: .markdown in ChatScreen.css.
import type { ComponentChildren } from 'preact';

import type { Segment } from '../../ui/motion/pacer';
import { FreshText } from '../session/TranscriptRows';
import type { Block, Inline } from './markdown';

/** `tail`: the newest pieces, appended to the last block's text so they fade in (see withoutFreshTail). */
export function Markdown({ blocks, tail }: { blocks: Block[]; tail?: Segment[] }) {
  return (
    <div class="markdown">
      {blocks.map((block, i) => {
        const end = tail !== undefined && i === blocks.length - 1 ? <FreshText settled="" fresh={tail} /> : null;
        switch (block.kind) {
          case 'p':
            return (
              <p key={i}>
                {inlines(block.inlines)}
                {end}
              </p>
            );
          case 'h':
            return block.level === 1 ? (
              <h3 key={i}>
                {inlines(block.inlines)}
                {end}
              </h3>
            ) : (
              <h4 key={i}>
                {inlines(block.inlines)}
                {end}
              </h4>
            );
          case 'code':
            return (
              <pre key={i} class="code-block" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case 'ul':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    {inlines(item)}
                    {j === block.items.length - 1 && end}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={block.start}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    {inlines(item)}
                    {j === block.items.length - 1 && end}
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i}>
                {inlines(block.inlines)}
                {end}
              </blockquote>
            );
        }
      })}
    </div>
  );
}

function inlines(parts: Inline[]): ComponentChildren {
  return parts.map((part, i) => {
    switch (part.kind) {
      case 'text':
        return part.text;
      case 'code':
        return <code key={i}>{part.text}</code>;
      case 'strong':
        return <strong key={i}>{part.text}</strong>;
      case 'em':
        return <em key={i}>{part.text}</em>;
      case 'link':
        return (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        );
    }
  });
}
