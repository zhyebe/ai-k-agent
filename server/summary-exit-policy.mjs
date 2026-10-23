import { executableExitQuote, heldDirection } from "./exit-policy.mjs";

export const SUMMARY_PROFIT_POINTS = 1;
export const SUMMARY_LOSS_POINTS = -2;
export const SUMMARY_REVIEW_TTL_MS = 60_000;
export const SUMMARY_LOSS_OBSERVATION_MS = 30_000;
export const SUMMARY_LOSS_SAMPLE_GAP_MS = 10_000;
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

// Only fresh, distinct observations count. A recovery or observation gap starts
// a new loss episode; a restart cannot reuse an old AI authorization.
export function observeSummaryLosses(task, market, now = Date.now()) {
  const previous = task.summaryLossObservations || [];
  const rows = market.account?.positionSummariesVerified === true ? market.account.positionSummaries || [] : [];
  const contexts = summaryExitReviewContexts(market, now);
  task.summaryLossObservations = rows.flatMap(summary => {
    const key = summaryKey(summary), signature = summarySignature(summary);
    const prior = previous.find(record => record.key === key && record.signature === signature);
    if (!(Number(summary.quantity) > 0) || Number(summary.frozenQuantity) !== 0) return [];
    const context = contexts.find(c => c.key === key);
    if (context?.reviewType === "TAKE_PROFIT") return [];
    const quote = executableExitQuote(market, summary, now);
    if (quote && !context) return []; // The loss threshold has receded.
    if (!quote) {
      const observedBook = (market.books || []).some(book => sameSummaryInstrument(book, summary)) || sameSummaryInstrument(market, summary);
      return !observedBook && prior && now - prior.lastObservedAt <= SUMMARY_LOSS_SAMPLE_GAP_MS ? [prior] : [];
    }
    if (prior && quote.observedAt === prior.lastObservedAt) return [prior];
    if (prior && quote.observedAt < prior.lastObservedAt) return [];
    const book = (market.books || []).find(book => sameSummaryInstrument(book, summary)) || market;
    const event = book.flashK?.suspected ? book.flashK : book.intrabarEvidence?.transientEvent;
    const flashEventId = event ? JSON.stringify([event.observedAt, event.timestamp, event.price, event.reason]) : prior?.flashEventId;
    const newFlash = event && flashEventId !== prior?.flashEventId;
    const continuous = prior && !newFlash && quote.observedAt - prior.lastObservedAt <= SUMMARY_LOSS_SAMPLE_GAP_MS;
    const sample = { observedAt: quote.observedAt, price: quote.price, pnlPoints: context.pnlPoints };
    const samples = continuous ? [...prior.samples, sample] : [sample];
    // A rolling 30-second evidence window stays bounded during a long hold.
    while (samples.length > 2 && samples[1].observedAt <= quote.observedAt - SUMMARY_LOSS_OBSERVATION_MS) samples.shift();
    return [{ key, signature, startedAt: continuous ? prior.startedAt : quote.observedAt,
      lastObservedAt: quote.observedAt, flashEventId, samples }];
  });
  return task.summaryLossObservations;
}

export function confirmedSummaryLoss(observation, summary, now = Date.now()) {
  if (!observation || observation.signature !== summarySignature(summary) || !Array.isArray(observation.samples)) return false;
  const samples = observation.samples;
  if (samples.length < 2 || samples.at(-1).observedAt !== observation.lastObservedAt
    || !Number.isFinite(observation.startedAt) || observation.startedAt > samples[0].observedAt
    || observation.lastObservedAt > now || observation.lastObservedAt - samples[0].observedAt < SUMMARY_LOSS_OBSERVATION_MS) return false;
  return samples.every((sample, index) => Number.isFinite(sample.observedAt)
    && summaryReviewType(summary, sample.price) === "STOP_LOSS"
    && (!index || (sample.observedAt > samples[index - 1].observedAt && sample.observedAt - samples[index - 1].observedAt <= SUMMARY_LOSS_SAMPLE_GAP_MS)));
}

// Profit exits immediately; loss exits require observed persistence and fresh AI.
export function summaryExitAllowsPrice(summary, price, authorization, now = Date.now()) {
  const trigger = summaryReviewType(summary, price);
  if (trigger === "TAKE_PROFIT") return true;
  return trigger === "STOP_LOSS" && authorization?.decision === "EXIT" && Boolean(authorization.id)
    && confirmedSummaryLoss(authorization.lossObservation, summary, now)
    && authorization.signature === summarySignature(summary)
    && authorization.reviewType === summaryReviewType(summary, price)
    && Date.parse(authorization.expiresAt) > now;
}

export function summaryExitCandidates(task, market, now = Date.now()) {
  return summaryExitReviewContexts(market, now).flatMap(context => {
    const authorization = (task.summaryExitReviews || []).find(record => record.key === context.key);
    if (context.reviewType === "STOP_LOSS") {
      const observation = (task.summaryLossObservations || []).find(record => record.key === context.key);
      if (!confirmedSummaryLoss(observation, context.summary, now) || observation.startedAt !== authorization?.lossObservation?.startedAt
        || observation.lastObservedAt !== context.quote.observedAt) return [];
    }
    if (!summaryExitAllowsPrice(context.summary, context.quote.price, authorization, now)) return [];
    const summary = { ...context.summary, side: heldDirection(context.summary) };
    const decision = { action: summary.side === "LONG" ? "SELL" : "BUY", orderType: "MARKET", exitType: context.reviewType,
      targetSummary: summary, targetPositionIds: [], targetSymbol: summary.symbol, targetSymbolName: summary.symbolName,
      targetInstrumentId: summary.instrumentId, exitGuard: { summary: true, programProfit: context.reviewType === "TAKE_PROFIT", aiAuthorization: context.reviewType === "STOP_LOSS" ? authorization : undefined,
        expiresAt: context.reviewType === "STOP_LOSS" ? authorization.expiresAt : new Date(context.quote.observedAt + SUMMARY_REVIEW_TTL_MS).toISOString(), triggerPrice: context.quote.price } };
    return [{ summary, decision }];
  });
}
