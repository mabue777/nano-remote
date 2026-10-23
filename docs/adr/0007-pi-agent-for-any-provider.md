# Coding sessions on any provider run through pi as a third agent

Nano drives pi (the pi coding agent, `~/.local/bin/pi`) as a third agent next to Codex and Claude
Code, instead of teaching Codex or Claude Code to run on other providers: the host lists pi only when
its program is found, runs one `pi --mode rpc --no-extensions -e host/pi-extension/nano-approval.js`
process per session in the session folder, keeps pi's own session files (resumed with `--session-id`),
and offers pi's `get_available_models` in the New session sheet with each model's provider
(`model/list` entries `provider/model` with the additive `provider` field). Reasons: pi already holds the
operator's providers and keys (llama.cpp, OpenRouter, Ollama, OpenAI-compatible servers, Google), so a new
provider needs no Nano code and the host never reads, stores or sends a key; pi was the only harness that
ran well on the local 27B model (docs/plan/local-chat.md section 4); its RPC mode is a documented JSONL
protocol with prompt, steer, abort and session commands that map onto protocol v1 without new methods.
Consequences: pi runs every tool without asking by default, so approvals depend on Nano's own extension,
which confirms every tool call except read, grep, find and ls through pi's extension dialog
(`extension_ui_request` confirm) and blocks a declined call; `--no-extensions` keeps the operator's own
pi extensions from approving silently or changing the tool set, at the cost of their features in Nano
sessions (skills and AGENTS.md still load); a pi confirm is yes or no, so pi approvals offer accept,
decline and cancel but not "accept for the session"; quality and speed depend on the chosen model and
are the operator's call; running Codex or Claude Code on other providers is dropped from Phase 5b.
