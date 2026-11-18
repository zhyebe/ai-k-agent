import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { algorithmCandleProbeDecision, algorithmEntryDecision, algorithmEntryPriceInPlan, recheckAlgorithmEntry } from "../server/algorithm-strategy.mjs";
import { executableExitQuote } from "../server/exit-policy.mjs";
import { candleWickState } from "../server/flash-k.mjs";
import { observeSummaryPlans, summaryExitCandidates, summaryReviewType, summarySignature } from "../server/summary-exit-policy.mjs";
import { matchesInstrument, profitProtectionFor } from "../server/trading-plan.mjs";

const MINUTE_MS = 60_000;

function sameInstrument(left, right) {
  if (left.instrumentId && right.instrumentId) return String(left.instrumentId) === String(right.instrumentId);
  return matchesInstrument(left, right);
}

export async function replayAlgorithm(snapshots, quantity = 1) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("数量必须是正整数");
  const task = {};
  const trades = [];
  let previousAt = -Infinity, instrument, signal, position;
  for await (const book of snapshots) {
    const now = Date.parse(book?.observedAt || "");
    if (!Number.isFinite(now) || now <= previousAt) throw new Error("快照必须按 observedAt 严格递增");
    if (instrument ? !sameInstrument(instrument, book) : !(book.symbol || book.instrumentId || book.symbolName)) {
      throw new Error("每个回放文件只接受同一个交易品种");
    }
    instrument ||= { symbol: book.symbol, instrumentId: book.instrumentId, symbolName: book.symbolName };
    previousAt = now;
    if (position) {
      const market = { ...book, account: { positionsVerified: true, positions: [],
        positionSummariesVerified: true, positionSummaries: [position], openOrdersVerified: true, openOrders: [] } };
      observeSummaryPlans(task, market, now);
      const [candidate] = summaryExitCandidates(task, market, now);
      if (!candidate) continue;
      const { price } = executableExitQuote(market, position, now);
      const points = (price - position.averagePrice) * (position.side === "LONG" ? 1 : -1) * quantity;
      const costs = [position.entryCostPoints, book.executionCostPoints];
      const netPoints = costs.every(cost => typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
        ? points - (costs[0] + costs[1]) * quantity : null;
      trades.push({ side: position.side, entryAt: task.entryForecast.confirmedAt, exitAt: book.observedAt,
        entryPrice: position.averagePrice, targetPrice: task.entryForecast.tradePlan.takeProfitPrice, exitPrice: price,
        exitReason: candidate.decision.exitReason, grossPoints: points, netPoints });
      position = null;
      Object.assign(task, { summaryTradingPlans: [], summaryExitPriceWaits: [], entryForecast: null });
      continue;
    }
    if (signal) {
      const { action, observedAt, tradePlan, decisionTtlSec } = signal;
      const entryGuard = { ...instrument, plan: tradePlan, expiresAt: new Date(Date.parse(observedAt) + decisionTtlSec * 1000).toISOString() };
      const quote = recheckAlgorithmEntry(book, { action, quantity, entryGuard, now });
      if (quote.ok) {
        position = { ...instrument, quantity, frozenQuantity: 0, side: action === "BUY" ? "LONG" : "SHORT",
          averagePrice: quote.price, entryCostPoints: book.executionCostPoints };
        task.entryForecast = { ...instrument, pendingId: `replay-${now}`, action, decisionSource: "ALGORITHM",
          tradePlan, observedAt, confirmedAt: book.observedAt };
        signal = null;
        continue;
      }
    }
    const decision = algorithmEntryDecision(book, { quantity, now });
    signal = decision.action === "HOLD" ? null : decision;
  }
  const openPosition = position ? { side: position.side, entryPrice: position.averagePrice, entryAt: task.entryForecast.confirmedAt } : null;
  return { mode: "ORDER_BOOK_REPLAY", ...reportTrades(trades, openPosition) };
}

export async function probeAlgorithmCandles(candles, quantity = 1) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("数量必须是正整数");
  const history = [];
  const trades = [];
  let instrument, previousAt = -Infinity, signal, position, record;
  for await (const candle of candles) {
    const { timestamp, open, close } = candle;
    const shape = candleWickState(candle);
    if (!Number.isSafeInteger(timestamp) || timestamp <= previousAt || timestamp % MINUTE_MS || !shape) {
      throw new Error("分钟 K 需要有效 OHLC 和严格递增的整分钟毫秒时间戳");
    }
    if (instrument ? !sameInstrument(instrument, candle) : !(candle.symbol || candle.instrumentId || candle.symbolName)) {
      throw new Error("每个回放文件只接受同一个交易品种");
    }
    instrument ||= { symbol: candle.symbol, instrumentId: candle.instrumentId, symbolName: candle.symbolName };
    const now = timestamp + MINUTE_MS;
    if (signal && timestamp === previousAt + MINUTE_MS && algorithmEntryPriceInPlan(signal.tradePlan, open, signal.action)) {
      const { tradePlan, action, algorithmForecast } = signal;
      position = { ...instrument, quantity, side: action === "BUY" ? "LONG" : "SHORT", averagePrice: open,
        entryAt: new Date(timestamp).toISOString(), expectedExitBars: algorithmForecast?.expectedExitBars ?? null };
      record = { plan: tradePlan, signature: summarySignature(position), maxHoldAt: new Date(timestamp + tradePlan.maxHoldSec * 1000).toISOString(),
        bestPrice: open, profitArmed: false };
    }
    signal = null;
    previousAt = timestamp;
    history.push(candle);
    if (history.length > 720) history.shift();
    if (shape !== "HAS_WICK") continue;
    if (position) {
      const direction = position.side === "LONG" ? 1 : -1;
      if ((close - record.bestPrice) * direction > 0) record.bestPrice = close;
      const protection = profitProtectionFor(position, record.plan);
      if (protection && (close - protection.activationPrice) * direction >= 0) record.profitArmed = true;
      const exitReason = summaryReviewType(position, close, record, now);
      if (exitReason) {
        trades.push({ side: position.side, entryAt: position.entryAt, exitAt: new Date(now).toISOString(),
          entryPrice: position.averagePrice, targetPrice: record.plan.takeProfitPrice, exitPrice: close, expectedExitBars: position.expectedExitBars,
          exitReason, grossPoints: (close - position.averagePrice) * direction * quantity, netPoints: null });
        position = null;
        record = null;
      }
      continue;
    }
    const decision = algorithmCandleProbeDecision({ ...instrument, timeframe: "1m", history }, close, now);
    if (decision.action !== "HOLD") signal = decision;
  }
  const openPosition = position ? { side: position.side, entryPrice: position.averagePrice, entryAt: position.entryAt } : null;
  return { mode: "MINUTE_CANDLE_PROBE", ...reportTrades(trades, openPosition) };
}

function reportTrades(trades, openPosition) {
  const byExitReason = new Map();
  for (const trade of trades) {
    if (!byExitReason.has(trade.exitReason)) byExitReason.set(trade.exitReason, []);
    byExitReason.get(trade.exitReason).push(trade.grossPoints);
  }
  return { closedTrades: trades.length, openPosition,
    gross: totals(trades.map(trade => trade.grossPoints)),
    net: trades.length && trades.every(trade => trade.netPoints !== null) ? totals(trades.map(trade => trade.netPoints)) : null,
    byExitReason: Object.fromEntries([...byExitReason].map(([reason, points]) => [reason, { trades: points.length, ...totals(points) }])),
    trades };
}

function totals(points) {
  let profit = 0, loss = 0, peak = 0, drawdown = 0;
  for (const result of points) {
    if (result > 0) profit += result;
    else loss -= result;
    peak = Math.max(peak, profit - loss);
    drawdown = Math.max(drawdown, peak - (profit - loss));
  }
  const round = value => Number(value.toFixed(8));
  return { profit: round(profit), loss: round(loss), total: round(profit - loss),
    profitFactor: loss > 0 ? round(profit / loss) : null, maxClosedTradeDrawdown: round(drawdown) };
}

async function* readSnapshots(input) {
  let number = 0;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    number += 1;
    if (!line.trim()) continue;
    try { yield JSON.parse(line); }
    catch (error) { throw new Error(`第 ${number} 行 JSON 无效`, { cause: error }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const candleMode = args[0] === "--candles";
  if (candleMode) args.shift();
  const [file, quantityArg = "1"] = args;
  const quantity = Number(quantityArg);
  try {
    if (!file || args.length > 2 || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("用法 node scripts/replay-algorithm.mjs [--candles] <行情.jsonl> [数量]");
    }
    const snapshots = readSnapshots(file === "-" ? process.stdin : createReadStream(file));
    const result = await (candleMode ? probeAlgorithmCandles(snapshots, quantity) : replayAlgorithm(snapshots, quantity));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
