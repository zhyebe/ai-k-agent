# Connector Adapter Contract

Axiom can discover a target from one website URL or one desktop App installation path. Discovery creates a versioned profile; it does not infer arbitrary login fields or enable live trading.

## Lifecycle

1. Normalize and validate URL or installation path.
2. Match a registered adapter by target type and explicit predicate.
3. Return capabilities, adapter version, review status, and supported modes.
4. Store credentials in the encrypted Vault and pass only `credentialRef` to the adapter.
5. Collect normalized history and current observations with evidence IDs.
6. Route decisions through deterministic rules, stop lock, and paper/shadow execution.

## Adapter shape

Register an object with `registerConnectorAdapter` in `server/connectors.mjs`:

```js
{
  id: "example-exchange-web",
  version: "1.0.0",
  type: "website",
  displayName: "Example Exchange",
  reviewStatus: "REVIEW_REQUIRED",
  match: ({ url }) => new URL(url).hostname === "trade.example.com",
  capabilities: ["navigate", "login", "read_history", "observe_orders", "paper_trade"],
  executionModes: ["PAPER", "SHADOW"],
  login: {
    usernameSelector: "[name=email]",
    passwordSelector: "[name=password]",
    submitSelector: "button[type=submit]",
    successSelector: "[data-authenticated=true]"
  }
}
```

`reviewStatus: APPROVED` is required for automated login and paper/shadow action routing. Generic adapters intentionally remain read-only or blocked until a target-specific mapping is reviewed. Live execution is not exposed by the current server.

## Local configuration

- Browser navigation requires the target hostname in `BROWSER_ALLOWED_DOMAINS`.
- Desktop launch requires an App ID in `DESKTOP_ALLOWED_APPS` or an installation root in `DESKTOP_ALLOWED_PATHS` and explicit approval.
- `PAPER` records simulated receipts; `SHADOW` records intents without submitting orders.
- Missing mapping, stale data, unexpected redirect, or uncertain desktop state pauses the task.
