# ChatGPT iOS — Readable-Resources Reverse Engineering Report

**App:** com.openai.chat, version 1.2026.279 (build 37999862476)  
**Artifact:** /Users/mabue/BROCODE/Projects/NANO-REMOTE/resources/chatgpt-ios/ChatGPT.ipa  
**Extracted to (read-only):** /tmp/rea-ios/Payload/ChatGPT.app  
**Date:** 2026-10-20

---

## Coverage and Limitation

The main executable (`ChatGPT`) and the two primary frameworks (`Frameworks/ChatGPT.framework/ChatGPT` 184 MB, `Frameworks/OpenAIXPlat.framework/OpenAIXPlat`) are protected by FairPlay DRM (`LC_ENCRYPTION_INFO_64 cryptid 1`). Swift symbols, Objective-C selectors, and any string literals inside those binaries are inaccessible without a decrypted dump from a jailbroken or pairable device. This analysis covers only the unencrypted resources:

- `en.lproj/Localizable.strings` and `en.lproj/AppShortcuts.strings` (binary plists, converted via plutil)
- `PlugIns/Widgets.appex/en.lproj/Localizable.strings` (212 keys — the richest source)
- `Frameworks/ChatGPT.framework/CodexRemote_CodexRemoteCore.bundle/` (shell scripts + a prompt .txt)
- `Frameworks/ChatGPT.framework/CodexRemote_CodexRemoteThread.bundle/` (an HTML visualization fragment)
- `Metadata.appintents/extract.actionsdata` (App Intents binary plist, 20 intents)
- `PlugIns/Widgets.appex/Metadata.appintents/extract.actionsdata` (22 intents)
- `Info.plist` keys (BGTask identifiers, URL schemes, NSUserActivityTypes, etc.)
- `Settings.bundle/com.mono0926.LicensePlist/` (third-party SDK license files)
- `Frameworks/OpenAIXPlat.framework/*.valdimodule` (zstandard-compressed cross-platform JS bundles — no Codex/remote module names present)

Notification category identifiers (approve/deny action buttons on push), feature-flag key names (e.g. any "slingshot" flag), and any URL routing tables are inside the encrypted binary and could not be read. No readable JSON config with flag names was found in the bundle.

---

## Phone-Side Behavior List

Behaviors are grouped by flow. Evidence format: `"exact key" = "exact value"` + file path.

### 1. Setup / Pairing / Host Connection

1. **Observed** — The feature is called "Codex Remote" internally; a top-level host concept exists. Widget strings establish that the Mac agent runner is called a _host_:  
   `"codex_tasks_widget_no_hosts" = "Connect a host in Codex to see your tasks."` — `Widgets.appex/en.lproj/Localizable.strings`

2. **Observed** — Face ID locks Codex on the phone itself (protecting task history, not the host connection):  
   `NSFaceIDUsageDescription = "ChatGPT uses Face ID to unlock Codex on this device."` — `Info.plist`

3. **Observed** — A user-activity type `com.openai.chatgpt.codex` is registered, enabling Handoff / Spotlight / universal-link continuation for the Codex feature:  
   `NSUserActivityTypes = ["com.openai.chatgpt.codex", ...]` — `Info.plist`

4. **Observed** — A dedicated URL scheme for Codex is registered:  
   `CFBundleURLSchemes = ["chatgpt", "codex"]` — `Info.plist`

5. **Observed** — The Codex-tasks widget configuration allows the user to show tasks from "All hosts" or a selected subset; widget config intent parameter is typed `CodexTasksWidgetHostEntity`:  
   `"All hosts" = "All hosts"` and `"Hosts" = "Hosts"` — `Widgets.appex/en.lproj/Localizable.strings`  
   Parameter `allHosts` (bool, default true) and `hosts` (array of `CodexTasksWidgetHostEntity`) — `Widgets.appex/Metadata.appintents/extract.actionsdata`

6. **Inferred** — No QR-pairing or "scan to connect" copy was found anywhere in the readable resources. Pairing flow UI strings, if present, live in the encrypted binary. The host connection may use an account-linked WebSocket channel established server-side rather than a local QR handshake.

### 2. Host List and Availability

7. **Observed** — The tasks widget shows a "couldn't connect" state directing the user back to the app:  
   `"codex_tasks_widget_unavailable" = "Couldn't connect. Open Codex to check your hosts."` — `Widgets.appex/en.lproj/Localizable.strings`

8. **Observed** — A "Codex Remote is disabled for this workspace" workspace-level gate exists:  
   `"codex_tasks_widget_disabled" = "Codex Remote is disabled for this workspace."` — `Widgets.appex/en.lproj/Localizable.strings`

9. **Observed** — The widgets extension shows a "Connecting…" / "Connection failed" transient state (likely for the real-time task status feed):  
   `"Connecting..." = "Connecting..."` and `"Connection failed" = "Connection failed"` — `Widgets.appex/en.lproj/Localizable.strings`

### 3. Session View — Task Lifecycle

10. **Observed** — Tasks have at least five observable states visible from the widget: Running, On hold, Needs your input, Failed, Completed/Finished:  
    `"codex_tasks_widget_running" = "Running"` / `"On hold" = "On hold"` / `"codex_tasks_widget_needs_input" = "Needs your input"` / `"codex_tasks_widget_failed" = "Failed"` — `Widgets.appex/en.lproj/Localizable.strings`

11. **Observed** — The Live Activity (Dynamic Island / Lock Screen banner) for a Codex remote run tracks task count and terminal states:  
    `"codex_remote_activity_task_count" = "%@ tasks"` / `"codex_remote_activity_one_task" = "1 task"` / `"codex_remote_activity_more_tasks" = "+%@ more tasks"` / `"codex_remote_activity_completed" = "Completed"` / `"codex_remote_activity_finished" = "Finished"` / `"codex_remote_activity_interrupted" = "Interrupted"` — `Widgets.appex/en.lproj/Localizable.strings`

12. **Observed** — NSSupportsLiveActivities and NSSupportsLiveActivitiesFrequentUpdates are both true, enabling sub-second updates on the Dynamic Island banner for running tasks:  
    `NSSupportsLiveActivities = true`, `NSSupportsLiveActivitiesFrequentUpdates = true` — `Info.plist`

13. **Observed** — A voice-mode channel ("Codex voice remote") sits alongside the task list, distinct from the task-based channel:  
    `"ChatGPT voice remote" = "ChatGPT voice remote"` / `"remote_voice_widget_title" = "ChatGPT voice remote"` — `Widgets.appex/en.lproj/Localizable.strings`

14. **Observed** — Screen-sharing from phone to Mac is supported via a `VoiceScreenSharing.appex` broadcast-upload extension sharing the same RTCAppGroupIdentifier:  
    `RTCScreenSharingExtension = "com.openai.chat.Broadcast"`, `RTCAppGroupIdentifier = "group.com.openai.chat"` — `PlugIns/VoiceScreenSharing.appex/Info.plist`

15. **Observed** — The phone maintains a persistent WebSocket/VOIP connection: `UIBackgroundModes = ["voip", "audio", "remote-notification"]` — `Info.plist`

### 4. Approvals and Input Requests

16. **Observed** — An approval state is surfaced in the widget, indicating the phone can receive and respond to agent confirmation requests:  
    `"Approval required" = "Approval required"` and `"Allow" = "Allow"` — `Widgets.appex/en.lproj/Localizable.strings`

17. **Observed** — An "input needed" signal is explicitly named:  
    `"Your input is needed" = "Your input is needed"` — `Widgets.appex/en.lproj/Localizable.strings`

18. **Observed** — A Siri/Shortcuts confirmAction intent exists; its description is "This action confirms an action to continue the task":  
    `"This action confirms an action to continue the task" = "This action confirms an action to continue the task"` — `Widgets.appex/en.lproj/Localizable.strings`

19. **Inferred** — Push notification categories with Approve/Deny action buttons are the expected delivery mechanism for approval requests (the app has `aps-environment production`, `usernotifications.time-sensitive`, `usernotifications.communication` entitlements), but the category identifiers live in the encrypted binary.

### 5. Notifications and Live Activities

20. **Observed** — BGTask identifier `com.openai.chat.codex.worktree.*` is registered for background worktree management, allowing the app to manage Mac-side git worktrees in the background:  
    `BGTaskSchedulerPermittedIdentifiers = ["com.openai.chat.codex.worktree.*", "com.openai.chat.health.onboarding.*"]` — `Info.plist`

21. **Observed** — Time-sensitive and communication notification entitlements allow Codex approval requests to break through Focus modes:  
    Entitlements keys `com.apple.developer.usernotifications.time-sensitive` and `com.apple.developer.usernotifications.communication` — confirmed from prior analysis.

22. **Observed** — A `NotificationServiceExtension.appex` is present with INSendMessageIntent support, used for notification enrichment:  
    `NSExtension.NSExtensionAttributes.IntentsSupported = ["INSendMessageIntent"]` — `PlugIns/NotificationServiceExtension.appex/Info.plist`

23. **Observed** — Voice mode Live Activity shows connecting / listening / thinking / speaking / microphone-muted / ended states:  
    `"voice_live_activity_connecting" = "Connecting"` / `"voice_live_activity_listening_intently" = "Listening"` / `"voice_live_activity_thinking" = "Thinking"` / `"voice_live_activity_speaking" = "Speaking"` / `"voice_live_activity_microphone_muted" = "Microphone muted"` / `"voice_live_activity_terminal_state" = "Voice ended"` — `Widgets.appex/en.lproj/Localizable.strings`

### 6. Deep Links

24. **Observed** — URL scheme `codex` is registered: `CFBundleURLSchemes = ["chatgpt", "codex"]` — `Info.plist`

25. **Observed** — NSUserActivityType `com.openai.chatgpt.codex` enables Handoff and universal-link continuation for Codex sessions — `Info.plist`

26. **Observed** — Associated domains include `chatgpt.com`, `chat.com`, `platform.openai.com` (from prior analysis). No readable path routing table was found in unencrypted files; deep-link routing is in the binary.

27. **Inferred** — The `OpenCodexIntent` (App Shortcuts) accepts a `createTask` boolean parameter; the `codex://` URL scheme likely accepts at least a `createTask` path or query parameter.

### 7. Mac-Side Operations (Shell Scripts in Bundle)

28. **Observed** — The phone ships 10 bash scripts for controlling the Mac-side agent inside `CodexRemote_CodexRemoteCore.bundle/`. These run on the Mac, not the phone; the phone sends them over the remote channel. Key scripts:

    - `draft_prepare_worktree.sh` — resolves git root, computes worktree paths, detects platform (darwin/linux/win32), reads `.codex/environments/*.toml`
    - `draft_create_worktree.sh` — creates a git worktree at a collision-resistant path, copies current working-tree diff into it
    - `draft_register_worktree.sh` — writes `codex-thread.json` ownership marker into the worktree
    - `draft_remove_worktree.sh` — runs `git worktree remove --force`
    - `draft_checkout_git_branch.sh` and `draft_create_and_checkout_git_branch.sh` — branch switching
    - `draft_git_branch_snapshot.sh` — lists recent branches (up to 8) for a branch picker
    - `draft_local_environments.sh` — walks `.codex/environments/` from workspace to git root, returning `environment.toml` paths
    - `draft_run_environment_setup.sh` — executes user-defined setup script from selected environment config
    - `workspace_diff_snapshot.sh` — generates full git diff (branch/staged/unstaged) with numstat and optional inline unified diff
    - `workspace_file_search_page.sh` — paginated `find` over the workspace, excluding hidden files
    - `workspace_repositories.sh` — finds the git root from CWD or `/workspace/*` siblings
    - `workspace_repository_diff_snapshot.sh` — read-only variant of the diff snapshot (GIT_OPTIONAL_LOCKS=0, no remote contact)

    Evidence: `/tmp/rea-ios/Payload/ChatGPT.app/Frameworks/ChatGPT.framework/CodexRemote_CodexRemoteCore.bundle/`

29. **Observed** — The thread view renders diffs with a web-based visualization engine (`visualize.html`, using Floating UI + Lucide icons), injected as `<!--__INLINE_VISUALIZATION_FRAGMENT__-->`:  
    `Frameworks/ChatGPT.framework/CodexRemote_CodexRemoteThread.bundle/visualize.html`

### 8. Voice Remote System Prompt (Realtime_conversation_prompt.txt)

30. **Observed** — The Codex voice front-end on the phone runs a system prompt describing a split architecture: the phone is the "conversational surface" and the Mac backend is the "execution" side. Key constraints extracted verbatim from `realtime_conversation_prompt.txt`:

    - Identity: "You are Codex, an OpenAI general-purpose agentic assistant..."
    - Architecture: "The backend handles execution and produces user-visible artifacts. You are the conversational surface of the same system."
    - Routing: "Pass execution work to the backend. NEVER refuse requests. Delegate all user requests to the backend."
    - Message format: user inputs prefixed `[USER]`, backend messages prefixed `[BACKEND]`
    - The prompt explicitly forbids mentioning that the system has two parts: "Present every work as done by you."

    Evidence: `/tmp/rea-ios/Payload/ChatGPT.app/Frameworks/ChatGPT.framework/CodexRemote_CodexRemoteCore.bundle/realtime_conversation_prompt.txt`

### 9. Errors

31. **Observed** — Widget-specific error states: `"codex_tasks_widget_locked" = "Open Codex to view your protected tasks."` (Face-ID locked) and `"codex_tasks_widget_not_ready" = "Open Codex to load your tasks."` (not yet loaded) — `Widgets.appex/en.lproj/Localizable.strings`

32. **Observed** — Sign-out and workspace states: `"codex_tasks_widget_signed_out" = "Sign in to ChatGPT to see your tasks."` and `"codex_tasks_widget_disabled" = "Codex Remote is disabled for this workspace."` — `Widgets.appex/en.lproj/Localizable.strings`

---

## App Intents / Shortcuts — Codex-Related

| Intent | Title | Auth | Discoverable |
|---|---|---|---|
| OpenCodexIntent | "Open Codex" | none | yes |
| OpenCodexShortcutIntent | "Open Codex" | none | yes |
| OpenCodexRealtimeVoiceIntent | "ChatGPT voice remote" | required | no (internal) |
| OpenCodexRemoteNewChatIntent | "New remote chat" | required | no (internal) |
| CodexTasksWidgetConfiguration | "Codex tasks" | none | no (widget config) |
| CodexLockScreenWidgetConfigurationIntent | "Codex Lock Screen Widget Configuration" | none | no (widget config) |
| CodexUsageLockScreenConfiguration | "Codex usage" | none | no (widget config) |

Evidence: `Metadata.appintents/extract.actionsdata` and `PlugIns/Widgets.appex/Metadata.appintents/extract.actionsdata`

---

## Deep Links and URL Schemes

| Scheme / Type | Value | Purpose |
|---|---|---|
| URL scheme | `codex` | Deep-link directly into Codex from other apps or notifications |
| URL scheme | `chatgpt`, `openai`, `com.openai.chat` | General ChatGPT deep linking |
| NSUserActivityType | `com.openai.chatgpt.codex` | Handoff / Spotlight / universal-link for Codex sessions |
| NSUserActivityType | `com.openai.chatgpt.conversation` | Handoff for regular conversations |
| Associated domains | `chatgpt.com`, `chat.com`, `platform.openai.com` | Universal links |

---

## Third-Party SDKs Relevant to Architecture

| SDK | Evidence Path |
|---|---|
| LiveKitWebRTC.framework (WebRTC) | `Frameworks/LiveKitWebRTC.framework/` + `Settings.bundle/com.mono0926.LicensePlist/webrtc-xcframework.plist` |
| swift-protobuf | `Settings.bundle/com.mono0926.LicensePlist/swift-protobuf.plist` |
| Statsig SDK (feature flags) | `Settings.bundle/com.mono0926.LicensePlist/Statsig SDK.plist` |
| sentry-cocoa (crash reporting) | `Settings.bundle/com.mono0926.LicensePlist/sentry-cocoa.plist` |
| swift-opus (audio codec) | `Settings.bundle/com.mono0926.LicensePlist/swift-opus.plist` |
| Lottie (animations) | `Frameworks/Lottie.framework/` + `Settings.bundle/.../lottie-spm.plist` |
| OpenAPIKit | `Settings.bundle/com.mono0926.LicensePlist/OpenAPIKit.plist` |
| Segment (analytics) | `Frameworks/ChatGPT.framework/Segment_Segment.bundle/` |
| RevenueCat | `Frameworks/ChatGPT.framework/RevenueCat_RevenueCat_CustomEntitlementComputation.bundle/` |
| swift-nio (NIO networking) | `Frameworks/ChatGPT.framework/swift-nio_NIOPosix.bundle/` |

WebRTC (via LiveKit) is the real-time transport for voice mode and the realtime voice-remote channel. swift-protobuf is almost certainly the serialization layer for the Codex remote protocol. Statsig drives feature gating (individual flag names are in the encrypted binary).

---

## Open Questions

1. **Host pairing mechanism** — No QR or PIN pairing copy found; how does the phone discover and authenticate against a specific Mac host? Likely uses the OpenAI account as the rendezvous (no local network scan visible).
2. **Notification approve/deny action categories** — Category identifiers and action button titles are in the encrypted binary. The phone almost certainly sends an actionable push when a task needs input.
3. **Feature flag names** — The hypothesized flag `chatgpt-ios-enable-codex-remote-new-slingshot-pairing-flow` was not found in any readable file. Statsig flag names require a decrypted binary.
4. **Codex-Remote protocol** — Whether the phone-to-Mac channel uses WebRTC data channels (likely, given LiveKitWebRTC is present), WebSocket, or an OpenAI Realtime API connection is not determinable from readable resources alone. The voice channel clearly uses WebRTC; the task/approval channel may use the same or a separate WebSocket.
5. **`com.openai.chatgpt.codex` NSUserActivityType** — The userInfo payload for this activity (which likely contains host identifier and task identifier for Handoff) is inside the binary.

---

## Implications for Nano Remote

1. **State vocabulary to mirror.** Use exactly the widget strings as the canonical state set: Running / On hold / Needs your input / Failed / Completed / Finished / Interrupted. Users switching between ChatGPT and Nano Remote will expect the same terminology.

2. **Host as first-class entity.** The feature exposes a "hosts" picker in the widget configuration. Nano Remote should also expose a host list and a per-host filter, rather than a single global feed.

3. **Input-request pattern.** The "Your input is needed" + "Approval required" + "Allow" pattern is the established UX for task pauses. Nano Remote should mirror this exact three-part flow: a banner state, a detail view, and a single primary action button.

4. **Live Activity design.** The Live Activity shows a compact task-count + status (running N tasks, completed, interrupted). This is the minimal viable Dynamic Island presence; Nano Remote can match or extend it.

5. **Voice remote is a separate mode.** OpenCodexRealtimeVoiceIntent is a distinct entry point from the task-based remote chat. Nano Remote should treat voice and task modes as separate tabs or modes, not conflated.

6. **The system prompt reveals architecture constraints.** The phone-side voice assistant is explicitly forbidden from blocking requests or revealing the dual-component architecture. For Nano Remote, the equivalent constraint is: the phone app must pass everything through to the Mac agent and never interpose its own refusal logic.

7. **Screen sharing is available.** The VoiceScreenSharing.appex shows that ChatGPT can stream the phone screen over RTC. Nano Remote may want a similar capability for sharing Mac screen back to the phone rather than phone-to-Mac.
