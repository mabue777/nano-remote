# kimi-drive spike: findings

Date: 2026-10-22. Machine: the operator's Mac (Node 26.5). Engine: Kimi Code CLI 0.36.1,
`/Users/mabue/.kimi-code/bin/kimi`. Models asked for: `kimi-code/kimi-for-coding-highspeed`, then
`kimi-code/kimi-for-coding` (provider `managed:kimi-code`, names read from `~/.kimi-code/config.toml`).

Evidence (one line per step, same format as `spikes/host-drive/logs`):
- `logs/kimi-managed.log`: the real account, both routes.
- `logs/kimi-stream-json.log`: the stream-json route the ticket asked about.
- `logs/kimi-acp.log`: the full phone session over `kimi acp`.
- `logs/kimi-acp-decline.log`: the same approval answered with decline.

Raw wire traces sit next to them as `*.trace.jsonl` and are git-ignored.

## Decision: CUT Kimi from v1 marketing

Three findings drive this:

1. **The stream-json route cannot surface approvals, by design.** `--output-format` only works with
   `--prompt`. Prompt mode always runs under the `auto` permission policy. `--prompt` refuses to combine
   with `--yolo`, `--auto` or `--plan`, so there is no flag that turns approvals back on. Observed: the
   write ran with no approval event, even with an explicit `ask` rule for `Write` in config. The ticket's
   rule says "approvals never surface without --yolo, so CUT", and this route meets that rule.
2. **A different route does surface approvals.** `kimi acp` (Agent Client Protocol, JSON-RPC over stdio,
   the protocol editors such as Zed use) starts sessions in mode `default` ("Manual approvals"). It sends
   the reverse request `session/request_permission` and waits for the answer. The full scripted phone
   session passed on it, including kill and resume with catch-up.
3. **That ACP pass is against a scripted fake model, not a real Kimi model.** The operator's Kimi account
   returns `403 Your current subscription does not have access to Kimi Code right now` for both allowed
   models, on both routes. No real-model turn ran, so v1 cannot claim Kimi works end to end.

**Path back.** Kimi can return as a post-v1 adapter built on ACP, not stream-json. Its acceptance is
`SPIKE_KIMI_LIVE=1 node src/run-acp.ts` passing all 8 steps with a real `managed:kimi-code` model once
the account has a Kimi Code subscription. The roadmap's architecture line "Kimi CLI (stream-json)" is wrong
either way: the transport has to be ACP.

## Why a fake model, and why it is a fair test

Approvals are decided by the CLI, not by the model. The model only proposes a tool call, and the CLI's
permission engine decides whether to run it, ask, or refuse. So a scripted model that always proposes the
same `Write` call tests exactly the CLI behaviour in question.

`src/fake-model.ts` is an OpenAI-compatible chat-completions server on 127.0.0.1. It replies with:

- a `Write` tool call for the hello.txt request,
- `Done.` after any tool result,
- `hello.txt` for the follow-up question, but only if the earlier `Write` call is in the history the CLI
  sent. So the follow-up reply also proves the history survived the kill.

Fake runs use a throwaway `KIMI_CODE_HOME` under `/tmp/nano-kimi-drive/*-home`, which holds its own
`config.toml` with provider `type = "openai"`. They never read or write the operator's `~/.kimi-code`.

## Route 1: `--prompt --output-format stream-json`

Exact flags: `kimi --model <alias> --output-format stream-json --prompt <text>`, resumed with
`kimi --model <alias> --output-format stream-json --session <id> --prompt <text>`.

stdout events observed, one JSON object per line:

| Line | Shape |
|---|---|
| version banner | `{"role":"meta","type":"system.version","version":"0.36.1"}` |
| tool call | `{"role":"assistant","tool_calls":[{"type":"function","id","function":{"name":"Write","arguments"}}]}` |
| tool result | `{"role":"tool","tool_call_id","content":"Wrote 5 bytes to ..."}` |
| reply | `{"role":"assistant","content":"Done."}` |
| session id | `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r <id>","content"}` |

- No approval, permission or confirmation event exists on this route. The CLI also tells the model so: it
  injects a `<system-reminder>` saying "Auto permission mode is active. Tool approvals will be handled
  automatically".
- The session id arrives only on the last line, after the turn.
- There is no turn-started or turn-completed event. Process exit marks the end of the turn.
- One process runs one turn, then exits. Nothing long-lived is left to kill between turns.
- `--session <id>` resumes with full history: the follow-up was answered with `hello.txt` and kept the same
  session id.
- Errors are not on stdout. The 403 printed only the version line to stdout, the error went to stderr,
  and the process exited with code 1.
- `kimi --yolo --prompt x` exits 1 with `Cannot combine --prompt with --yolo.` (this matches the docs).
- Docs mismatch: the docs say "static deny rules remain in effect" in prompt mode, but a
  `[[permission.rules]] decision="deny" pattern="Write"` rule in config did not stop the write.
  `kimi doctor` reported that config as valid. This was not investigated further.

## Route 2: `kimi acp`

Exact command: `kimi acp`, then JSON-RPC 2.0, one message per line on stdio.

| Step | Wire |
|---|---|
| session start | `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}`, then `session/new {cwd, mcpServers:[]}`. Returns `sessionId` (`session_<uuid>`), `modes.currentModeId:"default"`, and `configOptions` with ids `model` and `mode`. |
| model choice | `session/set_config_option {sessionId, configId:"model", value:"kimi-code/kimi-for-coding-highspeed"}` worked on the real account. |
| turn | `session/prompt {sessionId, prompt:[{type:"text",text}]}`. The response arrives when the turn ends: `{stopReason:"end_turn"}`. |
| streaming | `session/update` notifications, field `update.sessionUpdate` is one of `tool_call` (`kind:"edit"`, `status:"pending"`), `tool_call_update` (`in_progress`, then `completed` or `failed`), `agent_message_chunk`, `user_message_chunk` (replay only), `usage_update`, `available_commands_update`, `session_info_update`. |
| approval | Reverse request `session/request_permission {sessionId, toolCall:{toolCallId,title,content}, options:[{optionId:"approve_once",kind:"allow_once"},{optionId:"approve_always",kind:"allow_always"},{optionId:"reject",kind:"reject_once"}]}`. |
| answer | Respond `{outcome:{outcome:"selected", optionId}}`. ACP also allows `{outcome:{outcome:"cancelled"}}`. |
| resume | New process, `initialize`, then `session/load {sessionId, cwd, mcpServers:[]}`. This replays the stored history as `session/update` before it returns. `session/resume` (no replay) is also advertised. |

Results:
- Accept: the file was written only after the answer, and the turn completed (`kimi-acp.log` steps 3 to 5).
- Decline: the file was not written. The tool update came back `failed` with "Tool "Write" was not run
  because the user rejected the approval request." The turn still completed with `end_turn`
  (`kimi-acp-decline.log`).
- Kill and resume: SIGKILL between turns, then a new `kimi acp` and `session/load` of the same id. It
  replayed `user_message_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk` and
  `available_commands_update`. The follow-up turn ran while the phone was offline and answered
  `hello.txt`, and `session/open {cursor}` delivered the catch-up (`kimi-acp.log` steps 6 to 8).
- Real account over ACP: `initialize` and `session/new` succeed with no model call. `session/prompt` fails
  with JSON-RPC error `-32000 "Authentication required: 403 Your current subscription ..."`. That is a
  clean, mappable error, unlike prompt mode's stderr-only error.

Mapping onto protocol-v1, as the spike adapter `src/kimi-acp.ts` does it:

- `allow_once` maps to `accept`, `allow_always` to `acceptForSession`, `reject_once` to `decline`, and
  `cancel` to the `cancelled` outcome.
- ACP has no turn id. The host creates one, emits `turn/started`, and ends the turn on the
  `session/prompt` response.
- The final `tool_call_update` omits `kind`, so the adapter has to remember it from the first `tool_call`.

## Not covered

- Any turn with a real Kimi model (403, see above). The real model might pick a different tool than
  `Write` (for example `Bash`), and that was not seen.
- Approvals for `Bash`, the dangerous-command guard, and `AskUserQuestion` over ACP (it shares the
  `session/request_permission` channel according to the docs).
- Killing mid-turn or while an approval is pending.
- Whether ACP `default` mode is affected by the operator's own permission rules in `~/.kimi-code/config.toml`.

## Reproduce

```
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd spikes/kimi-drive            # no dependencies, no install
node src/run-stream-json.ts     # logs/kimi-stream-json.log
node src/run-acp.ts             # logs/kimi-acp.log
node src/probe-acp-decline.ts   # logs/kimi-acp-decline.log
node src/probe-managed.ts       # logs/kimi-managed.log (real account, one model request per route)
SPIKE_KIMI_LIVE=1 node src/run-acp.ts   # logs/kimi-acp-live.log, once the subscription is active
```
Agents work in `/tmp/nano-kimi-drive/<name>`, wiped at the start of each run.
