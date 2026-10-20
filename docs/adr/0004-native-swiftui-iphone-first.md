# The phone app is native SwiftUI, iPhone first

Nano Remote ships as a native SwiftUI app for iOS 18 and later, iPhone first,
with a Swift package (NanoKit) holding the protocol client and the Replica.
The polish bar is the ChatGPT iOS app, and the features that make it feel
first-party are native: Live Activities and the Dynamic Island, Face ID lock,
keychain-held device keys, time-sensitive notifications, and tight background
socket handling. The earlier nano-ai (Expo/React Native) code was removed from
this repo when the direction changed; its UX ideas carry over as design, not
code. Consequences: no Android in v1 (an Android client would be a separate
decision and codebase); provider connection and chat UX must be rebuilt
natively; the OpenClawKit Swift client in the sibling repo is a tested
reference for a tailnet WebSocket client and may be mined for code.
