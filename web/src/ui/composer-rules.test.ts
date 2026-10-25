import { describe, expect, it } from 'vitest';

import { composerButtons, composerRows, hasContent, isSendShortcut } from './composer-rules';

const base = { draft: '', attachments: 0, running: false, sendsWhileRunning: true };

describe('composerButtons', () => {
  it('idle: the arrow, empty field or not, and no hint', () => {
    expect(composerButtons(base)).toEqual({ action: 'send', smallStop: false, hint: false });
    expect(composerButtons({ ...base, draft: 'hi' })).toEqual({ action: 'send', smallStop: false, hint: false });
  });

  it('running with nothing typed: the filled square (Stop)', () => {
    expect(composerButtons({ ...base, running: true })).toEqual({ action: 'stop', smallStop: false, hint: false });
    expect(composerButtons({ ...base, running: true, draft: '  \n ' })).toEqual({ action: 'stop', smallStop: false, hint: false });
  });

  it('running with text or an attachment: Send steers, a small Stop stays, the hint shows', () => {
    expect(composerButtons({ ...base, running: true, draft: 'also this' })).toEqual({ action: 'send', smallStop: true, hint: true });
    expect(composerButtons({ ...base, running: true, attachments: 1 })).toEqual({ action: 'send', smallStop: true, hint: true });
  });

  it('local chat cannot send into a running reply: Stop stays the button while you type', () => {
    expect(composerButtons({ ...base, running: true, draft: 'next', sendsWhileRunning: false })).toEqual({ action: 'stop', smallStop: false, hint: false });
  });
});

describe('hasContent', () => {
  it('counts text that is not only whitespace, and attachments', () => {
    expect(hasContent({ draft: ' ', attachments: 0 })).toBe(false);
    expect(hasContent({ draft: 'x', attachments: 0 })).toBe(true);
    expect(hasContent({ draft: '', attachments: 2 })).toBe(true);
  });
});

describe('composerRows', () => {
  it('grows with the lines, one to six', () => {
    expect(composerRows('')).toBe(1);
    expect(composerRows('a\nb\nc')).toBe(3);
    expect(composerRows('1\n2\n3\n4\n5\n6\n7\n8')).toBe(6);
  });
});

describe('isSendShortcut', () => {
  it('Cmd-Enter and Ctrl-Enter send; Enter and Shift-Enter make a new line', () => {
    expect(isSendShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSendShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true);
    expect(isSendShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isSendShortcut({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false);
  });
});
