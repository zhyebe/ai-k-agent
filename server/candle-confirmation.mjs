// Observation evidence belongs to a browser session and instrument, never to
// the model or the wall clock alone. Re-reading a cached snapshot adds no time.
const observations = new Map();
const MINUTE = 60000;
const STABILITY_MS = 5000;

export function confirmObservedCandles(history, { scope, instrument, timeframe = "1m", observedAt, observe = true } = {}) {
  const now = Date.parse(observedAt || "");
  if (timeframe !== "1m" || !Number.isFinite(now)) return history;
  const key = JSON.stringify([scope, instrument, timeframe]);
  const previous = observations.get(key);
  const records = previous?.records || new Map();
  const present = new Set(history.map(candle => Number(candle.timestamp)));
  if (observe && now > (previous?.at ?? -Infinity)) {
    for (const [timestamp, record] of records) {
      if (!present.has(timestamp)) record.present = false;
    }
  }
  const result = history.map((candle, index) => {
    const timestamp = Number(candle.timestamp);
    const printAt = Math.floor(timestamp / MINUTE) * MINUTE + 50000;
    const prior = records.get(timestamp);
    // Backfilled, completed history is distinct from a newly observed display K.
    if (!prior && index < history.length - 1 && printAt < Math.floor(now / MINUTE) * MINUTE) return candle;
    const signature = JSON.stringify([candle.open, candle.high, candle.low, candle.close, candle.volume, candle.partial]);
    let record = prior;
    if (observe && now > (previous?.at ?? -Infinity)) {
      const continuous = prior?.present && prior.signature === signature && (prior.confirmed || now - prior.lastAt <= STABILITY_MS);
      record = { signature, firstAt: continuous ? prior.firstAt : now, lastAt: now, present: true };
      records.set(timestamp, record);
    } else if (!record) {
      record = { signature, firstAt: now, lastAt: now, present: false };
      records.set(timestamp, record);
    }
    const stableSince = Math.max(record?.firstAt ?? now, printAt);
    const validOhlc = [candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0)
      && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close) && candle.high >= candle.low;
    const confirmed = validOhlc && timestamp <= now && record?.present && record.signature === signature && candle.partial !== true
      && now >= record.lastAt && (record.confirmed || (now - record.lastAt <= STABILITY_MS && record.lastAt - stableSince > STABILITY_MS));
    if (observe && record && now >= record.lastAt) record.confirmed = Boolean(confirmed);
    return { ...candle, confirmation: { status: confirmed ? "CONFIRMED" : "PROVISIONAL", firstObservedAt: record?.firstAt ?? now, lastObservedAt: record?.lastAt ?? now } };
  });
  observations.set(key, { at: observe ? Math.max(previous?.at ?? -Infinity, now) : previous?.at ?? -Infinity,
    touchedAt: Math.max(previous?.touchedAt ?? -Infinity, now), records });
  // Bound memory, while retaining recent disappeared/reappeared candidate IDs.
  for (const [timestamp] of records) if (now - timestamp > 24 * 60 * MINUTE) records.delete(timestamp);
  for (const [id, state] of observations) if (now - state.touchedAt > 24 * 60 * MINUTE) observations.delete(id);
  return result;
}

export function markObservedMarketCandles(market, scope, { observe = true } = {}) {
  const mark = book => {
    const instrument = book.instrumentId || book.instrument?.instrumentId || book.symbol || book.symbolName;
    const snapshots = Object.keys(book.timeframes || {}).length ? Object.values(book.timeframes) : [book];
    for (const snapshot of snapshots) {
      if (!Array.isArray(snapshot.history)) continue;
      // The visible chart can be minute-based while the task's primary API
      // period is 15m. Use the actual consecutive chart timestamps as evidence.
      const recent = snapshot.history.slice(-6);
      if (book.source === "browser-dom" && snapshot === book && recent.length >= 2
        && recent.slice(1).every((candle, index) => Number(candle.timestamp) - Number(recent[index].timestamp) === MINUTE)) {
        snapshot.timeframe = "1m";
      }
      snapshot.history = confirmObservedCandles(snapshot.history, { scope, instrument,
        timeframe: snapshot.timeframe || book.timeframe, observedAt: book.observedAt || market.observedAt, observe });
    }
    if (book.timeframes?.[book.timeframe]) book.history = book.timeframes[book.timeframe].history;
  };
  for (const book of market.books || []) mark(book);
  mark(market);
  return market;
}
