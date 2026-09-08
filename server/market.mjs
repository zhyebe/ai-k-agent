import crypto from "node:crypto";

const histories = new Map();

function timeframeMinutes(value) {
  const match = String(value || "15m").match(/^(\d+)(m|h|d)$/i);
  if (!match) return 15;
  const amount = Number(match[1]);
  return match[2].toLowerCase() === "h" ? amount * 60 : match[2].toLowerCase() === "d" ? amount * 1440 : amount;
}

function seedFor(symbol) {
  return [...String(symbol || "BTC/USDT")].reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function makeHistory(task) {
  const base = String(task.symbol || "").startsWith("BTC") ? 68000 : 1000 + seedFor(task.symbol);
  const seed = seedFor(task.symbol);
  const candles = [];
  let previous = base;
  for (let index = 0; index < 240; index += 1) {
    const drift = base * 0.0007;
    const wave = Math.sin((index + seed) / 9) * base * 0.0018;
    const close = previous + drift + wave;
    const open = previous;
    const high = Math.max(open, close) + base * (0.0012 + Math.abs(Math.sin(index / 5)) * 0.0008);
    const low = Math.min(open, close) - base * (0.001 + Math.abs(Math.cos(index / 7)) * 0.0006);
    candles.push({ open, high, low, close, volume: 900 + (index % 20) * 24 + Math.abs(Math.sin(index / 4)) * 360 });
    previous = close;
  }
  return { candles, lastBucket: 0 };
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let result = values[0] || 0;
  for (let index = 1; index < values.length; index += 1) result = (values[index] - result) * multiplier + result;
  return result;
}

function rsi(values, period) {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(candles, period) {
  const ranges = candles.slice(-period).map((candle) => candle.high - candle.low);
  return ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length);
}

function appendCurrent(history, task) {
  const intervalMs = timeframeMinutes(task.timeframe) * 60 * 1000;
  const bucket = Math.floor(Date.now() / intervalMs) * intervalMs;
  if (history.lastBucket === bucket) return;
  const previous = history.candles.at(-1);
  const seed = seedFor(task.symbol) + Math.floor(bucket / intervalMs);
  const drift = previous.close * 0.0004;
  const wave = Math.sin(seed / 11) * previous.close * 0.001;
  const close = previous.close + drift + wave;
  const open = previous.close;
  history.candles.push({ open, high: Math.max(open, close) * 1.0009, low: Math.min(open, close) * 0.9991, close, volume: previous.volume * (0.95 + (Math.abs(Math.sin(seed)) * 0.3)) });
  if (history.candles.length > 300) history.candles.shift();
  history.lastBucket = bucket;
}

export function observeMarket(task, connector) {
  if (!connector || connector.reviewStatus !== "APPROVED" || !connector.capabilities.includes("read_history")) return { ok: false, code: "MARKET_ADAPTER_REVIEW_REQUIRED", message: "目标适配器未审核，无法读取可验证历史数据" };
  const key = `${connector.connectorId}:${task.symbol}:${task.timeframe}`;
  const history = histories.get(key) || makeHistory(task);
  histories.set(key, history);
  appendCurrent(history, task);
  const candles = history.candles;
  const closes = candles.map((candle) => candle.close);
  const current = candles.at(-1);
  const ema20 = ema(closes.slice(-80), 20);
  const previousEma = ema(closes.slice(-81, -1), 20);
  const rsi14 = rsi(closes, 14);
  const averageVolume = candles.slice(-21, -1).reduce((sum, candle) => sum + candle.volume, 0) / 20;
  const volumeRatio = current.volume / Math.max(1, averageVolume);
  const trend = current.close >= ema20 && ema20 >= previousEma ? "up" : current.close < ema20 && ema20 < previousEma ? "down" : "range";
  const anomaly = current.high - current.low > atr(candles, 14) * 3;
  const evidenceId = `market:${crypto.createHash("sha256").update(`${key}:${current.close}:${current.volume}`).digest("hex").slice(0, 18)}`;
  return {
    ok: true,
    source: "paper-simulation",
    symbol: task.symbol,
    timeframe: task.timeframe,
    historyCount: candles.length,
    latest: { price: Number(current.close.toFixed(4)), open: Number(current.open.toFixed(4)), high: Number(current.high.toFixed(4)), low: Number(current.low.toFixed(4)), volume: Number(current.volume.toFixed(2)) },
    changePct: Number((((current.close - candles.at(-2).close) / candles.at(-2).close) * 100).toFixed(2)),
    indicators: { ema20: Number(ema20.toFixed(4)), rsi14: Number(rsi14.toFixed(2)), atr14: Number(atr(candles, 14).toFixed(4)), volumeRatio: Number(volumeRatio.toFixed(2)) },
    trend,
    anomaly,
    freshnessSec: 1.2,
    evidenceId,
    observedAt: new Date().toISOString(),
  };
}
