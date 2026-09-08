---
name: trade-decision-router
description: Route structured market decisions through deterministic rules and human review.
---

# Trade Decision Router

Accept only schema-validated `BUY`, `SELL`, or `HOLD` intents with TTL, confidence, evidence IDs, and invalidation conditions. Missing evidence, stale data, model errors, or conflicting rules become `HOLD`.

Evaluate rules in order. `AUTO` rules may pass deterministic checks, `REVIEW` rules pause for a named human decision, and `BLOCK` rules stop automatic execution. The model may propose an action but cannot place orders, alter limits, change permissions, or expand capital allocation.

Record the complete chain: input snapshot, retrieved Skill versions, rule results, final route, approval identity, and execution outcome.
