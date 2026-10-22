# Chat engine stream fixtures

The tests replay these byte for byte through a fake fetch. Mid-stream errors and aborts are made in the
tests by cutting a fixture after a number of frames and appending the vendor's error frame, so the bulk
of every stream stays the recorded bytes.

| File | Wire format | Provenance |
|---|---|---|
| `ollama-thinking.ndjson` | Ollama `/api/chat` NDJSON | Recorded 2026-10-22 from the Mac's Ollama: `POST http://localhost:11434/api/chat` with model `gpt-oss:120b-cloud`, `think: true`, prompt "Say hi in three words." Thinking deltas, text deltas, and the final `done: true` line with `prompt_eval_count` and `eval_count`. |
| `openai-reasoning.sse` | OpenAI-compatible SSE | Recorded 2026-10-22 from the same Ollama's OpenAI-compatible endpoint: `POST http://localhost:11434/v1/chat/completions`, `stream_options.include_usage`, `reasoning_effort: "low"`. Reasoning in `delta.reasoning`, a `finish_reason` chunk, a usage chunk, then `[DONE]`. |
| `anthropic-thinking.sse` | Anthropic Messages SSE | Transcribed from the extended-thinking streaming example in Anthropic's Messages streaming documentation (no Anthropic key on this machine). `message_start` usage, `ping`, thinking deltas, a signature delta, a text delta, `message_delta` usage, `message_stop`. |

The same day, Ollama Cloud answered a retired model (`qwen3.5:cloud`) with HTTP 410 and
`{"error":"qwen3.5:397b was retired on September 25, 2026. Try glm-5.3-flash:cloud. …"}`; the tests use
that body for the "unknown model" case.
