---
name: connector-adapter
description: Build and review target-specific website or desktop App adapters for Axiom workflows.
---

# Connector Adapter

Use when adding support for a concrete website or desktop App supplied by URL, Bundle ID, or installation path.

Define an explicit adapter ID and version. Match only the intended target. Declare capabilities separately for navigation, login, historical-data reading, order observation, and paper/shadow actions. Keep live execution disabled until the adapter has been reviewed and replayed in simulation.

Login mappings must use named selectors or accessibility identifiers and receive only a `credentialRef`. Never guess fields, log credentials, or place passwords in model context. Data mappings must return normalized timestamps, symbols, prices, quantities, and source evidence IDs.

Action mappings return a validated order intent or a paper/shadow receipt. They must honor the server stop lock, idempotency key, mode gate, rule chain, and human approval requirements. Missing selectors, redirects, stale data, uncertain UI state, or mismatched targets route to `HOLD`/`MANUAL_CONTROL`.

Register adapters through `server/connectors.mjs`, add focused tests, and document the target-specific permissions and rollback path before enabling it.
