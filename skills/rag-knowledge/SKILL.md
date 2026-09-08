---
name: rag-knowledge
description: Ingest expert documents, rules, and red lines into versioned, reviewable retrieval knowledge.
---

# RAG Knowledge

Ingest Markdown, text, or parsed document content as a draft. Split into bounded chunks and attach target, symbol, timeframe, market-state, source, version, evidence, and expiry metadata.

Draft knowledge never enters an automatic decision. A reviewer must approve a version before indexing it for retrieval. Retrieval returns chunk IDs and evidence IDs, filters by applicability, and surfaces conflicting rules instead of silently merging them.

Red lines are deterministic guards. Keep them separate from model explanations, evaluate them before any action, and route a violation to `PAUSED` or `MANUAL_CONTROL`.
