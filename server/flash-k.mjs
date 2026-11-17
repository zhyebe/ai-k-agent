const flashKObservationHistory = new Map();

function flashIdentity({ scope = "", symbol = "", symbolName = "", instrumentId = "", timeframe = "" } = {}) {
  return [scope, symbol, symbolName, instrumentId, timeframe].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).join("|") || "default";
}

export function candleWickState(candle) {
  if (!candle || candle.partial === true) return null;
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every(value => Number.isFinite(value) && value > 0)
    || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return high === Math.max(open, close) && low === Math.min(open, close) ? "NO_WICKS" : "HAS_WICK";
}

export function detectFlashK({ scope = "", observe = true, symbol = "", symbolName = "", instrumentId = "", timeframe = "", history = [], now = Date.now() } = {}) {
  const currentCandle = Array.isArray(history) ? history.at(-1) : null;
  const shape = candleWickState(currentCandle);
  const identity = flashIdentity({ scope, symbol, symbolName, instrumentId, timeframe });
  const state = flashKObservationHistory.get(identity) || { lastObservedAt: -Infinity, timestamp: -Infinity, event: null };
  const result = () => state.event ? { ...state.event, suspected: !state.event.confirmed }
    : { suspected: false, reason: shape === "HAS_WICK" ? "NORMAL_CANDLE_WITH_WICK" : "CANDLE_DATA_MISSING" };
  if (!Number.isFinite(now) || !observe || now <= state.lastObservedAt) return result();
  state.lastObservedAt = now;
  flashKObservationHistory.set(identity, state);
  const timestamp = typeof currentCandle?.timestamp === "number" ? currentCandle.timestamp : Date.parse(currentCandle?.timestamp || "");
  if (shape && Number.isFinite(timestamp) && timestamp <= now && timestamp >= state.timestamp) {
    state.timestamp = timestamp;
    if (shape === "NO_WICKS") state.event = {
      price: currentCandle.close, timestamp: currentCandle.timestamp,
      observedAt: state.event?.confirmed === false && state.event.timestamp === currentCandle.timestamp ? state.event.observedAt : now,
      confirmed: false, reason: "NO_UPPER_OR_LOWER_WICK",
      excludeFromAnalysis: false, interpretation: "WICKLESS_CANDLE",
      actorIntent: "UNKNOWN", preserveExecutableQuotes: true,
    };
    else if (state.event) state.event = { ...state.event, confirmed: true, confirmedAt: now };
  }
  for (const [key, value] of flashKObservationHistory) {
    if (now - value.lastObservedAt > 86400000) flashKObservationHistory.delete(key);
  }
  return result();
}
