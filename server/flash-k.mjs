// Sudden unconfirmed display moves are flash-K candidates. A rebound is
// additional evidence, never a prerequisite. Keep the event for AI analysis.
const flashKObservationHistory = new Map();

function flashIdentity({ scope = "", symbol = "", symbolName = "", instrumentId = "", timeframe = "" } = {}) {
  return [scope, symbol, symbolName, instrumentId, timeframe].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).join("|") || "default";
}

function priceNear(left, right, tolerance = 0.001) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) / Math.max(Math.abs(b), 1) <= tolerance;
}

export function detectFlashK({ scope = "", observe = true, symbol = "", symbolName = "", instrumentId = "", timeframe = "", history = [], ticks = [], latest = {}, now = Date.now() } = {}) {
  const currentCandle = Array.isArray(history) ? history.at(-1) : null;
  const currentPrice = Number(latest?.price ?? currentCandle?.close);
  const identity = flashIdentity({ scope, symbol, symbolName, instrumentId, timeframe });
  const state = flashKObservationHistory.get(identity) || { samples: [], event: null };
  const samples = state.samples;
  const result = () => state.event ? { ...state.event, suspected: now >= state.event.observedAt && now - state.event.observedAt <= 30000 }
    : { suspected: false, reason: "NO_UNCONFIRMED_SPIKE" };
  if (!Number.isFinite(now) || !Number.isFinite(currentPrice) || currentPrice <= 0) return state.event ? result() : { suspected: false, reason: "LATEST_PRICE_MISSING" };
  if (!observe || (samples.length && now <= samples.at(-1).at)) return result();
  const current = { at: Number(now), price: currentPrice, timestamp: currentCandle?.timestamp || null };
  current.provisional = currentCandle?.confirmation?.status === "PROVISIONAL" || currentCandle?.partial === true;
  samples.push(current);
  while (samples.length > 8) samples.shift();
  flashKObservationHistory.set(identity, state);

  let transientPrice = null;
  let reason = "";
  let eventAt = now;
  let eventTimestamp = currentCandle?.timestamp || null;
  const before = samples.at(-3);
  const transient = samples.at(-2);
  if (before && transient && samples.length >= 3
    && transient.provisional
    && Number(transient.at) - Number(before.at) <= 15000
    && Number(now) - Number(transient.at) <= 15000
    && !priceNear(transient.price, before.price, 0.001)
    && priceNear(currentPrice, before.price, 0.001)) {
    transientPrice = transient.price;
    eventTimestamp = transient.timestamp;
    reason = "TRANSIENT_REVERTED";
  }

  const validTicks = (Array.isArray(ticks) ? ticks : [])
    .map((tick) => ({ price: Number(tick?.price), at: new Date(tick?.timestamp || 0).getTime() }))
    .filter((tick) => Number.isFinite(tick.price) && tick.price > 0 && Number.isFinite(tick.at) && tick.at <= now && now - tick.at <= 15000)
    .sort((left, right) => left.at - right.at);
  if (!transientPrice && current.provisional && validTicks.length >= 3) {
    const first = validTicks[0];
    const last = validTicks.at(-1);
    const prices = validTicks.map((tick) => tick.price);
    const extreme = prices.reduce((best, price) => Math.abs(price / first.price - 1) > Math.abs(best / first.price - 1) ? price : best, first.price);
    const extremeCount = prices.filter((price) => priceNear(price, extreme, 0.0001)).length;
    if (last.at - first.at <= 10000 && extremeCount === 1 && Math.abs(extreme / first.price - 1) >= 0.002 && priceNear(last.price, first.price, 0.001)) {
      transientPrice = extreme;
      reason = "SHORT_TICK_SPIKE_REVERTED";
      eventAt = last.at;
    }
  }
  if (transientPrice === null && current.provisional && transient && now - transient.at <= 15000
    && !priceNear(currentPrice, transient.price, 0.001)) {
    transientPrice = currentPrice;
    reason = currentPrice > transient.price ? "UNCONFIRMED_SPIKE_UP" : "UNCONFIRMED_SPIKE_DOWN";
  }
  if (transientPrice !== null) state.event = {
      suspected: true,
      price: transientPrice,
      timestamp: eventTimestamp,
      observedAt: eventAt,
      confirmed: false,
      reason,
      excludeFromAnalysis: false,
      interpretation: "TRANSIENT_PRICE_EVENT",
      actorIntent: "UNKNOWN",
      preserveExecutableQuotes: true,
    };
  for (const [key, value] of flashKObservationHistory) {
    if (now - (value.samples.at(-1)?.at || 0) > 86400000) flashKObservationHistory.delete(key);
  }
  return result();
}
