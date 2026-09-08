---
name: shell-executor
description: Run safe, auditable local commands for data preparation and diagnostics.
---

# Shell Executor

Accept a command name plus an argument array. Execute with `shell: false`, a configured allowlist, a bounded timeout, and a declared working directory. Show the exact command and expected effect before asking for approval.

Never evaluate a free-form shell string, interpolate secrets, access credential files, change risk limits, or run destructive commands through this skill. Capture exit code, stdout, stderr, and duration. Any non-zero exit or timeout pauses the dependent workflow.
