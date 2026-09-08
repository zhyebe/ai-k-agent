---
name: desktop-operator
description: Controlled launch and observation of allowlisted desktop applications on macOS and Windows.
---

# Desktop Operator

Use for App targets when no browser adapter exists. Resolve an application through an allowlist, request OS accessibility/screen-recording permission where required, and record the focused application and observation timestamp.

Opening or focusing an App may be automatic only when its identifier is pre-approved. Keyboard, mouse, or form actions that can alter an account or submit a trade require an explicit approval. Never inject credentials into arbitrary fields; use a target connector with a credential reference.

If the window cannot be identified, the OS permission is missing, or the visual state is uncertain, stop automation and route to `MANUAL_CONTROL`.
