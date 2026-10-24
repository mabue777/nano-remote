// The fixture language of the fake pi (fake-pi.ts). A fixture lists the turns the fake plays, in order,
// across every fake process that shares one state file (so a restarted pi continues where the killed one
// stopped). Turns past the end reply "You said: <text>".
//
// The records the fake writes follow pi 1.3.0 as probed on the operator's Mac (docs/json.md event order:
// message_end with the tool call, tool_execution_start, the extension's confirm, tool_execution_end).

export type FakePiStep =
  /** An assistant text block: text_start, `chunks` text_delta records, message_end. */
  | { reply: string; chunks?: number }
  /** An assistant thinking block streamed in one delta. */
  | { thinking: string }
  /**
   * A tool call. It goes through the loaded extension's `tool_call` handlers (Nano's approval asks there);
   * a blocked call ends as an error result with the block reason. `write` really writes the file in the
   * session folder; `bash` streams `output` in two partial results.
   */
  | { tool: { name: string; args: Record<string, unknown>; output?: string; isError?: boolean; exitCode?: number; patch?: string } }
  /** An extension dialog; the answer comes back as a reply `Answer: <json>`. */
  | { dialog: { method: 'select' | 'input' | 'editor' | 'confirm'; title: string; message?: string; options?: string[]; timeout?: number } }
  /** A fire-and-forget extension UI record. */
  | { notify: string }
  /** Waits for `steer` (then plays on) or `abort`. */
  | { hold: true }
  /** The assistant message ends with stopReason "error". */
  | { fail: string }
  /** The process exits with this code. */
  | { crash: number }
  /** Writes this record as is. */
  | { raw: Record<string, unknown> }
  /** Writes this record after the turn settled (pi activity outside a turn). */
  | { late: Record<string, unknown> }
  /** Writes a line that is not JSON. */
  | { junk: true };

export type FakePiTurn = FakePiStep[];

export interface FakePiModel {
  provider: string;
  id: string;
  name?: string;
  /** pi's `reasoning`: the model takes a thinking level. */
  reasoning?: boolean;
  /** pi's `thinkingLevelMap`: null marks a level unsupported; xhigh and max need an entry. */
  thinkingLevelMap?: Record<string, string | null>;
}

export interface FakePiFixture {
  turns?: FakePiTurn[];
  /** `get_available_models`; the first is the default model. */
  models?: FakePiModel[];
  /** The thinking level of a new session (pi's defaultThinkingLevel), fitted to the model; default off. */
  thinkingLevel?: string;
  /** Command types the fake answers with `success: false` and this error. */
  fail?: Record<string, string>;
  /** Command types the fake never answers. */
  ignore?: string[];
  /** The prompt response's disposition (default "started"); "handled" plays no turn. */
  disposition?: 'started' | 'handled';
  /** `get_session_stats` data instead of the fake's own. */
  stats?: Record<string, unknown>;
  /** Printed to stderr, then the process exits with code 1 before reading anything. */
  exitAtBoot?: string;
  /** `pi --version` output. */
  version?: string;
}

/** One record the fake received, or its command line, as written to its log file. */
export interface FakePiLogEntry {
  pid: number;
  argv?: string[];
  cwd?: string;
  record?: Record<string, unknown>;
}
