import { executableExitQuote, exitNetPnl, heldDirection, positionEntryPrice, isRecoveryExit, positionLossSignature } from "./exit-policy.mjs";

export const LOSS_REVIEW_MS = 60_000;
export const LOSS_STOP_MS = 120_000;
export const LOSS_SAMPLE_GAP_MS = 15_000;
export const FLASH_SETTLE_MS = 5_000;
const SAMPLE_MS = 10_000;
const observationMarkets = new WeakMap();
export const latestLossMarket = task => observationMarkets.get(task);
const sameInstrument = (a, b) => [a?.symbol, a?.symbolName, a?.instrumentId].filter(Boolean)
  .some(value => [b?.symbol, b?.symbolName, b?.instrumentId].includes(value));
const signature = positionLossSignature;

function flashPending(market, position) {
  const book = (market.books || []).find(b => sameInstrument(b, position)) || (sameInstrument(market, position) ? market : null);
  return book?.flashK?.suspected === true || book?.intrabarEvidence?.transientEvent?.suspected === true;
}

// Only successive fresh quotes count as observation time. Restarts, changed
// holdings and gaps start again; repeated snapshots never advance the clock.
export function observePositionLosses(task, market, now = Date.now()) {
  observationMarkets.set(task, market);
  const generation = Number(task.monitorGeneration || 0);
  const previous = task.lossObservationGeneration === generation ? task.lossObservations || {} : {};
  task.lossObservationGeneration = generation;
  if (market.account?.positionsVerified !== true) return task.lossObservations = {};
  const next = {};
  for (const position of market.account.positions || []) {
    const id = position.positionOrderId;
    const quote = executableExitQuote(market, position, now);
    if (!id || Number(position.frozenQuantity || 0) !== 0) continue;
    if (!quote) {
      const observedBook = (market.books || []).some(b => sameInstrument(b, position)) || sameInstrument(market, position);
      if (!observedBook && currentObservation(previous[id], position, now)) next[id] = previous[id];
      continue;
    }
    const prior = previous[id];
    const identity = signature(position);
    if (prior?.signature === identity && quote.observedAt < prior.lastObservedAt && currentObservation(prior, position, now)) {
      next[id] = prior;
      continue;
    }
    const continuous = prior?.signature === identity && quote.observedAt >= prior.lastObservedAt
      && quote.observedAt - prior.lastObservedAt <= LOSS_SAMPLE_GAP_MS;
    if (continuous && quote.observedAt === prior.lastObservedAt) { next[id] = prior; continue; }
    const fees = position.roundTripFee ?? position.totalFees ?? (continuous ? prior.fees : null);
    const pnl = exitNetPnl({ ...position, roundTripFee: fees }, quote.price);
    if (!pnl) continue;
    const value = pnl.netPnl ?? pnl.grossPnl;
    const old = continuous && prior.fees === pnl.fees ? prior : null;
    const flashing = flashPending(market, position);
    const flashUntil = flashing ? quote.observedAt + FLASH_SETTLE_MS : old?.flashUntil || 0;
    const losing = value < 0;
    // Retain a recovery episode for the AI even when profit is below one point.
    const continuingLoss = losing && old?.value < 0;
    const startedAt = continuingLoss ? old.startedAt : losing ? quote.observedAt : old?.startedAt ?? null;
    const sample = { at: quote.observedAt, value };
    const samples = continuingLoss ? [...old.samples] : [];
    if (!samples.length || sample.at - samples.at(-1).at >= SAMPLE_MS) samples.push(sample);
    while (samples.length > 15) samples.shift();
    next[id] = { signature: identity, startedAt, lastObservedAt: quote.observedAt, fees: pnl.fees,
      value, netPnl: pnl.netPnl, flashUntil, samples,
      recovered: !losing && pnl.netPnl !== null && startedAt !== null,
      recoveredAt: !losing && startedAt !== null ? old?.recoveredAt ?? quote.observedAt : null };
  }
  task.lossObservations = next;
  return next;
}

function currentObservation(record, position, now) {
  return record?.signature === signature(position) && Number.isFinite(record.lastObservedAt)
    && record.lastObservedAt <= now && now - record.lastObservedAt <= LOSS_SAMPLE_GAP_MS;
}

export function positionLossReview(record, position, now = Date.now()) {
  if (!currentObservation(record, position, now)) return { status: "UNVERIFIED", stopAllowed: false };
  if (record.lastObservedAt < record.flashUntil) return { status: "FLASH_WAIT", stopAllowed: false };
  if (record.recovered && record.netPnl >= 0) return { status: "RECOVERED", stopAllowed: false, netPnl: record.netPnl };
  const elapsedMs = record.startedAt === null ? 0 : record.lastObservedAt - record.startedAt;
  // Three separated observations must all worsen. A flat loss, a rebound or a
  // single jump is insufficient, even after two minutes have elapsed.
  const recent = record.samples.filter(s => s.at >= Math.max(record.lastObservedAt - 40_000, record.flashUntil)).slice(-3);
  const worsening = record.value < 0 && recent.length === 3 && recent[2].at - recent[0].at >= 20_000
    && recent.every((s, i) => Number.isFinite(s.value) && s.value < 0 && (!i || s.value < recent[i - 1].value))
    && record.value <= recent.at(-1).value;
  const stopAllowed = elapsedMs >= LOSS_REVIEW_MS && worsening;
  return { status: elapsedMs < LOSS_REVIEW_MS ? "OBSERVING" : stopAllowed ? "WORSENING" : "WAIT_RECOVERY",
    elapsedMs, stopAllowed, forceStop: stopAllowed && elapsedMs >= LOSS_STOP_MS };
}

export function recoveryExitAllowed(record, position, price, now = Date.now()) {
  return isRecoveryExit(record, position, price, now);
}

export function positionLossContexts(task, market, now = Date.now()) {
  return Object.entries(task.lossObservations || {}).map(([positionId, observation]) => ({ positionId, ...observation,
    review: positionLossReview(observation, market.account?.positions?.find(p => p.positionOrderId === positionId), now) }));
}

// Applied by the browser again to its fresh executable quote and modal price.
export function observedLossGuardAllowsPrice(guard, position, price, market, now = Date.now()) {
  if (guard?.rescueRecovery || guard?.positionPoints?.programCeiling || guard?.exitType === "SCHEDULED_CLOSE") return true;
  const record = guard?.lossObservation;
  if (guard?.lossRecovery) return !flashPending(market, position) && recoveryExitAllowed(record, position, price, now);
  if (guard?.exitType !== "STOP_LOSS") return true;
  const pnl = exitNetPnl({ ...position, roundTripFee: position?.roundTripFee ?? position?.totalFees ?? record?.fees }, price);
  if (!pnl || flashPending(market, position)) return false;
  if ((pnl.netPnl ?? pnl.grossPnl) >= 0) return true;
  const review = positionLossReview(record, position, now);
  return review.stopAllowed === true && (pnl.netPnl ?? pnl.grossPnl) <= record.value;
}

export function observedLossStopCandidate(position, market, record, now = Date.now()) {
  if (!positionLossReview(record, position, now).forceStop) return null;
  const quote = executableExitQuote(market, position, now);
  if (!quote) return null;
  return { position, decision: { action: heldDirection(position) === "LONG" ? "SELL" : "BUY", orderType: "MARKET",
    exitType: "STOP_LOSS", targetPositionIds: [position.positionOrderId], targetSymbol: position.symbol,
    targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
    exitGuard: { positionId: position.positionOrderId, heldSide: heldDirection(position), quantity: Number(position.quantity),
      entryPrice: positionEntryPrice(position), exitType: "STOP_LOSS", expiresAt: new Date(now + 5_000).toISOString(),
      triggerPrice: quote.price, comparison: heldDirection(position) === "LONG" ? "LTE" : "GTE",
      lossObservation: record, programLossStop: true } } };
}
