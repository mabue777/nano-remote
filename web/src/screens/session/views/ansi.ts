// Terminal output for the output view: commands print ANSI escape codes (colors, cursor moves, window
// titles) and carriage returns (progress bars redraw a line). A phone shows plain text, so the codes go
// and each line keeps what a terminal would finally show after its last carriage return.

/**
 * ECMA-48 sequences: CSI (`ESC [` … final byte, also the 8-bit 0x9B form), OSC (`ESC ]` … BEL or
 * `ESC \`), the DCS/SOS/PM/APC strings (… `ESC \`), and two- or three-byte escapes (`ESC (B`, `ESC =`).
 */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/g;

/** Removes ANSI escape sequences, leaving the text a terminal would print. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** One line after carriage returns: later writes overwrite the start of the line, as on a terminal. */
function settleLine(line: string): string {
  if (!line.includes('\r')) return line;
  let shown = '';
  for (const part of line.split('\r')) shown = part + shown.slice(part.length);
  return shown;
}

/**
 * Command output as plain text: escape codes stripped, CRLF made LF, carriage-return redraws settled,
 * backspaces applied, and other control characters (except tab) dropped.
 */
export function cleanOutput(text: string): string {
  const plain = stripAnsi(text).replace(/\r\n/g, '\n');
  return plain
    .split('\n')
    .map((line) => {
      // A backspace erases the character before it (a leading one has nothing to erase).
      let settled = settleLine(line);
      let erased = '';
      for (const char of settled) erased = char === '\u0008' ? erased.slice(0, -1) : erased + char;
      settled = erased;
      // eslint-disable-next-line no-control-regex
      return settled.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    })
    .join('\n');
}
