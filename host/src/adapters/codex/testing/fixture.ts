// The fixture language of the fake app-server (fake-app-server.ts). A fixture lists the turns the fake
// engine plays, in order, across every engine process that shares one state file (so a restarted engine
// continues where the killed one stopped). Turns past the end echo "You said: <text>".
//
// The message shapes the fake sends follow the spike's wire traces (spikes/host-drive) and the schema in
// docs/research/rea/codex-app-server-schema/.

export type FakeStep =
  /** agentMessage item: started, `chunks` deltas, completed. */
  | { reply: string; chunks?: number }
  /** reasoning item with one summary delta. */
  | { reasoning: string }
  /** A commandExecution item that asks `item/commandExecution/requestApproval` first. */
  | { command: { command?: string; cwd?: string; reason?: string; output?: string; availableDecisions?: unknown[] | null; bare?: boolean } }
  /**
   * A commandExecution item that runs without asking. `files` really changes the session folder while it
   * runs: each path (relative to the thread's cwd) is written with its content, or deleted when null.
   */
  | { run: { command: string; output: string; exitCode?: number; files?: Record<string, string | null> } }
  /** A fileChange item that asks `item/fileChange/requestApproval` first. */
  | { fileChange: { path: string; diff: string; kind?: 'add' | 'update' | 'delete'; grantRoot?: string; reason?: string } }
  /** `item/permissions/requestApproval`. */
  | { permissions: { permissions?: Record<string, unknown>; reason?: string } }
  /** `item/tool/requestUserInput`; the answers come back as an agentMessage `Answers: <json>`. */
  | { input: { questions: Record<string, unknown>[]; isBlocking?: boolean } }
  /** An approval the engine withdraws on its own right away (`serverRequest/resolved` without a reply). */
  | { withdrawn: true }
  /** Waits for `turn/steer` (then plays on) or `turn/interrupt`. */
  | { hold: true }
  /** Ends the turn failed. */
  | { fail: string; info?: unknown }
  /** The engine process exits with this code. */
  | { crash: number }
  /** The engine closes its stdout but keeps running. */
  | { closeStdout: true }
  /** Sends this notification as is (`threadId` is filled in when absent). */
  | { notify: { method: string; params?: Record<string, unknown> } }
  /** Sends a server request the host does not handle; the fake records the error reply. */
  | { request: { method: string; params?: Record<string, unknown> } };

export type FakeTurn = FakeStep[];

export interface FakeFixture {
  turns?: FakeTurn[];
  /** `model/list` entries (Codex `Model` shape, reduced). */
  models?: {
    id: string;
    displayName?: string;
    isDefault?: boolean;
    hidden?: boolean;
    /** `supportedReasoningEfforts` as plain levels (default none). */
    efforts?: string[];
    /** `defaultReasoningEffort` (default `medium`). */
    defaultEffort?: string;
  }[];
  /** The reasoning effort of a thread that names none (the user's config.toml); default null. */
  threadEffort?: string;
  /** Split `model/list` into pages of this size. */
  modelPageSize?: number;
  userAgent?: string;
  /** Methods the fake answers with a JSON-RPC error carrying this message. */
  fail?: Record<string, string>;
  /** Methods the fake answers with this result instead of its own. */
  results?: Record<string, unknown>;
  /** Methods the fake never answers. */
  ignore?: string[];
  /** The fake exits (code 3) as soon as it receives this method. */
  exitOn?: string;
  /** Write the turn/start reply and the notifications that follow it in one stdout write (one chunk). */
  oneChunkTurnStart?: boolean;
  /** Write junk to stdout and stderr on boot (the engine must survive it). */
  noise?: boolean;
}

/** One message the fake received, as written to its log file. */
export interface FakeLogEntry {
  pid: number;
  message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
}
