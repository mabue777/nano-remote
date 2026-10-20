# Odysseus behavior inventory (source reading)

Date: 2026-10-20. Target: `https://github.com/odysseus-dev/odysseus`, default branch `dev`, shallow clone at
commit `ae238b7` ("Merge pull request #6396"), read in `/tmp/rea-odysseus-full`. Nothing was built, installed or run.
All paths below are relative to the repo root. Labels: **Observed** = seen in source; **Inferred** = best
explanation of observed code; **Unknown** = not established from this tree.

## Identity

Odysseus is a self-hosted, single-server AI workspace: a Python FastAPI backend plus a hand-written vanilla-JS
single-page web app (a PWA, an app you can install from the browser), with chat, agents, deep research, documents,
email, notes, calendar and local-model serving ("Cookbook"). It is not a native mobile app. Phones connect either
through the browser or through a separate "companion" client (an Expo/React Native app that is not in this
repo) that pairs with a QR code. License is AGPL-3.0, which is copyleft over a network, so code cannot be copied
into a closed app. Size: 2,631 files; about 218k lines of Python (app, src, routes, core, services, companion) and
about 170k lines of JS in `static/js`; 1,321 Python test files and 45 JS test files. App version `1.0.3`.
Build targets: Docker image (multi-arch, GHCR), native venv, a macOS `.app`/`.dmg` launcher wrapper, and a
Windows portable build (PyInstaller plus tray icon).

## 1. Identity and stack

1. **Observed.** The product describes itself as a self-hosted AI workspace. `README.md:6` "A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows."
2. **Observed.** The backend is FastAPI on uvicorn. `app.py:130` "app = FastAPI("; `app.py:1439` "uvicorn.run(app, host=bind_host, port=bind_port".
3. **Observed.** The license is AGPL v3. `LICENSE:1` "GNU AFFERO GENERAL PUBLIC LICENSE".
4. **Observed.** The app version is 1.0.3. `src/constants.py:8` `APP_VERSION = "1.0.3"`.
5. **Observed.** The frontend is plain ES modules plus vendored libraries, with no framework or bundler in `package.json` (only Playwright, acorn, bombadil dev dependencies). `package.json:14-18` `"@playwright/test": "^1.62.1"`, `"acorn": "8.19.0"`.
6. **Observed.** The app ships as an installable PWA. `static/manifest.json:6` `"display": "standalone"`.
7. **Observed.** The macOS build is a launcher that drives the repo venv, not a bundled native app. `build-macos-app.sh:11-12` "This is a *launcher* wrapper: it drives the venv we set up in this repo, it does not bundle Python."
8. **Observed.** The Windows build is a tkinter splash plus tray icon that opens the browser. `launcher.py:4-7` "Immediate GUI splash screen creation using tkinter... Spawning system tray icon via pystray".
9. **Observed.** The only Swift code is an MLX image bridge (colorize, inpaint), not an iOS client. Paths: `swift/odysseus-mlx-image-bridge/Sources/OdysseusMLXColorize/main.swift`, `.../OdysseusMLXInpaint/main.swift`.
10. **Observed.** A separate Expo mobile client exists outside this repo. `companion/pairing.py:41` "Match the host forms supported by the current v1 Expo client."
11. **Observed.** Storage is SQLite by default. `core/database.py:44` `return f"sqlite:///{Path(DATA_DIR) / 'app.db'}"`.

## 2. Information architecture and flows

12. **Observed.** The main navigation is a vertical icon rail with fixed destinations. `static/index.html:764-781` ids `rail-chats`, `rail-documents`, `rail-calendar`, `rail-compare`, `rail-cookbook`, `rail-research`, `rail-email`, `rail-gallery`, `rail-archive` ("Library"), `rail-memory`, `rail-notes`, `rail-skills`, `rail-tasks`, `rail-theme`, `rail-settings`.
13. **Observed.** A collapsible sidebar holds New Chat, Search (Ctrl+K), a chat list with sort, AI sort into folders, bulk select/archive/delete, and an email section. `static/index.html:784-870` `title="Use AI to organize chats into folders"`, `id="session-bulk-archive"`.
14. **Observed.** Settings has 13 tabs. `static/index.html:1513+` `data-settings-tab=` values: services, added-models, ai, search, integrations, email, reminders, appearance, shortcuts, account, tools, users, system.
15. **Observed.** On first boot without a TTY, an admin account is created with a random password. `setup.py:117-119` "Non-interactive (Docker, CI) — fall back to generated password ... `secrets.token_urlsafe(18)`".
16. **Observed.** The admin password can be pre-seeded by env. `.env.example:116-118` "pre-seed the first admin password ... `# ODYSSEUS_ADMIN_PASSWORD=change_me_before_first_boot`".
17. **Observed.** First-run provider setup happens inside the chat as a typed `/setup` wizard. `static/js/slashCommands.js:5094` `async function _cmdSetup(args, ctx) {`; `:5122` "Paste your ${provider.name} API key, or run `/setup ${_slug} <api-key>`".
18. **Observed.** Pasting a bare API key auto-detects the provider by key prefix. `static/js/slashCommands.js:41-48` `{ re: /^sk-ant-/, name: 'Anthropic', ...}`, `/^sk-or-/` OpenRouter, `/^sk-proj-/` OpenAI, `/^gsk_/` Groq, `/^AIza/` Gemini, `/^xai-/`, `/^nvapi-/`.
19. **Observed.** The setup wizard also supports device-login providers (GitHub Copilot, ChatGPT subscription). `static/js/slashCommands.js:65-67` `{ key: 'chatgpt-subscription', name: 'ChatGPT Subscription', aliases: [... 'codex'] ...}`.
20. **Observed.** The Settings add-provider form is a combo of logo picker plus free Base URL plus key field. `static/index.html:2365` `placeholder="Base URL or pick provider"`; `:2396` `placeholder="API key, e.g. sk-proj-AbCdEf…"`.
21. **Observed.** "Added Models" lists endpoints split into Local and API groups, with "Probe" (re-test all) and "Clear offline". `static/index.html:2424` "Endpoints you've connected. Probe re-tests them all; Clear offline removes the dead ones."
22. **Observed.** The empty-model case is reported in plain language. `static/js/slashCommands.js:719` "Endpoint saved, but no models were found. Check the provider, key, or service status".

## 3. Provider and model layer

23. **Observed.** A provider is one `ModelEndpoint` row (base URL, encrypted key, cached/hidden/pinned models, kind, refresh policy, tool support, owner). See "Provider definition" below. `core/database.py:559-596`.
24. **Observed.** 19 presets plus "Custom URL" ship in the picker. `static/index.html:2373-2393` "Anthropic, DeepSeek (selected), OpenAI, GitHub Copilot, ChatGPT Subscription, Featherless.ai, OpenRouter, Ollama Cloud, Groq, Mistral, Together AI, Fireworks AI, Google Gemini, xAI Grok, Z.AI, OpenCode Zen, OpenCode Go, Z.AI Coding Plan, NVIDIA".
25. **Observed.** Provider identity is derived from the URL host, defaulting to OpenAI-compatible. `src/llm_core.py:1069-1108` "Unknown hosts fall back to the OpenAI-compatible default ... `return "openai"`".
26. **Observed.** Host matching is exact or subdomain, to avoid look-alike hosts. `src/llm_core.py:1072-1075` "a look-alike host such as ``anthropic.com.example`` — is not misclassified."
27. **Observed.** Only Anthropic gets a full request/response adapter; others are OpenAI chat-completions with quirks. `src/llm_core.py:1822-1823` `def _build_anthropic_payload(...)`: "Convert OpenAI-style messages to Anthropic format."
28. **Observed.** Anthropic auth is translated from Bearer to `x-api-key` plus a pinned version header. `src/llm_core.py:1909-1911` "Convert Bearer auth to x-api-key for Anthropic. ... `"anthropic-version": "2023-06-01"`".
29. **Observed.** Ollama native API has its own payload builder and URL normalizer. `src/llm_core.py:834` `def _build_ollama_payload(`; `:720` `def _normalize_ollama_url`.
30. **Observed.** ChatGPT subscription goes to the Codex Responses backend, not the public API. `src/chatgpt_subscription.py:23-26` `"https://chatgpt.com/backend-api/codex"`; `src/llm_core.py:1531` `def _build_chatgpt_responses_payload(`.
31. **Observed.** ChatGPT subscription login reuses the Codex CLI's OAuth client id with device authorization. `src/chatgpt_subscription.py:38` `CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`; `:323-326` `deviceauth/usercode`.
32. **Inferred.** That client id belongs to OpenAI's Codex CLI, so this path borrows another app's identity (terms-of-service risk). Evidence: the module says it "Mirrors openai/codex ``backend-client``" at `src/chatgpt_subscription.py:32-33`.
33. **Observed.** ChatGPT subscription usage windows are read from a private endpoint and cached 45 s. `src/chatgpt_subscription.py:34-36` `CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"`, `CHATGPT_USAGE_CACHE_TTL_SECONDS = 45.0`.
34. **Observed.** GitHub Copilot uses a device flow with an overridable client id. `src/copilot.py:34-35` `COPILOT_CLIENT_ID = os.environ.get("ODYSSEUS_COPILOT_CLIENT_ID", "01ab8ac9400c4e429b23"`.
35. **Observed.** OAuth/refresh credentials live in a separate encrypted table. `core/database.py:598-610` `class ProviderAuthSession ... access_token = Column(EncryptedText ... refresh_token = Column(EncryptedText`.
36. **Observed.** Per-provider headers are injected (OpenRouter attribution, Kimi Code User-Agent). `src/endpoint_resolver.py:432-436` `headers.setdefault("X-OpenRouter-Title", "Odysseus")`; `headers.setdefault("User-Agent", KIMI_CODE_USER_AGENT)`.
37. **Observed.** Model discovery calls `/models` and accepts both `{data:[...]}` and bare lists, plus Ollama `models[].name`. `src/llm_core.py:2229-2237` "Some OpenAI-compatible APIs (e.g. Together) return a bare list here."
38. **Observed.** Anthropic models are a hard-coded list rather than discovered. `src/llm_core.py:2214-2215` `if provider == "anthropic": return list(ANTHROPIC_MODELS)`; list at `:657-661` (stops at Claude 4.5).
39. **Observed.** Discovered model ids are cached on the row; failed models are hidden; admins can pin ids the server does not list. `core/database.py:568-570` "JSON list of model IDs that failed probing ... last-known model IDs (avoids probe on list) ... admin-pinned model IDs".
40. **Observed.** Model refresh is "auto" (background with TTL/backoff) or manual, with interval clamped 30 s to 1 day. `core/database.py:575-579`; `routes/model_routes.py:178-179` `_parse_positive_int(model_refresh_interval, minimum=30, maximum=86400)`.
41. **Observed.** The LAN is scanned for local model servers on well-known ports. `src/model_discovery.py:221` `ports = list(range(8000, 8021)) + [8080, 1234, 11434, 11435]`, 50 worker threads.
42. **Observed.** Hostnames that fail DNS are resolved through `tailscale status --json`. `src/endpoint_resolver.py:198-214` "Try to resolve a hostname via 'tailscale status' if DNS fails."; `routes/model_routes.py:2158-2160` "Resolve hostname via Tailscale if DNS fails".
43. **Observed.** Capabilities are a normalized vocabulary with a recorded source and confidence. `src/model_capabilities.py:58-76` `CAP_VISION ... CAP_REASONING ... CAP_TOOL_CALL ... CAP_STREAMING ... CAP_IMAGE_GENERATION`; `:102-110` sources `admin_override`, `provider_reader`, `models_dev_registry`, `heuristic`, `capability_probe`.
44. **Observed.** Vendor readers map provider metadata to capabilities without guessing from model names. `src/model_capability_readers/base.py:3-6` "must not infer authoritative capability from model IDs, names, display names"; readers: openai, openrouter, google, ollama, lmstudio, llamacpp, generic_openai.
45. **Observed.** OpenRouter `supported_parameters` such as `reasoning` map to the reasoning capability. `src/model_capability_readers/openrouter.py:40-42` `"reasoning": mc.CAP_REASONING, "reasoning_effort": ...`.
46. **Observed.** Tool support per endpoint is tri-state; null falls back to a model-name heuristic. `core/database.py:580-585` "NULL = unknown, falls back to the model-name keyword heuristic in agent_loop.py."
47. **Observed.** A single "thinking" switch is translated per provider (OpenRouter `reasoning`, Kimi `thinking`). `src/llm_core.py:1242-1248` `payload["reasoning"] = {"enabled": True} if mode == "on" else {"effort": "none"}`.
48. **Observed.** Request shaping knows model quirks: `max_completion_tokens` for o-series/GPT-5, temperature omitted where rejected. `src/llm_core.py:1639` `_MAX_COMPLETION_TOKENS_MODELS = {"o1", "o3", "o4", "gpt-4.5", "gpt-5"}`; `:1679` `def _omit_temperature(`; `:1691` `def _anthropic_rejects_temperature(`.
49. **Observed.** Defaults: temperature 1.0, max tokens 32768, 3 retries, 300 s stream read, 10 s connect. `src/llm_core.py:180-195`.
50. **Observed.** Non-streaming calls retry on 429/502/503/504 with a fixed 0.5 s delay (no backoff, no Retry-After). `src/llm_core.py:2797-2799` `if r.status_code in (429, 502, 503, 504) and attempt < max_retries: await asyncio.sleep(LLMConfig.RETRY_DELAY)`.
51. **Observed.** A dead-host breaker cools an upstream for 20 s after 2 consecutive connect failures. `src/llm_core.py:294-295` `DEAD_HOST_COOLDOWN = 20.0`, `_HOST_FAIL_THRESHOLD = 2`.
52. **Observed.** Upstream errors become one readable sentence per status. `src/llm_core.py:1623-1633` "{provider} rejected the API key ... Check Model Endpoints → {} and re-paste the key." / "rate-limited the request (429)" / "is having an outage (HTTP {status})".
53. **Observed.** Calls can fall back along an ordered candidate chain (primary, then others). `src/llm_core.py:2460-2466` "`candidates` is a list of (url, model, headers). The first one that returns without an exception wins."
54. **Observed.** Local streaming endpoints get a first-token watchdog (default 60 s). `src/llm_core.py:214-233` "A provider can accept a request with HTTP 200 and then never emit an SSE event."
55. **Observed.** A guard stops runaway repeated-token output from local models. `src/llm_core.py:428-436` "Some self-hosted models fail by repeating one token forever".
56. **Observed.** One shared HTTP client keeps connections warm (100 max, 30 keep-alive). `src/llm_core.py:607-611` "repeat calls ... skip the 100-500ms TCP+TLS handshake."
57. **Observed.** Responses can be cached, keyed by endpoint and credential identity. `src/llm_core.py:255-259` "Generate a cache key partitioned by endpoint and credential identity."
58. **Observed.** Rate limiting exists for login, signup and setup only, not for LLM calls. `routes/auth_routes.py:125-127` `RateLimiter(max_requests=15, window_seconds=60)`.
59. **Inferred.** The "API (direct) browser→provider" connection mode is a label, not a browser-direct path: the CSP forbids the browser from contacting other hosts and the backend uses the kind only for cost tracking and refresh policy. `static/index.html:2350-2351` "API (direct) ... browser→provider"; `core/middleware.py:148` `"connect-src 'self'; "`; `src/endpoint_resolver.py:55-56` `if kind in {"api", "proxy"}: return True`.

## 4. Chat behavior

60. **Observed.** A session stores endpoint, model, folder, mode, thinking mode, temperature/max-token overrides, memory/skill toggles, and token/cost totals. `core/database.py:177-238` `thinking_mode = Column(String ... default="off")`, `total_cost_usd = Column(Float`, `mode = Column(String ...)  # 'agent', 'chat', or 'research'`.
61. **Observed.** Messages are flat rows (role, content, JSON metadata, timestamp); no tree. `core/database.py:277-299` `role = Column(String`, `content = Column(Text`, `meta_data = Column("metadata", Text`.
62. **Observed.** Branching is done by fork (copy the first N messages into a new session). `routes/history/history_routes.py:821-823` "Create a new session with messages copied up to keep_count."
63. **Observed.** Assistant messages offer copy, edit, regenerate from here, rewrite shorter, explain simpler, fork, delete. `static/js/chatRenderer.js:2309-2336` `title: 'Regenerate from here'`, `'Rewrite shorter'`, `'Explain simpler'`, `'Fork conversation'`.
64. **Observed.** History supports truncate, edit-message, delete-messages, mark-stopped and merge-last-assistant. `routes/history/history_routes.py:402-727` `@router.post("/api/session/{session_id}/truncate")`, `/edit-message`, `/merge-last-assistant`.
65. **Observed.** Streaming is SSE (server-sent events, one-way HTTP push) with `data: {"delta": ...}` frames and a `thinking` flag for reasoning text. `src/llm_core.py:418-422` `payload = {"delta": text}; if thinking: payload["thinking"] = True`.
66. **Observed.** The client handles about 40 typed stream events, including tool_start/output, agent_step, metrics, model_actual, fallback, message_saved, context_trimmed, plan_update. Event names counted in `static/js/chat.js` (pattern `.type === '<name>'`).
67. **Observed.** Runs are detached from the connection: closing the tab does not stop generation, and reconnect replays the buffer then streams live. `src/agent_runs.py:3-12` "Keeps an agent/chat stream running server-side after the SSE client disconnects ... Reconnecting mid-run replays the buffer + streams live".
68. **Observed.** Detached runs live in memory only and are evicted 180 s after finishing. `src/agent_runs.py:14-15` "It does NOT survive a server restart."; `:48` `_EVICT_GRACE_S = 180`.
69. **Observed.** Resume, stop and status are explicit endpoints, keyed by a run id header. `routes/chat_routes.py:5009-5047` `@router.get("/api/chat/resume/{session_id}")`, `"X-Odysseus-Run-Id": _active_run.run_id`, `@router.post("/api/chat/stop/{session_id}")`.
70. **Observed.** Markdown is a hand-written renderer, with Mermaid and KaTeX lazy-loaded on first use. `static/js/markdown.js:881` `export function mdToHtml(src, opts)`; `:13-15` "Mermaid and KaTeX are vendored under /static/lib and fetched on first use."
71. **Observed.** Code highlighting uses vendored highlight.js. `static/lib/highlight.min.js` (listing of `static/lib`).
72. **Observed.** Mermaid runs with `securityLevel: 'loose'`. `static/js/markdown.js:91` `window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' })`.
73. **Observed.** Chat uploads default to 10 MB and accept office/PDF/ebook types. `src/upload_limits.py:7` `DEFAULT_CHAT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024`; `src/upload_handler.py:378` `'.pdf', '.doc', '.docx', '.xlsx', '.pptx', '.xls', '.epub'`.
74. **Observed.** System prompts come from presets and from "crew members" (personas with model, tools, greeting, timezone). `src/preset_manager.py:14` `"system_prompt": """You are a code analyzer.`; `core/database.py:748-764` `personality = Column(Text ...)  # system prompt`.
75. **Observed.** Export supports md, txt, json and html. `routes/session_routes.py:1056-1060` "Supported formats: md (markdown), txt (plain text), json, html".
76. **Observed.** Long chats can be compacted (summarized) on demand. `routes/session_routes.py:1218` `@router.post("/session/{session_id}/compact")`.
77. **Observed.** History is loaded in pages of 12 messages. `static/js/chat.js:6657` `/api/history/${...}?limit=12`.

## 5. Agent and tool features

78. **Observed.** The agent has 88 built-in function tools, including bash, python, web_search, web_fetch, file read/write/edit/apply_patch, email, calendar, notes, model serving, image generation and research. `src/tool_schemas.py:287` `FUNCTION_TOOL_SCHEMAS = [`; names from `:291` "bash" to `:1770` "unsubscribe_email".
79. **Observed.** The bash tool is described as full-access. `src/tool_schemas.py:292` "Run a shell command (full access)."
80. **Observed.** Tools that write or act need an approval, sealed server-side, scoped to once, task or chat session, expiring in 10 minutes. `src/tool_approvals.py:1-6` "Opaque exact-action approvals with explicit task and chat scopes."; `:39` `DEFAULT_APPROVAL_TTL_SECONDS = 10 * 60`.
81. **Observed.** Process execution goes through a containment layer that reports which limits were actually enforced. `src/containment.py:15-18` "Truthful reporting. A grant states which dimensions are actually enforced".
82. **Observed.** MCP servers are configurable over stdio, SSE or HTTP, with per-tool disable and encrypted OAuth tokens. `core/database.py:618-627` `transport ... # "stdio" or "sse"`, `disabled_tools`, `oauth_tokens = Column(EncryptedText`; `src/mcp_manager.py:195` `elif transport == "http":`.
83. **Observed.** Web search providers include SearXNG, Brave, DuckDuckGo, Tavily, Google PSE and Serper. `services/search/providers.py:21-25`, `:104`.
84. **Observed.** A "TUI host bridge" lets an external terminal client execute shell, file and patch tools on its own host. `src/client_tool_contract.py:1-12` "tools supplied by the Odysseus TUI host bridge" `"bash", "python", "grep", ... "apply_patch", "host_shell"`.
85. **Observed.** The bridge is only honored for surface `odysseus-tui`, plain-HTTP private or loopback URLs, and a shared token header. `src/tool_execution.py:149` `!= "odysseus-tui"`; `:183` `headers={"x-odysseus-tui-bridge-token": token}`; `src/agent_tools/subprocess_tools.py:203-218` `if parsed.scheme != "http" ... _is_private_bridge_ip(host)`.
86. **Unknown.** The TUI client itself is not in this repo; only its contract and server side are.
87. **Observed.** Odysseus does not drive Codex or Claude Code; the reverse is true: it exposes scoped HTTP APIs and a downloadable plugin so those agents can read and write Odysseus data. `routes/codex_routes.py:1-5` "small HTTP surfaces intended for the Codex plugin/MCP bridge"; `integrations/codex/README.md:7-10` "Add a Codex Agent ... Copy the full setup commands".
88. **Observed.** Cookbook can launch model servers on remote machines over SSH inside tmux, with host and port validated against injection. `routes/cookbook_routes.py:1375` `f"ssh {_spf}{remote} {shlex.quote(_remote_tmux_launch_command(...))}"`; `routes/codex_routes.py:46-47` "A tampered entry with shell metacharacters in ``remoteHost`` is rejected".
89. **Observed.** A "private browser" tool is declared but page actions are disabled. `src/tool_schemas.py:396` "Page/document operations are unavailable because the local producer cannot atomically bind a captured target."
90. **Observed.** The agent can escalate to a stronger "teacher" model and can change app settings itself. `src/tool_schemas.py:1136` `"name": "ask_teacher"`; `src/agent_loop.py:8060` "manage_settings — View/change the REAL app settings".
91. **Observed.** Agent limits are user settings: tool call limit and max steps per message (default 20). `static/index.html:2462-2466` "Tool call limit ... Max steps per message ... placeholder="20"".

## 6. Storage, auth and security

92. **Observed.** Provider keys, OAuth tokens and MCP tokens are Fernet-encrypted columns in SQLite. `core/database.py:152-160` "Text column transparently encrypted at rest ... Protects the SQLite file at rest (stolen backup / leaked image), not a live process that can read the key."
93. **Observed.** The encryption key is a file next to the data, mode 0600. `src/secret_storage.py:5-7` "The key lives at `data/.app_key`, mode 0o600, generated on first call."
94. **Observed.** Users and password hashes live in `data/auth.json` with bcrypt. `setup.py:121-131` `hashed = bcrypt.hashpw(...)`; `companion/pairing.py:163` "Resolve an admin username from data/auth.json".
95. **Observed.** TOTP two-factor login is supported. `core/auth.py:17` `import pyotp`; `:493` "TOTP two-factor authentication".
96. **Observed.** API tokens are `ody_` plus 32 random bytes; only a bcrypt hash and 8-char prefix are stored. `companion/pairing.py:185-192` "The raw token is returned ONCE -- only its bcrypt hash + an 8-char prefix are persisted."
97. **Observed.** Tokens carry scopes (chat, todos, documents, email read/draft/send, calendar, memory, cookbook). `routes/api_token_routes.py:15-30` `ALLOWED_SCOPES = {"chat", "todos:read", ... "cookbook:launch"}`.
98. **Observed.** Bearer callers run as a sandboxed pseudo-user, and chat streaming requires the chat scope. `app.py:461-466` `request.state.current_user = "api"`; `routes/chat_routes.py:2470` `require_api_token_scope(request, "chat")`.
99. **Observed.** Paired clients act as the token's owner so they see the same chats as the desktop. `src/auth_helpers.py:42-47` "so a paired client sees and creates the SAME data as the owner's desktop UI".
100. **Observed.** Headers: CSP with nonce and `connect-src 'self'`, X-Frame-Options DENY, HSTS on HTTPS, microphone allowed for self only. `core/middleware.py:105` `"camera=(), microphone=(self), geolocation=()"`; `:111-112` HSTS; `:141-149` CSP.
101. **Observed.** CORS defaults to localhost origins with credentials. `app.py:138-142` `os.getenv("ALLOWED_ORIGINS", "http://localhost,http://127.0.0.1")`, `allow_credentials=True`.
102. **Observed.** The docs recommend auth on and localhost bypass off for any network deployment. `README.md` Security: "Keep `AUTH_ENABLED=true` ... Keep `LOCALHOST_BYPASS=false` outside local development."
103. **Observed.** No analytics or crash-reporting SDK is present. Search for posthog, sentry_sdk, mixpanel, segment, google-analytics in `src routes core static/js app.py` returned no files.
104. **Observed.** Extra TLS roots can be added for providers, but verification stays on. `.env.example:35-44` "Layered ON TOP of the system / certifi bundle — verification stays on for every host".
105. **Observed.** A threat model and security policy are written down. Files `THREAT_MODEL.md`, `SECURITY.md`, `.gitleaks.toml`.
106. **Unknown.** iOS-specific items (Keychain, ATS exceptions, local network permission) do not apply; there is no iOS code here.

## 7. Phone pairing, notifications, background

107. **Observed.** A companion API lets a phone check health, read server capabilities and list the owner's models without keys. `companion/README.md:7-13` table `/api/companion/ping`, `/info`, `/models`, `/pair`; `companion/routes.py:117-118` "Read-only; never returns api_key material."
108. **Observed.** Server capabilities advertised to the phone are only chat and streaming. `companion/routes.py:106` `"capabilities": {"chat": True, "streaming": True}`.
109. **Observed.** Pairing mints a one-time chat-scoped token and shows it as a QR of `{v, host, port, token}`. `companion/pairing.py:208-210` `return {"v": PAIRING_VERSION, "host": host, "port": port, "token": token}`.
110. **Observed.** Minting is admin-cookie only and POST-only, to resist cross-site request forgery. `companion/routes.py:12-17` "minting happens ONLY on POST. The session cookie is SameSite=Lax".
111. **Observed.** The pairing host must be plain HTTP on a private, Tailscale-range (100.64/10), loopback or `.local` address. `companion/pairing.py:26-36` `"100.64.0.0/10"`; `:96` `if parsed.scheme.lower() != "http"`.
112. **Observed.** Single-label numeric hostnames are rejected because a URL parser would turn them into a public IP and leak the token. `companion/pairing.py:53-62` "accepting e.g. ``134744072`` would make the phone send its bearer token to public 8.8.8.8."
113. **Observed.** The server guesses its LAN IP with a UDP-connect trick unless `COMPANION_BASE_URL` is set. `companion/pairing.py:131-146` "The UDP-connect trick reveals the egress interface ... No packets are actually sent."
114. **Observed.** Revocation is manual under Settings → API tokens. `companion/routes.py:259-261` "revoke it in Settings &rarr; API tokens".
115. **Observed.** Browser notifications fire when a background response finishes in a hidden tab or other chat. `static/js/chatStream.js:277-286` `new Notification('Response Complete', { body: ..., tag: 'stream-' + sessionId })`.
116. **Observed.** Reminders can go to browser, email, ntfy (a self-hosted push service) or webhook. `src/builtin_actions.py:3166-3173` `channel == "email" ... "ntfy" ... "webhook"`.
117. **Observed.** The service worker caches the app shell for offline but never caches API calls; it has no push handler. `static/sw.js:2-8` "API / non-GET: never cached."; listeners only for install/activate/fetch at `:292-317`.
118. **Observed.** Scheduled agent tasks run on the server. `core/database.py:772` `class ScheduledTask`; `:853` `class TaskRun`.
119. **Unknown.** Widgets, Live Activities, Shortcuts and deep links: none exist (web app only).

## 8. Quality signals

120. **Observed.** About 1,321 Python test files and 45 JS tests, organized by a marker taxonomy. `pyproject.toml` markers `area_security`, `area_routes`, `slow`.
121. **Observed.** CI runs syntax checks, a frontend architecture test, sharded pytest with Playwright Chromium, CodeQL, Trivy, secret scan and dependency review. `.github/workflows/ci.yml:83` `python -m compileall`; `:109` `node --test tests/frontendArchitecture.test.mjs`; `:249` `pytest ... --shard`; workflow files `codeql.yml`, `container-trivy.yml`, `secret-scan.yml`.
122. **Observed.** No linter or type checker is configured (no ruff, mypy, eslint or tsconfig at the root). Root listing; `requirements-dev.txt` adds only `pytest-xdist`.
123. **Observed.** The code is very large in single files. `src/agent_loop.py` 38,039 lines; `static/js/chat.js` 8,233; `routes/chat_routes.py` 5,214.
124. **Observed.** The CSS cascade is fragile by its own admission. `static/css/00-tokens.css:9-11` "with 1,151 redeclarations and 1,886 !important in this cascade, either can change which declaration wins."
125. **Observed.** Accessibility is retrofitted: clickable divs are made focusable at runtime. `static/js/a11y.js:3-8` "primary controls in Odysseus are authored as click-only <div>s ... keyboard and screen-reader users cannot reach or operate them."
126. **Observed.** No UI localization framework; all strings are inline English. Search for i18n/gettext/locale in `static/js` and `src` found only unrelated hits.
127. **Observed.** Performance tricks: gzip for non-stream responses, lazy Mermaid/KaTeX, warm HTTP pool, paged history. `app.py:157-166` "Starlette's GZipMiddleware excludes `text/event-stream`"; items 56, 70, 77.
128. **Unknown.** No list virtualization was found in the chat renderer (search for IntersectionObserver, content-visibility, virtual in chat files returned nothing).

## 9. Design system

129. **Observed.** Theming is CSS variables with 19 built-in palettes and up to 8 custom themes. `static/js/theme.js:11-16` `dark: { bg:'#282c34', fg:'#9cdef2', ...}`; `:55` `const MAX_CUSTOM_THEMES = 8;`.
130. **Observed.** Each theme has an animated background pattern (rain, embers, starfield, petals, perlin flow, ASCII fireflies). `static/js/theme.js:58-75` `midnight: 'rain', retrowave: 'embers', ocean: 'starfield-depth'`.
131. **Observed.** Default look is a dark terminal palette. `static/css/00-tokens.css:34-39` `--bg: #282c34; --fg: #9cdef2;`.
132. **Observed.** Setup replies use a typewriter effect. `static/js/slashCommands.js:719` `await typewriterReply(...)`.
133. **Observed.** Haptics are a 15 ms vibrate on drag actions. `static/js/modalManager.js:708` `navigator.vibrate(15)`.
134. **Observed.** Some areas respect reduced motion. `static/css/08-skills.css:717` `@media (prefers-reduced-motion: reduce)`.
135. **Inferred.** The polish comes from breadth and small touches (provider logos, key-prefix detection, plain-language errors, live probe status) rather than from a coherent component system: icons are inline SVG in HTML and styles are mostly inline. Evidence: `static/index.html:2360-2400` inline `style=` on nearly every element.

## Screens and flows

| Screen or flow | How it works | Evidence |
|---|---|---|
| First boot | Admin account with random password (Docker) or prompt (TTY); login page | `setup.py:113-119`; `static/login.html` |
| Add provider (chat) | `/setup <provider> <key>` or paste a key; prefix detection | `static/js/slashCommands.js:41-48, 5094-5123` |
| Add provider (settings) | Logo picker or custom base URL, key, Add; probes models | `static/index.html:2360-2400`; `routes/model_routes.py:2133` |
| Device-login provider | Copilot or ChatGPT subscription device code | `src/chatgpt_subscription.py:323`; `src/copilot.py:157` |
| Model list | Added Models, grouped Local and API, Probe, Clear offline | `static/index.html:2410-2430` |
| Start chat | New Chat (rail or sidebar); pick model; stream | `static/index.html:788-794`; `routes/chat_routes.py:2468` |
| Message actions | copy, edit, regenerate, shorter, simpler, fork, delete | `static/js/chatRenderer.js:2309-2336` |
| Leave and return | run continues; reconnect replays via resume | `routes/chat_routes.py:5009` |
| Tool approval | sealed approval card; once, task or chat scope | `src/tool_approvals.py:1-6` |
| Pair phone | Settings or `/api/companion/pair`; QR; one-time token | `companion/routes.py:168-263` |
| Settings | 13 tabs from services to system | `static/index.html:1513` |
| Other apps | Documents, Calendar, Compare, Cookbook, Research, Email, Gallery, Library, Memory, Notes, Skills, Tasks | `static/index.html:764-781` |

Takeaway: the chat and provider flows are small and copyable; the rest of the app is a broad web suite we do not need.

## Provider definition (code level)

`core/database.py:559-596`, quoted:

```python
class ModelEndpoint(TimestampMixin, Base):
    """Admin-configured model endpoints. Models are auto-discovered via /v1/models."""
    __tablename__ = "model_endpoints"
    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)          # Display label, e.g. "Local vLLM", "OpenRouter"
    base_url = Column(String, nullable=False)      # Base URL, e.g. "http://localhost:8002/v1"
    api_key = Column(EncryptedText, nullable=True)  # Optional provider API key, encrypted at rest
    is_enabled = Column(Boolean, default=True)
    hidden_models = Column(Text, nullable=True)    # JSON list of model IDs that failed probing
    cached_models = Column(Text, nullable=True)    # JSON list of last-known model IDs (avoids probe on list)
    pinned_models = Column(Text, nullable=True)    # JSON list of admin-pinned model IDs (manual, may not appear in /v1/models)
    model_type = Column(String, nullable=True, default="llm")  # "llm" or "image"
    endpoint_kind = Column(String, nullable=True, default="auto")
    model_refresh_mode = Column(String, nullable=True, default="auto")
    model_refresh_interval = Column(Integer, nullable=True, default=None)
    model_refresh_timeout = Column(Integer, nullable=True, default=None)
    supports_tools = Column(Boolean, nullable=True, default=None)
    model_tool_modes = Column(Text, nullable=True)
    owner = Column(String, nullable=True, index=True)
    provider_auth_id = Column(String, nullable=True, index=True)
```

How the pieces combine:
- **No provider type field.** The adapter is chosen at call time from the URL host (`src/llm_core.py:1069-1108`); the result is one of `ollama, anthropic, opencode-go, opencode-zen, openrouter, groq, nvidia, kimi-code, moonshot, chatgpt-subscription, copilot, featherless, cerebras, mistral, openai`.
- **Auth headers** come from `build_headers(api_key, base)` (`src/endpoint_resolver.py:415-437`): Anthropic `x-api-key` plus version, Copilot and ChatGPT special headers, otherwise `Authorization: Bearer`.
- **URLs** are derived: `build_chat_url(base)` and `build_models_url(base)` (`src/endpoint_resolver.py:368, 383`).
- **Presets** are only `{label, base_url, logo, optional auth flow}` in HTML (`static/index.html:2373-2393`) and JS (`static/js/slashCommands.js:50-63`); there is no preset schema.
- **Capabilities** live in a separate record, `ModelCapability(family, primary_task, modalities, capabilities, limits, source, confidence)` (`src/model_capabilities.py:476-483`).
- **Endpoint creation form fields:** `name, base_url, api_key, skip_probe, require_models, model_type, endpoint_kind, model_refresh_mode/interval/timeout, supports_tools, pinned_models, container_local, shared` (`routes/model_routes.py:2134-2152`).

## Open questions

1. Is the Expo companion app public, and what screens does it have? Only its address contract is in this repo (`companion/pairing.py:41`).
2. Does the companion chat through `/api/chat_stream` with the bearer token? The scope check (`routes/chat_routes.py:2470`) and owner mapping (`src/auth_helpers.py:42-47`) suggest yes, but no client code confirms it.
3. Where is the Odysseus TUI client, and how does it get its bridge token to the server? Only the server side exists here.
4. Is reusing the Codex CLI OAuth client id permitted by OpenAI? Item 32.
5. How does `endpoint_kind = "api"` differ in behavior from "proxy" beyond cost tracking and refresh mode? Item 59.

## Implications for Nano Remote: copy / adapt / avoid

Copy (ideas only, because AGPL forbids copying the code):
- One provider record = base URL + key + cached/hidden/pinned model ids; choose the adapter from the URL host; default to OpenAI-compatible.
- Key-prefix detection on paste (`sk-ant-`, `sk-or-`, `sk-proj-`, `gsk_`, `AIza`, `xai-`, `nvapi-`).
- A preset list that is only label, URL and logo, plus a "Custom URL" entry.
- Plain-language error sentences per HTTP status, naming the provider and the fix.
- Capability records with source and confidence; never infer from model names when metadata exists.
- Run ids and resumable streams: the server keeps running when the phone disconnects, and the phone replays on return.
- QR pairing that carries a versioned `{v, host, port, token}`, a one-time scoped token, and strict host validation including the Tailscale range.

Adapt:
- Pairing should require HTTPS or Tailscale identity rather than plain HTTP with a bearer token.
- Retries should use exponential backoff and honor `Retry-After`; Odysseus uses a fixed 0.5 s delay.
- Keep keys in the iOS Keychain, not in an encrypted file whose key sits next to it.
- Replace "regenerate" plus "fork" with real message branches if we want ChatGPT-style editing.
- Tool approvals with once / this task / this chat scopes map well to approving agent actions on the Mac.

Avoid:
- Borrowing another vendor's OAuth client id (ChatGPT subscription, Copilot).
- A hard-coded, outdated Anthropic model list; call Anthropic's models endpoint instead.
- Monolith files, an `!important`-heavy cascade, and retrofitted accessibility.
- Mermaid `securityLevel: 'loose'` for model output.
- In-memory-only run buffers if the Mac agent may restart; persist the event log.
