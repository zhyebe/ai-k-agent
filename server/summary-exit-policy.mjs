import { executableExitQuote, heldDirection } from "./exit-policy.mjs";

export const SUMMARY_PROFIT_POINTS = 1;
export const SUMMARY_LOSS_POINTS = -2;
export const SUMMARY_REVIEW_TTL_MS = 60_000;
const normalized = value => String(value || "").replace(/\s+/g, "").toLowerCase();
export const summaryKey = summary => `${normalized(summary.symbolName || summary.symbol || summary.instrumentId)}:${heldDirection(summary)}`;
export const sameSummaryInstrument = (a, b) => [a.symbol, a.symbolName, a.instrumentId].filter(Boolean)
  .some(value => [b.symbol, b.symbolName, b.instrumentId].filter(Boolean).some(other => normalized(other) === normalized(value)));
export const summarySignature = summary => JSON.stringify([summaryKey(summary), Number(summary.averagePrice), Number(summary.quantity)]);

export function summaryReviewType(summary, price) {
  const average = Number(summary?.averagePrice);
  const side = heldDirection(summary);
  if (!(average > 0) || !(Number(price) > 0) || !["LONG", "SHORT"].includes(side)) return null;
  if (side === "LONG" ? price >= average + SUMMARY_PROFIT_POINTS : price <= average - SUMMARY_PROFIT_POINTS) return "TAKE_PROFIT";
  if (side === "LONG" ? price <= average + SUMMARY_LOSS_POINTS : price >= average - SUMMARY_LOSS_POINTS) return "STOP_LOSS";
  return null;
}

export function summaryExitReviewContexts(market, now = Date.now()) {
  if (market.account?.positionSummariesVerified !== true) return [];
  return (market.account.positionSummaries || []).flatMap(summary => {
    if (!(Number(summary.quantity) > 0) || Number(summary.frozenQuantity) !== 0) return [];
    const quote = executableExitQuote(market, summary, now);
    const reviewType = quote && summaryReviewType(summary, quote.price);
    if (!reviewType) return [];
    return [{ key: summaryKey(summary), signature: summarySignature(summary), summary, quote, reviewType,
      pnlPoints: (quote.price - Number(summary.averagePrice)) * (heldDirection(summary) === "LONG" ? 1 : -1) }];
  });
}

// Profit exits immediately; only loss exits require a current AI decision.
export function summaryExitAllowsPrice(summary, price, authorization, now = Date.now()) {
  const trigger = summaryReviewType(summary, price);
  if (trigger === "TAKE_PROFIT") return true;
  return trigger === "STOP_LOSS" && authorization?.decision === "EXIT" && Boolean(authorization.id)
    && authorization.signature === summarySignature(summary)
    && authorization.reviewType === summaryReviewType(summary, price)
    && Date.parse(authorization.expiresAt) > now;
}

export function summaryExitCandidates(task, market, now = Date.now()) {
  return summaryExitReviewContexts(market, now).flatMap(context => {
    const authorization = (task.summaryExitReviews || []).find(record => record.key === context.key);
    if (!summaryExitAllowsPrice(context.summary, context.quote.price, authorization, now)) return [];
    const summary = { ...context.summary, side: heldDirection(context.summary) };
    const decision = { action: summary.side === "LONG" ? "SELL" : "BUY", orderType: "MARKET", exitType: context.reviewType,
      targetSummary: summary, targetPositionIds: [], targetSymbol: summary.symbol, targetSymbolName: summary.symbolName,
      targetInstrumentId: summary.instrumentId, exitGuard: { summary: true, programProfit: context.reviewType === "TAKE_PROFIT", aiAuthorization: context.reviewType === "STOP_LOSS" ? authorization : undefined,
        expiresAt: context.reviewType === "STOP_LOSS" ? authorization.expiresAt : new Date(context.quote.observedAt + SUMMARY_REVIEW_TTL_MS).toISOString(), triggerPrice: context.quote.price } };
    return [{ summary, decision }];
  });
}
