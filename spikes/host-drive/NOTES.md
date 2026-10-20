# host-drive spike: findings

Date: 2026-10-20. Machine: the operator's Mac (Node 26.5, pnpm 12.14). Engines: Codex app-server
0.163.0-alpha.10.2 (bundled with ChatGPT.app), Claude Code 2.1.304 through `@anthropic-ai/claude-agent-sdk`
0.3.304, model `opus` (init reported `claude-opus-5-5`).

Evidence: `logs/codex.log`, `logs/claude.log` (one line per step), `logs/claude-probe.log` (which tools
reach `canUseTool`). Raw wire traces are written next to them as `*.trace.jsonl` on every run and are
git-ignored because they carry installation ids and full SDK init payloads.

## Result

Both agents completed the full scripted phone session, in the vocabulary of protocol-v1 sections 5 to 7:
`session/start` → `turn/start` → `approval/request` event → `approval/resolve {decision:"accept"}` →
`turn/completed` (file written, content `hello`) → engine process SIGKILLed while the phone is offline →
a new engine process reattaches to the same engine session → a follow-up turn runs while the phone is
offline → the phone's `session/open {sessionId, cursor}` returns `mode:"events"` with every event after its
cursor. In both runs the resumed engine answered the follow-up ("what file did you create?") with
`hello.txt`, so the conversation really survived the kill.

## Claude Agent SDK: canUseTool

**Does the SDK surface permission prompts via `canUseTool`? Yes**, with two conditions the host must set
explicitly (see "Operator settings" below): `permissionMode: "default"` and `settingSources: []`.

| Tool | Reaches `canUseTool`? | Evidence |
|---|---|---|
| Bash | Yes. `input.command`, `input.description`; `toolUseID` equals the `tool_use` block id. | `claude-probe.log` profile=isolated asked=Bash |
| Write | Yes. `input.file_path`, `input.content`. Was also the approval in the main run. | `claude.log` step 3; probe asked=Write |
| AskUserQuestion | Yes. `input.questions[]` with `question`, `header`, `options[{label, description}]`, `multiSelect`. | probe asked=AskUserQuestion, reply `blue` |

- Answering AskUserQuestion: return `{behavior:"allow", updatedInput:{...input, answers:{[questionText]: label}}}`.
  Answers are keyed by the question **text**, not an id; the adapter must map protocol `input/answer`
  `answers:{<questionId>:[string]}` onto that (use the question text, or its index, as `questionId`).
- Decisions map cleanly: `accept` → allow with the original input; `acceptForSession` → allow plus the
  callback's `suggestions` as `updatedPermissions`; `decline` → deny (turn continues); `cancel` → deny with
  `interrupt: true`.
- The fallback paths (PreToolUse hooks, raw streaming CLI mode) were **not needed and not tried**: the
  callback fired for every case asked about.

### Operator settings change the answer (important for the host)

With this machine's own user settings loaded (`settingSources: ["user"]`, no `permissionMode`):
`permissions.defaultMode` is `auto` and `AskUserQuestion` is in `permissions.deny`. The probe's
operator profile showed:
- Bash and Write ran **without** `canUseTool` firing: auto mode's classifier approved them.
- AskUserQuestion never reached the model at all: it searched for the tool and reported it unavailable.

So a host that inherits user settings would silently lose approvals and questions. The Claude adapter
must pass `permissionMode: "default"` and must not load a settings source that denies AskUserQuestion
(this spike passes `settingSources: []`). Whether to honour a user's own allow rules is a product decision.

## Claude Agent SDK: sessions, turns, kill, resume

- `session/start`: `query({prompt: <async iterable>, options:{cwd, model, canUseTool, ...}})` spawns the
  CLI, but in streaming-input mode the `system/init` message (carrying `session_id`) arrives only after
  the first user message. The host learns the engine session id at the first `turn/start`, not at
  `session/start`.
- `turn/start`: push an `SDKUserMessage` into the prompt iterable. The SDK has no turn id and no
  turn-started event: the host creates the turn id and emits `turn/started` itself; the `result` message
  ends the turn (`subtype:"success"` → `completed`) and carries usage.
- Items: `assistant` messages carry `text` and `tool_use` blocks (→ `item/started`), the following `user`
  message carries `tool_result` (→ `item/completed`, `is_error` → `failed`). Streaming deltas were not
  mapped in this spike.
- Kill: the SDK's `spawnClaudeCodeProcess` option gives the host the child process, so it can be SIGKILLed.
- Resume: a new `query({..., resume: sessionId})` after SIGKILL works; its `system/init` reports the
  same `session_id` and the model remembered the earlier turn. Nothing was lost because the CLI writes its
  transcript as it goes; the host's Journal is still what serves the phone's catch-up.
- Environment: when the host itself runs inside a Claude Code session, the child inherits `CLAUDECODE`
  and `CLAUDE_CODE_*` variables. The adapter strips them and keeps `CLAUDE_CONFIG_DIR` (where the login lives).

## Codex app-server

- Shapes matched `docs/research/rea/runtime-capture.md`. `initialize` + `initialized`, `thread/start
  {cwd, approvalPolicy:"on-request", sandbox:"read-only", model}`, `turn/start {threadId, input,
  clientUserMessageId}`. The approval arrived as server request `item/commandExecution/requestApproval`
  (the model wrote the file with `python3 -c ...` in a shell, not with a patch), with a `reason`; the
  reply `{decision:"accept"}` was followed by `serverRequest/resolved`.
- The engine sends its own `availableDecisions`. For this command it offered only `accept`,
  `acceptWithExecpolicyAmendment` (an object, dropped by the adapter) and `cancel`: no `decline` and no
  `acceptForSession`. The adapter should forward the engine's list rather than assume all four.
- Kill and resume: SIGKILL, new `codex app-server`, `thread/resume {threadId, ...}` returned the same
  thread with its one completed turn; the follow-up turn ran normally.
- Model: the operator's `~/.config/codex/config.toml` sets `model = "gpt-6-astra"`, which the engine
  rejects for this ChatGPT plan (400 "not supported when using Codex with a ChatGPT account"; the first
  turn failed before any approval). The spike passes `gpt-6-luna`, the default from `model/list`
  (override with `SPIKE_CODEX_MODEL`). The host should take its default from `model/list`, not config.

## Not covered

- File-change approvals from Codex (`item/fileChange/requestApproval`) did not occur; the model chose a shell command.
- Killing an engine mid-turn or while an approval is pending (the N3 replay case). Here the kill happened between turns.
- Codex `item/tool/requestUserInput`, `turn/steer`, `turn/interrupt`, streaming deltas, and snapshot-mode `session/open`.
- The host process itself never restarted; its Journal lived in memory (also traced to disk).

## Reproduce

```
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd spikes/host-drive && pnpm install
node src/run-codex.ts      # writes logs/codex.log
node src/run-claude.ts     # writes logs/claude.log
node src/probe-claude.ts   # writes logs/claude-probe.log
```
Agents work in `/tmp/nano-host-drive/<agent>`, wiped at the start of each run.
