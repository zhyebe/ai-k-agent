export function summarizeOrderBook(orderBook = null) {
  const levels = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => Number(row.price) > 0 && Number.isFinite(Number(row.volume)) && Number(row.volume) >= 0)
    .map((row) => ({ level: Number(row.level), price: Number(row.price), volume: Number(row.volume) })).slice(0, 20);
  const bids = levels(orderBook?.bids).sort((a, b) => b.price - a.price);
  const asks = levels(orderBook?.asks).sort((a, b) => a.price - b.price);
  const bidVolume = bids.reduce((sum, row) => sum + row.volume, 0);
  const askVolume = asks.reduce((sum, row) => sum + row.volume, 0);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const complete = bestBid !== null && bestAsk !== null;
  const spread = complete ? Number((bestAsk - bestBid).toFixed(6)) : null;
  return {
    bids, asks, bestBid, bestAsk, bidVolume, askVolume, spread,
    spreadPct: complete ? Number((spread / ((bestAsk + bestBid) / 2) * 100).toFixed(6)) : null,
    imbalance: complete && bidVolume + askVolume > 0 ? Number(((bidVolume - askVolume) / (bidVolume + askVolume)).toFixed(6)) : null,
    status: !bids.length && !asks.length ? "MISSING" : !complete ? "PARTIAL" : spread < 0 ? "CROSSED" : "AVAILABLE",
    observedAt: orderBook?.observedAt || null,
    source: orderBook?.source || "browser-dom",
  };
}

export function orderBookFingerprint(value) {
  const { bids, asks } = summarizeOrderBook(value);
  return { bids, asks };
}
