---
name: browser-operator
description: Controlled website login, data collection, and evidence capture for Axiom workflows.
---

# Browser Operator

Use for website targets in a workflow. Navigate only to allowlisted domains, keep a named browser session, and return timestamped evidence for every extracted data set.

Credentials are referenced by `credentialRef` and injected by a target connector. Never place a username or password in model context, tool logs, screenshots, prompts, or MCP arguments. Login fields are connector-specific; do not guess selectors.

Read-only collection is the default. Any click that can submit an order, change an account, or delete data requires an explicit human approval event. A stale page, missing selector, unexpected redirect, or extraction ambiguity must pause the workflow and produce `HOLD`.
