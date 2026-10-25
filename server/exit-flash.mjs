export const EXIT_FLASH_WAIT_MS = 30_000;

const aliases = item => [item?.symbol, item?.symbolName, item?.instrumentId]
  .map(value => String(value || "").trim().toLowerCase()).filter(Boolean);

export function positionMarketBook(market, position) {
  const matches = book => aliases(book).some(value => aliases(position).includes(value));
  return (market?.books || []).find(matches) || (matches(market) ? market : null);
}

// A flash is cleared by a confirmed event candle (or a later candle), not by
// the passage of wall time or by waiting for every subsequent live K to close.
export function exitFlashState(market, position, previous = null, now = Date.now()) {
  const book = positionMarketBook(market, position);
  const at = Date.parse(book?.observedAt || market?.observedAt || "");
  if (!book || !Number.isFinite(at) || at > now || now - at > 5000) return previous;
  if (previous?.lastObservedAt > at) return previous;
  const event = book.flashK || book.intrabarEvidence?.transientEvent;
  const eventAt = Number(event?.observedAt);
  const hasEvent = event?.suspected === true || (Number.isFinite(eventAt) && eventAt > 0);
  let state = previous;
  if (hasEvent) {
    const observedAt = Number.isFinite(eventAt) && eventAt > 0 ? eventAt : at;
    if (observedAt <= at && (!state || observedAt > state.observedAt)) {
      state = { observedAt, waitUntil: observedAt + EXIT_FLASH_WAIT_MS,
        candleAt: Number(event.timestamp) || Math.floor(observedAt / 60000) * 60000,
        confirmedAt: null, readyAt: null, pending: true };
    }
  }
  if (!state) return null;
  state = { ...state };
  state.lastObservedAt = at;
  const history = book.timeframes?.["1m"]?.history || book.history || [];
  if (state.confirmedAt === null) {
    const confirmed = history.some(candle => Number(candle.timestamp) >= state.candleAt
      && Number(candle.timestamp) <= at && candle.confirmation?.status === "CONFIRMED"
      && Number(candle.confirmation.lastObservedAt) >= state.observedAt
      && Number(candle.confirmation.lastObservedAt) <= at);
    if (confirmed) state.confirmedAt = at;
  }
  state.readyAt = state.confirmedAt === null ? null : Math.max(state.waitUntil, state.confirmedAt);
  state.pending = state.readyAt === null || at < state.readyAt;
  return state;
}

export function observeExitFlashes(task, market, now = Date.now()) {
  const generation = Number(task.monitorGeneration || 0);
  const previous = task.exitFlashGeneration === generation ? task.exitFlashObservations || {} : {};
  task.exitFlashGeneration = generation;
  // A failed account read must not erase an unresolved flash.
  if (market.account?.positionsVerified !== true) return previous;
  const next = {};
  for (const position of market.account.positions || []) {
    const id = position.positionOrderId;
    const state = exitFlashState(market, position, previous[id], now);
    if (id && state) next[id] = state;
  }
  task.exitFlashObservations = next;
  return next;
}

export function exitFlashAllows(guard, position, market, now = Date.now()) {
  if (guard?.rescueRecovery || guard?.exitType === "SCHEDULED_CLOSE") return true;
  return !exitFlashState(market, position, guard?.exitFlash, now)?.pending;
}
