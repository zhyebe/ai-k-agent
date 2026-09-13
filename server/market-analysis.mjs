import { buildLayeredAnalysisMarket, compactCollectedMarket, estimateMarketContextBytes } from "./analysis-context.mjs";
import { requestDecision } from "./provider.mjs";

// Runs inside the desktop runtime. No database, RAG index or server engine dependency.
export async function analyzeCollectedMarket(provider, market, context, options = {}) {
  const layered = buildLayeredAnalysisMarket(compactCollectedMarket(market));
  const { marketRef, ...decisionContext } = context;
  const input = { ...decisionContext, market: layered, analysisMode: "direct_client" };
  const contextBytes = estimateMarketContextBytes(input);
  if (contextBytes > 1024 * 1024) throw new Error("AI_CONTEXT_TOO_LARGE");
  const books = layered.books?.length ? layered.books : [layered];
  const totalKlineRows = books.reduce((sum, book) => sum + Object.values(book.timeframes || {}).reduce((rows, timeframe) => rows + (timeframe.history?.length || 0), 0), 0);
  const decision = await requestDecision(provider, input, options);
  return {
    decision,
    market: layered,
    coverage: {
      mode: "direct_client", fingerprint: market.fingerprint, contextBytes,
      totalSegments: 1, reviewedSegments: 1, failedSegments: [], complete: true,
      totalKlineRows, totalLiveTickRows: 0, bookCount: books.length,
      knowledgeCount: (context.evidence || []).filter((item) => item.type === "approved_experience").length,
    },
  };
}
