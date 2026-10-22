# Provider presets

`providers.json` is the preset list of `docs/plan/provider-connection.md` section 2. JSON has no comments,
so its provenance lives here. Screens and the host read the file; `web/src/chat/providers/presets.ts`
types it.

## Verification

Verified on 2026-10-22 against each vendor's own public documentation (fetched as text from the pages
named in each entry's `docsURL`, or the vendor's docs source on GitHub).

| Preset | Base URL | What was checked |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | API reference; models list at `/models` |
| Anthropic | `https://api.anthropic.com` | Models list at `/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`; key page moved to platform.claude.com |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | Native API base; models list at `/models` |
| OpenRouter | `https://openrouter.ai/api/v1` | Authentication and models reference |
| Groq | `https://api.groq.com/openai/v1` | OpenAI compatibility page |
| Mistral | `https://api.mistral.ai/v1` | Models endpoint reference |
| DeepSeek | `https://api.deepseek.com` | Documented base URL has no `/v1` |
| Together | `https://api.together.ai/v1` | Host is now `api.together.ai`, not `api.together.xyz` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | OpenAI compatibility page |
| xAI | `https://api.x.ai/v1` | API reference |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` | List-models page; key page is platform.kimi.ai |
| Z.AI | `https://api.z.ai/api/paas/v4` | HTTP introduction page |
| Ollama (local) | `http://localhost:11434` | `docs/api.md`: `/api/tags` |
| Ollama Cloud | `https://ollama.com` | `docs/cloud.mdx`: `https://ollama.com/api/tags` with `Authorization: Bearer` |
| LM Studio (local) | `http://localhost:1234/v1` | OpenAI compatibility page |
| llama.cpp (local) | `http://localhost:9931/v1` | Server README: `--port` default is now 9931 (older builds used 8080) |
| vLLM (local) | `http://localhost:8000/v1` | Quickstart: server starts at `http://localhost:8000` |

## Key prefixes

The key prefixes (`sk-proj-`, `sk-svcacct-`, `sk-ant-`, `AIza`, `sk-or-`, `gsk_`, `xai-`) are the
vendors' issued key formats. Their documentation pages render key examples in script, so the prefixes
could not be read from the docs as text on the verification date. A prefix only pre-selects a preset;
the Test button still confirms the key against the vendor. Vendors whose keys share the generic `sk-`
form (DeepSeek, Moonshot) or have no fixed form carry no prefix and are picked from the preset grid.
