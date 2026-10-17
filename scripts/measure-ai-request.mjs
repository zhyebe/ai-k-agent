import { requestDecision } from "../server/provider.mjs";
import { decisionLatencyContext, decisionEnvelope, latencyDecision } from "../tests/fixtures/decision-latency.mjs";

// Measures serialized input bytes only, not token counts or live model latency.
const originalFetch = globalThis.fetch;
try {
  for (const rounds of [0, 8]) {
    const context = await decisionLatencyContext(rounds);
    for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
      let requestBytes = 0;
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        requests++;
        requestBytes += Buffer.byteLength(options.body);
        return new Response(JSON.stringify(decisionEnvelope(apiFormat, latencyDecision(context))));
      };
      await requestDecision({ apiKey: "fixture", baseUrl: "https://fixture.invalid/v1", apiFormat, model: "fixture" }, context, { fastAnalysis: true });
      console.log(JSON.stringify({ rounds, apiFormat, requests, requestBytes }));
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
