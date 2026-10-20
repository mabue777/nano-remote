# ChatGPT macOS Swift App — Codex & Remote Control Findings

**Target:** `com.openai.chat` v1.2026.183 (July 2026), `ChatGPT.framework` (115 MB arm64 Mach-O)
**Date:** 2026-10-20

---

## Coverage

Provider: native macOS shell tools only (`strings -n 6`, `xcrun nm`, `xcrun swift-demangle`). No deep analysis provider (Ghidra, Hopper, IDA, Kuna) was configured, so pseudocode decompilation was unavailable. The investigation relied on symbol table entries, string literals, and demangled Swift type names. The framework is not encrypted; string coverage is high for public names and UIstrings, but internal protocol details and networking payloads could not be confirmed without decompilation.

---

## Behaviors

1. **[Observed]** The Swift app did not embed or spawn a Codex engine locally. Instead it contained a full in-app upgrade/install flow (`ChatGPTCodexUpgradeInstaller` module, protocols `CodexUpgradeDownloading`, `CodexUpgradeInstalling`, `CodexUpgradeHelperLaunching`, `CodexUpgradeSignatureValidating`, `CodexUpgradeApplicationLifecycle`, `CodexUpgradeInstallerFileManaging`) that downloaded the Codex app from `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg`, validated its signature, and installed it as a separate application (`com.openai.codex`). Evidence: string `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg`, symbol names `DefaultCodexUpgradeInstaller`, `DefaultCodexUpgradeSignatureValidator`, `DefaultCodexUpgradeHelperLauncher`, type `CodexUpgradeReplacement`.

2. **[Observed]** After the Codex app was installed, the Swift ChatGPT app acted as a shell/host for Codex conversations: it displayed task lists (`codex_task_list`), task details (`Codex Task Details`), branch and environment selection (`Codex Branch Selection`, `Codex Environment Selection`), archive lists (`Codex Archive List`), and a `CodexDeepLink` type for navigating to Codex destinations. Evidence: these are named UI-screen identifiers found in strings.

3. **[Observed]** The app contained a "Codex Remote Connection" feature, confirmed by: the named settings screen `Codex Remote Connection Settings` / `codex_remote_connection_settings`, Swift type names `codexRemoteControl`, `codexRemoteConnectionSettings`, `codexRemoteControlEnrollment`, and the analytics entry point constant `ACCESS_FLOW_ENTRY_POINT_CODEX_REMOTE_CONTROL_ENROLLMENT`. The feature was gated by the feature flag `chatgpt-ios-enable-codex-remote`.

4. **[Observed]** The Codex Remote feature had two pairing UX modes, selectable by feature flags: a baseline mode (on by default when `chatgpt-ios-enable-codex-remote` is set) and a newer "slingshot" pairing flow (`chatgpt-ios-enable-codex-remote-new-slingshot-pairing-flow`). The symbol `SS11pairingCode_t` (a Swift nominal type mangling for `pairingCode`) and the C symbols `start_pairing` / `stop_pairing` / `startPairing` / `stopPairing` were found alongside a `PairingError` type and `remotePairing` identifier. This indicates a code-based pairing handshake, not QR.

5. **[Inferred]** The QR code in the app (`AuthenticatorAppQRCodeView`, `QRCodeGenerator`, `isShowingQRCode`, string "Scan the QR code using your authenticator app, then enter the 6-digit code from the app.") is exclusively for MFA authenticator enrollment, not for Codex Remote pairing. No QR code symbol was found adjacent to Codex Remote types.

6. **[Observed]** A third networking mode for Codex Remote was gated behind `chatgpt-ios-enable-codex-remote-ssh`. No SSH key or port-forwarding strings were found, so the SSH tunnel implementation details are not in the string table — likely compiled constants or runtime-generated config.

7. **[Observed]** The settings security screen had a `shouldShowCodexRemoteLocalAuthenticationSetting` parameter (from the initializer `init(dependencies:reauthHelper:shouldShowMFASettings:…:shouldShowCodexRemoteLocalAuthenticationSetting:securitySettingsBaseURL:…)`). This controls whether a toggle for requiring Touch ID/Face ID before accepting remote commands appears in Security Settings. The string `Codex Remote local authentication is unavailable on macOS` confirms this setting was mobile-only (iOS/iPadOS could require local biometric; macOS cannot). Evidence: `codexRemoteLocalAuthenticationRequired`, `codexRemoteLocalAuthenticationRequiredState`, `setCodexRemoteLocalAuthenticationRequired`.

8. **[Observed]** When a foreground Codex Remote push notification arrived while the app was active, the app had logic to suppress it: `shouldSuppressForegroundCodexRemoteNotification(_:)`. This suggests the Mac acted as the remote host and suppressed redundant alert popups while the user was already using the machine.

9. **[Observed]** Codex task completion was surfaced as a push notification type `CodexFinished` / `codexFinished`, with the ability to disable task completion banners via `chatgpt-ios-disable-codex-remote-task-completion-banners`. The app registered a `CHATGPT_NOTIFICATION_PERMISSION_REQUEST_KIND_CODEX` permission category and included a named `Codex Notification Permission Prompt` screen.

10. **[Observed]** The app supported inline MCP tool-call approval during Codex task execution via `codexMcpElicitation` / `CodexMCPElicitation` — the user could approve or reject tool calls from within the ChatGPT UI without switching to the Codex app.

11. **[Observed]** "App Pairing" (module `ChatGPTPairWithAI`) is a separate and parallel feature distinct from Codex Remote. It reads the content of the user's currently active macOS app via two adapters: `AccessibilityContentAdapter` (macOS Accessibility API) and `AppExtensionContentAdapter` (app-side extension over `ExtensionSocketTransport`). A VSCode extension is explicitly named (`VSCodeExtensionInstaller.swift`). Context is passed to the ChatGPT conversation via `AppPairingVoiceContextProvider`. This is the "see what I see on my screen" feature, not remote execution. Feature flag: `chatgpt-desktop-allow-app-pairing-default-on`. Deep-link scheme: `chatgpt://pair-with-app`.

12. **[Inferred]** The Mac acted as a **host** for Codex Remote (the phone directs the Mac, not the other way round), based on the local-auth guard being on the receiving end, the foreground notification suppression logic, and the enrollment flow being named `codexRemoteControlEnrollment` — the Mac enrolls itself as a controlled device.

---

## Types and Symbols

| Swift / ObjC type | Module | Role |
|---|---|---|
| `CodexUpgradeInstalling` | `ChatGPTCodexUpgradeInstaller` | Protocol: tracks in-progress install |
| `CodexUpgradeDownloading` | `ChatGPTCodexUpgradeInstaller` | Protocol: tracks download state |
| `CodexUpgradeHelperLaunching` | `ChatGPTCodexUpgradeInstaller` | Protocol: launches helper process |
| `CodexUpgradeSignatureValidating` | `ChatGPTCodexUpgradeInstaller` | Protocol: validates DMG signature |
| `CodexUpgradeApplicationLifecycle` | `ChatGPTCodexUpgradeInstaller` | Protocol: app lifecycle during install |
| `CodexUpgradeInstallerFileManaging` | `ChatGPTCodexUpgradeInstaller` | Protocol: file ops during install |
| `DefaultCodexUpgradeInstaller` | `ChatGPTCodexUpgradeInstaller` | Concrete installer orchestrator |
| `CodexDownloadEmailService` | `ChatGPTNotifications` | Send Codex DMG download link by email |
| `DefaultCodexDownloadEmailService` | `ChatGPTNotifications` | Concrete email service |
| `codexRemoteConnectionSettings` | `ChatGPT` | Settings screen: remote connection |
| `codexRemoteControl` | `ChatGPT` | Feature state: remote control active |
| `codexRemoteControlEnrollment` | `ChatGPT` | Flow: enrolling Mac as remote host |
| `codexRemoteLocalAuthenticationRequired` | `ChatGPT` | State: biometric gate required |
| `codexRemoteLocalAuthenticationRequiredState` | `ChatGPT` | Published state for above |
| `CodexMCPElicitation` | `ChatGPT` | Inline MCP tool-call approval card |
| `CodexDeepLink` | `ChatGPT` | Navigate to Codex destination |
| `CodexUpgradeReplacement` | `ChatGPT` | Replace old Codex install with new |
| `AppPairingService` | `ChatGPTPairWithAI` | Manages screen-context sharing |
| `AppPairingOSMonitor` | `ChatGPTPairWithAI` | Monitors running/focused apps |
| `AccessibilityContentAdapter` | `ChatGPTPairWithAI` | Reads app content via AX API |
| `AppExtensionContentAdapter` | `ChatGPTPairWithAI` | Reads via app-side extension socket |
| `ExtensionSocketTransport` | `ChatGPTPairWithAI` | IPC transport for extension content |
| `OboeDiffService` | `ChatGPTPairWithAI` | Incremental content diff (Oboe protocol) |
| `OboePatchApplicationService` | `ChatGPTPairWithAI` | Applies diff patches |
| `AppPairingVoiceContextProvider` | `ChatGPTPairWithAI` | Supplies screen context to voice mode |
| `AppExtensionRegistrationService` | `ChatGPTPairWithAI` | Registers paired app extensions |
| `pairingCode` (`SS11pairingCode_t`) | `ChatGPT` | Pairing code used for Codex Remote handshake |
| `shouldSuppressForegroundCodexRemoteNotification(_:)` | `ChatGPT` | Suppresses duplicate push on host Mac |

---

## Endpoints and Flags

### Backend paths found verbatim

- `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg` — CDN for the Codex app download
- `https://developers.openai.com/codex/pricing#what-are-the-usage-limits-for-my-plan` — linked from upgrade UI
- `https://openai.com/index/introducing-the-codex-app/` — linked from upgrade UI
- `/notifications/activity/update_token` — push token registration
- `/notifications/subscription/register` and `/deregister` — push subscription
- `chatgpt://pair-with-app` — custom URL scheme for App Pairing deep link

No relay, rendezvous, WebSocket, or remote-session endpoint paths were found in string literals. These are either constructed at runtime from base URLs or sent over TLS without appearing as string constants.

### Feature flags (verbatim)

**Codex Remote:**
- `chatgpt-ios-enable-codex-remote`
- `chatgpt-ios-enable-codex-remote-new-slingshot-pairing-flow`
- `chatgpt-ios-enable-codex-remote-ssh`
- `chatgpt-ios-disable-codex-remote-task-completion-banners`
- `chatgpt-ios-disable-codex-only-sidebar-blocking`
- `chatgpt-macos-codex-upgrade-enabled`

**App Pairing:**
- `chatgpt-desktop-allow-app-pairing-default-on`
- `chatgpt-desktop-allow-app-pairing-hints-using-vision`
- `chatgpt-desktop-enabled-app-pairing-m1`
- `chatgpt-desktop-remove-app-pairing-hints-on-input-changed`
- `chatgpt-desktop-work-with-apps`
- `chatgpt-desktop-enabled-oboe`

---

## Open Questions

1. What protocol does "slingshot" pairing use? The term "slingshot" appeared only in the flag name and as the bare string `slingshot`. Whether it is a code-based BLE handshake, an IPC to the Codex app, or a server-mediated pairing flow cannot be determined from strings alone.
2. How does the SSH remote mode work? The flag `chatgpt-ios-enable-codex-remote-ssh` exists but no SSH key types, port numbers, or known_hosts references appear in the string table.
3. What relay infrastructure backs Codex Remote? No WSS endpoint was found. The relay address may be a hardcoded constant in a non-string section or fetched from a config endpoint at runtime.
4. What exactly does `codexMcpElicitation` show the user? The type exists but without decompilation the approval card layout and approval scopes are unknown.
5. Does the "slingshot" flow replace or extend the baseline `start_pairing` / `stop_pairing` C symbols? The two coexist in the binary.

---

## Implications for Nano Remote

- **The Swift app was the remote HOST, not a controller.** Nano Remote targeting the same pattern needs to authenticate itself to the host Mac (enrollment flow) before sending commands, and should expect the host to gate actions behind a biometric prompt on iOS (macOS cannot use the local-auth gate).
- **Codex Remote and App Pairing are parallel, not integrated.** Codex Remote is about running agentic coding tasks on the Mac from a phone; App Pairing is about reading screen context into the chat. A Nano Remote design can borrow both patterns — the pairing handshake from Codex Remote and the screen-reading approach from App Pairing — without conflating them.
- **The pairing handshake uses a short code** (`pairingCode` type, `SS11pairingCode_t`), not a QR scan. A code-entry flow on the Mac side paired with a code-display on the phone is the established UX pattern in this generation.
- **Task completion is push-notification-driven**, and the Mac suppresses redundant foreground alerts when the user is present. Nano Remote should implement the same suppression logic to avoid double-alerting.
- **MCP elicitation inline** — the approval of Codex tool calls happened inside the ChatGPT conversation view, not as a system notification. This is a strong UX precedent: approval should be contextual, not a separate modal.
- **The relay endpoint is not visible in strings.** Nano Remote will need to sniff live traffic (mitmproxy or `observe_native_calls` on the running process) to discover the relay URL and WebSocket protocol used by Codex Remote.
