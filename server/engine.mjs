import { callProviderMethod, desktopAiRequired, hasDesktopAi } from "./desktop-ai.mjs";
import { callBrowserMethod, desktopBrowserRequired } from "./desktop-browser.mjs";
import { analysisTimeoutMs, buildLayeredAnalysisMarket, buildMarketAnalysisSegments, buildRecentMonitoringMarket, compactCollectedMarket, compactSegmentReview, confirmedCandlesForAnalysis, estimateMarketContextBytes, LIVE_BOARD_STRATEGY, nextCandleTarget, shouldUseSegmentedAnalysis, summarizeMarketForDecision } from "./analysis-context.mjs";
import { approvedKnowledgeForAnalysis, approvedSkillsForContext, buildApprovedExperiencePrompt } from "./rag.mjs";
import { DEFAULT_AUTO_DECISION_COUNTDOWN_SEC, executeDecision, isAutomaticAction, isLiveTask, isTradingSwitchOn, shouldSubmitLiveOrder, suggestOrderPreview } from "./execution.mjs";
import { entryQuantityForTask } from "./order-quantity.mjs";
import { CURRENT_ORDER_WAIT_MS, currentOrderCancellationPlan } from "./order-cancellation-policy.mjs";
import { blockingMissingFields } from "./market.mjs";
import { credentialExists } from "./vault.mjs";
import { addEvent, appendAgentOutput, findProviderForUser, finishAgentRun, getConnector, getTask, persistAnalysis, persistOrder, persistTask, startAgentRun, state } from "./store.mjs";
import { accountMetricsFromMarket, HAO_HAN_TARGET_URL, uniqueBoardAssessments } from "./haohan.mjs";
import { normalizeUnitProbability } from "./provider.mjs";
import { entryRoundBlock, normalizeMarketRegime, hasDirectionalProbabilities, MIN_PROFIT_PROBABILITY } from "./entry-policy.mjs";
import { summarizeOrderBook } from "./order-book.mjs";
import { exitNetPnl, evaluateExitPlan, executableExitQuote, heldDirection, isNonLosingExit, positionEntryPrice, validateExitPlans } from "./exit-policy.mjs";
import { summaryExitCandidates, summaryExitAllowsPrice, summaryKey, summaryExitReviewContexts, SUMMARY_PROFIT_POINTS, SUMMARY_LOSS_POINTS, SUMMARY_REVIEW_TTL_MS } from "./summary-exit-policy.mjs";

const activeCycles = new Set();
const cycleWaiters = new Map();
const controllerLoops = new Map();
const pendingActionTimers = new Map();
const pendingConfirmLocks = new Set();
const pendingSubmissionCancels = new Map();
const positionExitRuns = new Map();
const positionExitCancels = new Map();
const liveAnalyses = new Map();
const liveObservations = new Map();
const summaryReviewRuns = new Map();
const actionPhaseLocks = new Set();
const loginRecoveryRuns = new Map();
const LOGIN_HEARTBEAT_INTERVAL_MS = 5000;
const SUBMITTING_RECOVERY_TIMEOUT_MS = 15000;
const DEFAULT_MONITOR_POLL_MS = 0;
const DEFAULT_MONITOR_RETRY_MS = 1000;
const MAX_MONITOR_POLL_MS = 120000;
const DEFAULT_ANALYSIS_KNOWLEDGE_BYTES = 96000;

class CycleAbortError extends Error {
  constructor(code) {
    super(code);
    this.name = "CycleAbortError";
    this.code = code;
  }
}

function analysisTimeoutError(cause) {
  const error = new Error("ANALYSIS_TIMEOUT");
  error.code = "ANALYSIS_TIMEOUT";
  if (cause) error.cause = cause;
  return error;
}

function isAnalysisTimeout(error) {
  const message = String(error?.message || error || "");
  return error?.code === "ANALYSIS_TIMEOUT"
    || message === "ANALYSIS_TIMEOUT"
    || message === "DESKTOP_AI_TIMEOUT"
    || message === "DESKTOP_CALL_EXPIRED"
    || error?.name === "TimeoutError"
    || /aborted|AbortError/i.test(message);
}

function positionIdentity(account) {
  return JSON.stringify((account?.positions || []).map(p => [p.positionOrderId, p.symbol, p.instrumentId,
    heldDirection(p), Number(p.quantity), positionEntryPrice(p), Number(p.frozenQuantity || 0), p.roundTripFee ?? p.totalFees ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function changedLiveMarket(baseline, fresh) {
  if (fresh?.ok !== true || fresh.account?.positionsVerified !== true) return "LIVE_OBSERVATION_UNVERIFIED";
  if (positionIdentity(baseline.account) !== positionIdentity(fresh.account)) return "POSITION_CHANGED_DURING_ANALYSIS";
  for (const book of fresh.books?.length ? fresh.books : [fresh]) {
    const prior = positionMarketSnapshot(baseline, book);
    if (!prior) continue;
    const prices = item => {
      const depth = summarizeOrderBook(item?.orderBook || item?.pageView?.orderBook);
      return [depth.bids[0]?.price ?? null, depth.asks[0]?.price ?? null, depth.status];
    };
    const before = prior.timeframes?.["1m"]?.history || (prior.timeframe === "1m" ? prior.history : null);
    const after = book.timeframes?.["1m"]?.history || (book.timeframe === "1m" ? book.history : null);
    if (before?.length && after?.length && [...before.slice(-2), ...after.slice(-2)].some(c => c.confirmation)) {
      const signature = (rows, observedAt) => JSON.stringify(confirmedCandlesForAnalysis(rows, "1m", Date.parse(observedAt)).slice(-2)
        .map(c => [c.timestamp, c.open, c.high, c.low, c.close]));
      if (signature(before, prior.observedAt || baseline.observedAt) !== signature(after, book.observedAt || fresh.observedAt)) return "CANDLE_CHANGED_DURING_ANALYSIS";
    }
    if (JSON.stringify(prices(prior)) !== JSON.stringify(prices(book))) return "MARKET_CHANGED_DURING_ANALYSIS";
  }
  return null;
}

function recordLiveObservation(task, market) {
  const generation = taskGeneration(task);
  const previous = liveObservations.get(task.id);
  const samples = previous?.generation === generation ? previous.samples : [];
  const sample = { observedAt: market.observedAt, positionsVerified: market.account?.positionsVerified === true,
    positions: (market.account?.positions || []).map(position => ({ positionId: position.positionOrderId,
      side: heldDirection(position), quantity: position.quantity, entryPrice: positionEntryPrice(position),
      exitQuotePrice: executableExitQuote(market, position)?.price ?? null })) };
  if (sample.observedAt !== samples.at(-1)?.observedAt) samples.push(sample);
  liveObservations.set(task.id, { generation, samples: samples.slice(-30) });
  const analysis = liveAnalyses.get(task.id);
  if (analysis?.generation !== generation) return;
  const reason = changedLiveMarket(analysis.market, market);
  // Ordinary ticks must not starve the model forever. Keep observing while it
  // finishes; final revalidation rejects stale entries. Program summary exits
  // and changed holdings/candles invalidate the old analysis immediately.
  if (reason && (reason !== "MARKET_CHANGED_DURING_ANALYSIS"
    || summaryExitCandidates(task, market).length > 0)) {
    analysis.abort.abort(new Error(reason));
  }
}

function recentLiveObservations(task) {
  const observations = liveObservations.get(task.id);
  return observations?.generation === taskGeneration(task) ? observations.samples : [];
}

function taskGeneration(task) {
  const value = Number(task?.monitorGeneration || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function advanceTaskGeneration(task) {
  task.monitorGeneration = taskGeneration(task) + 1;
  return task.monitorGeneration;
}

function assertCycleCurrent(task, generation) {
  if (task?.stopLocked) throw new CycleAbortError("STOP_LOCKED");
  if (taskGeneration(task) !== generation) throw new CycleAbortError("CYCLE_INVALIDATED");
}

function resolveRuntime(overrides = {}, { userId = "", providerId = "" } = {}) {
  const use = (name, fallback) => typeof overrides?.[name] === "function" ? overrides[name] : fallback;
  const browserProvider = providerId ? findProviderForUser(String(providerId), String(userId || "")) : null;
  const withBrowserProvider = (input = {}) => browserProvider?.id ? { ...input, provider: browserProvider } : input;
  return {
    openMarketBrowser: use("openMarketBrowser", (task, connector) => callBrowserMethod("openMarketBrowser", userId, { task, connector })),
    browserLoginStatus: use("browserLoginStatus", (input) => callBrowserMethod("browserLoginStatus", userId, input)),
    browserLogin: use("browserLogin", (input) => callBrowserMethod("browserLogin", userId, withBrowserProvider(input))),
    observeMarket: use("observeMarket", (task, connector) => callBrowserMethod("observeMarket", userId, { task, connector })),
    observeExecutionMarket: use("observeExecutionMarket", (task, connector, options) => callBrowserMethod("observeExecutionMarket", userId, { task, connector }, options)),
    requestDecision: use("requestDecision", (provider, context, options) => callProviderMethod("requestDecision", userId, { provider, context, options })),
    requestSummaryExitDecision: use("requestSummaryExitDecision", (provider, context, options) => callProviderMethod("requestSummaryExitDecision", userId, { provider, context, options, signal: options?.signal })),
    requestMarketAnalysis: use("requestMarketAnalysis", (provider, context, options) => callProviderMethod("requestMarketAnalysis", userId, { provider, context, options, channel: "browser" })),
    requestSegmentReview: use("requestSegmentReview", (provider, segment, context, options) => callProviderMethod("requestSegmentReview", userId, { provider, segment, context, options })),
    executeDecision: use("executeDecision", executeDecision),
    fillSuggestionForm: use("fillSuggestionForm", (input) => callBrowserMethod("fillSuggestionForm", userId, withBrowserProvider(input))),
    continueManualEntry: use("continueManualEntry", (input) => callBrowserMethod("continueManualEntry", userId, input)),
    submitSuggestionForm: use("submitSuggestionForm", (input, options) => callBrowserMethod("submitSuggestionForm", userId, withBrowserProvider(input), options)),
    cancelOpenOrders: use("cancelOpenOrders", (input, options) => callBrowserMethod("cancelOpenOrders", userId, input, options)),
  };
}

function isAutoTakeover(task, decision = task?.decision) {
  return isAutomaticAction(task, decision);
}

function pendingWaitMessage(task, { auto = false } = {}) {
  if (auto && isLiveTask(task)) return "全自动接管：分析通过后直接下单或离场，持续核实持仓";
  if (auto) return "全自动接管：分析通过后直接记录，观察模式不会下单";
  if (isLiveTask(task)) return "手动入场：AI 只填表，请在目标页点击入场按钮；成交后程序监控持仓汇总离场";
  return "请确认建议；观察模式不会下单";
}

function pendingTargetLabel(pending) {
  return String(pending?.targetSymbolName || pending?.targetSymbol || pending?.targetInstrumentId || "目标盘口");
}

function pendingActionLabel(pending) {
  if (pending?.exitType === "TAKE_PROFIT" || pending?.exitType === "STOP_LOSS") return pending?.action === "BUY" ? "转让回补" : "转让卖出";
  if (pending?.action === "BUY") return "买涨";
  if (pending?.action === "SELL") return "买跌";
  return "观望";
}

function openPositionsFromMarket(market) {
  const positions = Array.isArray(market?.account?.positions)
    ? market.account.positions
    : Array.isArray(market?.positions) ? market.positions : [];
  return positions.filter((item) => Number(item?.quantity) > 0);
}

function positionDirection(position) {
  const side = String(position?.side || "");
  if (/卖|空|short/i.test(side)) return "SHORT";
  if (/买|多|long/i.test(side)) return "LONG";
  return "UNKNOWN";
}

function parsePositionTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/年/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, " ")
    .replace(/[时点]/g, ":")
    .replace(/分/g, ":")
    .replace(/秒/g, "")
    .replace(/:\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Haohan's unzoned order times are Beijing time, regardless of API host TZ.
  const local = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/);
  const zoned = local
    ? `${local[1]}-${local[2].padStart(2, "0")}-${local[3].padStart(2, "0")}T${local[4].padStart(2, "0")}:${local[5]}:${local[6] || "00"}${local[7] || ""}+08:00`
    : normalized;
  const parsed = new Date(zoned).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function positionMarketSnapshot(market, position) {
  const targets = normalizedInstrumentValues(position);
  const matches = (book) => normalizedInstrumentValues(book).some((value) => targets.includes(value));
  return (Array.isArray(market?.books) ? market.books : []).find(matches)
    || (matches(market) ? market : null);
}

function positionTrackingKey(position, index) {
  return String(position?.positionOrderId || `${position?.symbol || position?.symbolName || "position"}:${position?.side || "UNKNOWN"}:${index}`);
}

function updatePositionTracking(task, market, now = Date.now()) {
  if (market?.account?.positionsVerified === false) return [];
  const positions = openPositionsFromMarket(market);
  const previous = task.positionTracking && typeof task.positionTracking === "object" ? task.positionTracking : {};
  const next = {};
  const contexts = positions.map((position, index) => {
    const key = positionTrackingKey(position, index);
    const direction = positionDirection(position);
    const entryPrice = positionEntryPrice(position);
    const snapshot = positionMarketSnapshot(market, position);
    const price = Number(snapshot?.latest?.price ?? snapshot?.quote?.price);
    const displayUnconfirmed = snapshot?.flashK?.suspected || (snapshot?.timeframes?.["1m"]?.history || snapshot?.history || [])
      .some(candle => candle.confirmation?.status === "PROVISIONAL" && Number(candle.close) === price);
    const currentPrice = !displayUnconfirmed && Number.isFinite(price) && price > 0 ? price : null;
    const orderBook = summarizeOrderBook(snapshot?.orderBook || snapshot?.pageView?.orderBook);
    const exitQuote = orderBook.status === "CROSSED" ? null : direction === "LONG" ? orderBook.bids[0] : direction === "SHORT" ? orderBook.asks[0] : null;
    const exitQuotePrice = exitQuote?.volume > 0 ? exitQuote.price : null;
    const prior = previous[key] || {};
    const orderTimeMs = parsePositionTimestamp(position?.orderTime);
    const priorTimeMs = Date.parse(prior.firstObservedAt || "");
    // Prefer the real entry time; also repairs persisted UTC-misparsed values.
    const firstObservedAt = orderTimeMs !== null && orderTimeMs <= now
      ? new Date(orderTimeMs).toISOString()
      : Number.isFinite(priorTimeMs) && priorTimeMs <= now ? prior.firstObservedAt : new Date(now).toISOString();
    const bestPrice = Number.isFinite(Number(prior.bestPrice)) && Number(prior.bestPrice) > 0
      ? Number(prior.bestPrice) : currentPrice;
    const worstPrice = Number.isFinite(Number(prior.worstPrice)) && Number(prior.worstPrice) > 0
      ? Number(prior.worstPrice) : currentPrice;
    const updatedBest = currentPrice === null ? bestPrice : direction === "SHORT" ? Math.min(bestPrice || currentPrice, currentPrice) : Math.max(bestPrice || currentPrice, currentPrice);
    const updatedWorst = currentPrice === null ? worstPrice : direction === "SHORT" ? Math.max(worstPrice || currentPrice, currentPrice) : Math.min(worstPrice || currentPrice, currentPrice);
    const validPrices = entryPrice > 0 && currentPrice > 0;
    const knownDirection = direction === "LONG" || direction === "SHORT";
    const exitQuotePnlPoints = knownDirection && entryPrice > 0 && exitQuotePrice > 0
      ? (direction === "SHORT" ? entryPrice - exitQuotePrice : exitQuotePrice - entryPrice) : null;
    const exitPnl = exitQuotePrice === null ? null : exitNetPnl(position, exitQuotePrice);
    const unrealizedPnlPct = validPrices && knownDirection ? (direction === "SHORT" ? (entryPrice - currentPrice) : (currentPrice - entryPrice)) / entryPrice * 100 : null;
    const maxFavorableExcursionPct = knownDirection && entryPrice > 0 && updatedBest > 0 && updatedWorst > 0
      ? Math.max(0, direction === "SHORT" ? (entryPrice - updatedBest) : (updatedBest - entryPrice)) / entryPrice * 100 : null;
    const maxAdverseExcursionPct = knownDirection && entryPrice > 0 && updatedBest > 0 && updatedWorst > 0
      ? Math.min(0, (direction === "SHORT" ? (entryPrice - updatedWorst) : (updatedWorst - entryPrice)) / entryPrice * 100) : null;
    const pullbackFromBestPct = validPrices && knownDirection && updatedBest > 0
      ? (direction === "SHORT" ? (currentPrice - updatedBest) : (updatedBest - currentPrice)) / entryPrice * 100 : null;
    const firstObservedMs = new Date(firstObservedAt).getTime();
    const holdingDurationSec = Number.isFinite(firstObservedMs) ? Math.max(0, Math.round((now - firstObservedMs) / 1000)) : 0;
    const context = {
      positionId: String(position?.positionOrderId || ""),
      symbol: String(position?.symbol || ""),
      symbolName: String(position?.symbolName || ""),
      side: direction,
      quantity: Number(position?.quantity || 0),
      entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
      currentPrice,
      exitQuotePrice,
      exitQuoteQuantity: exitQuotePrice === null ? null : exitQuote.volume,
      exitQuotePnlPoints: exitQuotePnlPoints === null ? null : Number(exitQuotePnlPoints.toFixed(8)),
      exitQuoteGrossPnl: exitPnl?.grossPnl ?? null,
      exitQuoteFees: exitPnl?.fees ?? null,
      exitQuoteNetPnl: exitPnl?.netPnl ?? null,
      exitQuotePnlPct: exitQuotePnlPoints === null ? null : Number((exitQuotePnlPoints / entryPrice * 100).toFixed(4)),
      orderTime: position?.orderTime || null,
      firstObservedAt,
      holdingDurationSec,
      unrealizedPnlPct: unrealizedPnlPct === null ? null : Number(unrealizedPnlPct.toFixed(4)),
      maxFavorableExcursionPct: maxFavorableExcursionPct === null ? null : Number(maxFavorableExcursionPct.toFixed(4)),
      maxAdverseExcursionPct: maxAdverseExcursionPct === null ? null : Number(maxAdverseExcursionPct.toFixed(4)),
      pullbackFromBestPct: pullbackFromBestPct === null ? null : Number(pullbackFromBestPct.toFixed(4)),
    };
    next[key] = { firstObservedAt, bestPrice: updatedBest || null, worstPrice: updatedWorst || null, lastPrice: currentPrice };
    return context;
  });
  task.positionTracking = next;
  return contexts;
}

function pendingPositions(market, pending) {
  const ids = new Set((pending?.targetPositionIds || []).map(String).filter(Boolean));
  const targets = [pending?.targetSymbol, pending?.targetSymbolName, pending?.targetInstrumentId]
    .map((value) => String(value || "").trim().toLocaleLowerCase()).filter(Boolean);
  const heldSide = pending?.exitType ? (pending.action === "BUY" ? "SELL" : "BUY") : pending?.action;
  return openPositionsFromMarket(market).filter((position) => {
    if (ids.size) return ids.has(String(position.positionOrderId || ""));
    const matchesTarget = targets.some((target) => [position.symbol, position.symbolName, position.instrumentId]
      .some((value) => {
        const normalized = String(value || "").trim().toLocaleLowerCase();
        return normalized === target;
      }));
    const side = String(position.side || "");
    return matchesTarget && (heldSide === "BUY" ? /买|多|long/i.test(side) : /卖|空|short/i.test(side));
  });
}

function pendingPositionQuantity(market, pending) {
  if (pending?.targetSummary) return (market.account?.positionSummaries || [])
    .filter(row => summaryKey(row) === summaryKey(pending.targetSummary)).reduce((sum, row) => sum + Number(row.quantity), 0);
  return pendingPositions(market, pending).reduce((sum, position) => sum + Number(position.quantity || 0), 0);
}

function unsettledActions(task) {
  return [...(task.unsettledActions || []), task.pendingAction].filter((item) => item && ["AWAITING_FILL", "UNVERIFIED"].includes(item.status));
}

function archivePendingSubmission(task) {
  const pending = task.pendingAction;
  if (pending && ["AWAITING_FILL", "UNVERIFIED"].includes(pending.status)) {
    task.unsettledActions = [...(task.unsettledActions || []).filter((item) => item.id !== pending.id), pending];
  }
  if (pending && !pending.exitType && pending.entryKWindow && !["CANCELLED", "REJECTED"].includes(pending.status)) task.lastEntryKWindow = pending.entryKWindow;
}

function executableExitDecision(task, decision, market = task.market) {
  if (!decision.exitType) return decision;
  if (isLiveTask(task)) {
    if (!decision.targetSummary || !decision.exitGuard?.summary) return { ...decision, targetPositionIds: [] };
    const busy = unsettledActions(task).some(action => action.targetSummary
      && summaryKey(action.targetSummary) === summaryKey(decision.targetSummary));
    return busy ? { ...decision, targetSummary: null, targetPositionIds: [] } : decision;
  }
  // Only the same position's submitted transfer is deduplicated, never all trading.
  const exitingIds = new Set(unsettledActions(task).filter((item) => item.exitType).flatMap((item) => item.targetPositionIds || []));
  const targetPositionIds = (decision.targetPositionIds || []).filter((id) => !exitingIds.has(id));
  const exitGuard = decision.exitGuard?.positions ? { ...decision.exitGuard, positions: decision.exitGuard.positions.filter(p => targetPositionIds.includes(p.positionId)) } : decision.exitGuard;
  return { ...decision, targetPositionIds, exitGuard };
}

function openPositionCount(market) {
  return openPositionsFromMarket(market).length;
}

function closingActionForPositions(positions) {
  const side = String(positions[0]?.side || "");
  if (/卖|空|short/i.test(side)) return "BUY";
  if (/买|多|long/i.test(side)) return "SELL";
  return null;
}

export function attachPositionExit(decision, market = {}) {
  const positions = openPositionsFromMarket(market);
  if (!decision?.exitType) return decision;
  const requestedIds = (Array.isArray(decision?.targetPositionIds) ? decision.targetPositionIds : []).map(String).filter(Boolean);
  const fail = (flag) => ({
    ...decision,
    action: "HOLD",
    exitType: null,
    riskFlags: [...new Set([...(decision?.riskFlags || []), flag])],
  });
  if (!positions.length) return market.account?.positionsVerified === true ? fail("EXIT_TARGET_NOT_FOUND") : decision;
  if (decision?.exitType !== "TAKE_PROFIT" && decision?.exitType !== "STOP_LOSS") return fail("EXIT_TYPE_REQUIRED");
  const targetValues = [decision.targetSymbol, decision.targetSymbolName, decision.targetInstrumentId]
    .map((value) => String(value || "").trim().toLocaleLowerCase()).filter(Boolean);
  const matchesTarget = (position) => !targetValues.length || [position.symbol, position.symbolName, position.instrumentId]
    .map((value) => String(value || "").trim().toLocaleLowerCase())
    .some((value) => value && targetValues.includes(value));
  const expectedHeldSide = decision.action === "SELL" ? "long" : decision.action === "BUY" ? "short" : "";
  const matchesHeldSide = (position) => {
    if (!expectedHeldSide) return true;
    const side = String(position.side || "");
    return expectedHeldSide === "long" ? /买|多|long/i.test(side) : /卖|空|short/i.test(side);
  };
  const matched = requestedIds.length
    ? positions.filter((item) => requestedIds.includes(String(item.positionOrderId || "")))
    : positions.filter((item) => matchesTarget(item) && matchesHeldSide(item));
  if (!matched.length) return fail(requestedIds.length ? "EXIT_TARGET_NOT_FOUND" : "EXIT_TARGET_REQUIRED");
  const wrongDirection = matched.some((item) => closingActionForPositions([item]) !== decision.action);
  if (wrongDirection) return fail("EXIT_DIRECTION_MISMATCH");
  const primary = matched[0];
  if (decision.exitType === "TAKE_PROFIT" && market.account?.positionsVerified === true) {
    const unverifiedProfit = matched.some((position) => {
      const quote = executableExitQuote(market, position, Date.now());
      return !quote || !isNonLosingExit(position, quote.price);
    });
    if (unverifiedProfit) return fail("EXIT_PROFIT_NOT_VERIFIED");
  }
  const targeted = {
    ...decision,
    targetPositionIds: matched.every((item) => String(item.positionOrderId || "").trim())
      ? matched.map((item) => String(item.positionOrderId))
      : [],
    targetSymbol: decision?.targetSymbol || primary.symbol || "",
    targetSymbolName: decision?.targetSymbolName || primary.symbolName || "",
    targetInstrumentId: decision?.targetInstrumentId || primary.instrumentId || "",
  };
  return targeted;
}

function shouldUseRecentMonitoring(monitorRecentOnly, market) {
  return monitorRecentOnly === true && openPositionCount(market) === 0 && !market.account?.openOrders?.length;
}

export function profitSignalTier(value) {
  const probability = Number(value || 0);
  if (probability > 0.9) return "VERY_STRONG";
  if (probability > 0.8) return "STRONG";
  if (probability > 0.7) return "STANDARD";
  if (probability > 0.6) return "CAUTIOUS";
  if (probability >= MIN_PROFIT_PROBABILITY) return "EXPLORATORY";
  return "HOLD";
}

export function profitSignalLabel(tier) {
  return ({ AI_RECOGNITION: "AI 趋势决策", EXPLORATORY: "试探提示", CAUTIOUS: "谨慎提示", STANDARD: "可交易提示", STRONG: "较强提示", VERY_STRONG: "强信号提示" })[tier] || "观望";
}

function profitProbabilityLabel(value) {
  const percent = Math.max(0, Math.min(100, Number(value || 0) * 100));
  const label = percent >= 49 && percent < 52 ? percent.toFixed(1) : Math.round(percent).toString();
  return label.endsWith(".0") ? label.slice(0, -2) : label;
}

function positivePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function chosenSideProbability(decision) {
  const overall = Number(decision?.profitProbability || 0);
  if (decision?.action === "BUY") {
    return Number(decision?.bullishProfitProbability || 0);
  }
  if (decision?.action === "SELL") {
    return Number(decision?.bearishProfitProbability || 0);
  }
  return overall;
}

function signalTierForDecision(decision) {
  return ["BUY", "SELL"].includes(decision?.action) ? "AI_RECOGNITION" : "HOLD";
}

export function meetsOrderBoundary(decision) {
  if (decision?.exitType === "TAKE_PROFIT" || decision?.exitType === "STOP_LOSS") return true;
  if (decision?.action !== "BUY" && decision?.action !== "SELL") return false;
  return decision.directionalProbabilitiesComplete !== false
    && hasDirectionalProbabilities(decision) && chosenSideProbability(decision) >= MIN_PROFIT_PROBABILITY;
}

export function applyEntryBoundary(decision, market = {}) {
  const next = { ...decision };
  delete next.entryBlock;
  if (["TAKE_PROFIT", "STOP_LOSS"].includes(next.exitType)) return next;
  if (["BUY", "SELL"].includes(next.action) && !meetsOrderBoundary(next)) {
    const reason = hasDirectionalProbabilities(next) ? "LOW_PROFIT_PROBABILITY" : "INCOMPLETE_DIRECTIONAL_PROBABILITIES";
    next.action = "HOLD";
    next.entryBlock = { requestedAction: decision.action, reason };
    next.riskFlags = [...new Set([...(next.riskFlags || []), reason])];
  }
  next.signalTier = signalTierForDecision(next);
  return next;
}

export function enforceProfitProbability(decision) {
  const next = {
    ...decision,
    directionalProbabilitiesComplete: decision?.directionalProbabilitiesComplete !== false && hasDirectionalProbabilities(decision),
    profitProbability: normalizeUnitProbability(decision?.profitProbability),
    bullishProfitProbability: normalizeUnitProbability(decision?.bullishProfitProbability),
    bearishProfitProbability: normalizeUnitProbability(decision?.bearishProfitProbability),
  };
  next.signalTier = signalTierForDecision(next);
  if (meetsOrderBoundary(next)) {
    next.riskFlags = (next.riskFlags || []).filter((flag) => flag !== "LOW_PROFIT_PROBABILITY");
  } else if (next.action === "BUY" || next.action === "SELL") {
    next.riskFlags = [...new Set([...(next.riskFlags || []), hasDirectionalProbabilities(next) ? "LOW_PROFIT_PROBABILITY" : "INCOMPLETE_DIRECTIONAL_PROBABILITIES"])];
  }
  return next;
}

export function buildPendingAction(task, decision, { now = Date.now(), replacePendingId } = {}) {
  const auto = isAutoTakeover(task, decision);
  const preview = suggestOrderPreview(task, decision, { enforceQuantityLimit: isLiveTask(task) });
  const action = decision.action === "SELL" ? "SELL" : "BUY";
  const targetLabel = String(decision.targetSymbolName || decision.targetSymbol || decision.targetInstrumentId || "目标盘口");
  const decisionProbability = chosenSideProbability(decision);
  const signalTier = decision.signalTier || signalTierForDecision(decision);
  const signalLabel = profitSignalLabel(signalTier);
  const probabilityLabel = `${profitProbabilityLabel(decisionProbability)}%`;
  return {
    id: `pending_${now}_${Math.random().toString(36).slice(2, 8)}`,
    decisionRunId: decision.runId || null,
    entryPurpose: "NORMAL",
    action,
    orderType: decision.orderType || "MARKET",
    marketRegime: normalizeMarketRegime(decision.marketRegime),
    exitType: decision.exitType || null,
    exitGuard: decision.exitGuard || null,
    targetSummary: decision.targetSummary || null,
    targetPositionIds: Array.isArray(decision.targetPositionIds) ? decision.targetPositionIds : [],
    targetSymbol: String(decision.targetSymbol || ""),
    targetSymbolName: String(decision.targetSymbolName || ""),
    targetInstrumentId: String(decision.targetInstrumentId || ""),
    targetPrice: preview.targetPrice ?? preview.suggestedPrice,
    entryPrice: positivePrice(decision.entryPrice),
    takeProfitPrice: positivePrice(decision.takeProfitPrice),
    stopLossPrice: positivePrice(decision.stopLossPrice),
    profitProbability: decisionProbability,
    directionalProbabilitiesComplete: decision.directionalProbabilitiesComplete !== false && hasDirectionalProbabilities(decision),
    bullishProfitProbability: Number(decision.bullishProfitProbability || 0),
    bearishProfitProbability: Number(decision.bearishProfitProbability || 0),
    signalTier,
    status: "WAITING",
    source: null,
    suggestedQty: preview.suggestedQty,
    entryQuantity: entryQuantityForTask(task),
    suggestedPrice: preview.suggestedPrice,
    baselinePositionQty: pendingPositionQuantity(task.market, { ...decision, action }),
    baselinePositions: decision.exitType ? null : Object.fromEntries(pendingPositions(task.market, { ...decision, action }).filter((item) => item.positionOrderId).map((item) => [item.positionOrderId, Number(item.quantity)])),
    baselinePositionsVerified: decision.targetSummary ? task.market?.account?.positionSummariesVerified === true : task.market?.account?.positionsVerified !== false,
    baselineOpenOrderIds: (task.market?.account?.openOrders || []).map((order) => order.orderId),
    entrustedOrderIds: [],
    quantityLimitApplied: preview.quantityLimitApplied === true,
    formFilled: false,
    formSubmitBlocked: true,
    createdAt: new Date(now).toISOString(),
    entryKWindow: decision.exitType ? null : nextCandleTarget({}, now).closeTime,
    deadlineAt: null,
    countdownSec: 0,
    resolvedAt: null,
    message: `${targetLabel}：${pendingActionLabel({ action, exitType: decision.exitType })}，${signalLabel}（获利概率 ${probabilityLabel}）。${pendingWaitMessage(task, { auto })}${!decision.exitType && isLiveTask(task) ? ` 单笔入场数量 ${entryQuantityForTask(task)}` : ""}`,
  };
}

function clearPendingActionTimer(taskId) {
  const timer = pendingActionTimers.get(taskId);
  if (timer) clearTimeout(timer);
  pendingActionTimers.delete(taskId);
}

function schedulePendingActionTimeout(task) {
  clearPendingActionTimer(task.id);
  if (isLiveTask(task)) return;
  if (task.autoDecisionEnabled !== true || task.pendingAction?.status !== "WAITING" || !task.pendingAction.deadlineAt) return;
  const delay = Math.max(0, new Date(task.pendingAction.deadlineAt).getTime() - Date.now());
  pendingActionTimers.set(task.id, setTimeout(() => {
    pendingActionTimers.delete(task.id);
    try {
      confirmPendingAction(task.id, { source: "auto_timeout" });
    } catch {}
  }, delay));
}

function clearPendingAction(task, { persist = true } = {}) {
  if (!task) return;
  clearPendingActionTimer(task.id);
  if (["WAITING", "SUBMITTING"].includes(task.pendingAction?.status)) {
    const submitting = task.pendingAction.status === "SUBMITTING";
    if (submitting) pendingSubmissionCancels.get(task.id)?.();
    task.pendingAction = {
      ...task.pendingAction,
      status: "CANCELLED",
      resolvedAt: new Date().toISOString(),
      message: submitting ? "下单请求已中止；已发出的交易需核实实际持仓" : "待确认建议已取消",
    };
  }
  if (persist) persistTask(task);
}

async function openPendingAction(task, { runtime, run, market = task.market } = {}) {
  if (!task || (task.decision?.action !== "BUY" && task.decision?.action !== "SELL")) {
    if (task) clearPendingAction(task);
    return null;
  }
  clearPendingActionTimer(task.id);
  archivePendingSubmission(task);
  task.pendingAction = buildPendingAction({ ...task, market }, task.decision);
  if (!task.pendingAction.exitType) task.lastEntryKWindow = task.pendingAction.entryKWindow;
  const sessionId = task.target?.browserSessionId || `task:${task.id}`;
  const automatic = isAutoTakeover(task, task.pendingAction);
  if (!automatic) try {
    const filled = await runtime.fillSuggestionForm({
      sessionId,
      action: task.pendingAction.action,
      exitType: task.pendingAction.exitType,
      orderType: task.pendingAction.orderType,
      targetPositionIds: task.pendingAction.targetPositionIds,
      targetPrice: task.pendingAction.targetPrice,
      price: task.pendingAction.suggestedPrice,
      quantity: task.pendingAction.suggestedQty,
      symbol: task.pendingAction.targetSymbol,
      symbolName: task.pendingAction.targetSymbolName,
      instrumentId: task.pendingAction.targetInstrumentId,
    });
    task.pendingAction.formFilled = filled?.filled === true && filled?.submitted !== true;
    if (filled?.submitted === true) task.pendingAction.formFilled = false;
    task.pendingAction.message = task.pendingAction.formFilled
      ? `${task.pendingAction.message}；${task.pendingAction.exitType ? "目标页已定位持仓并准备执行" : "目标页已填入建议价格/数量"}`
      : `${task.pendingAction.message}；${task.pendingAction.exitType ? "目标页未找到可操作持仓" : "目标页未找到可填写的下单表单"}，建议仍待确认`;
    if (run) {
      appendAgentOutput({
        taskId: task.id,
        runId: run.id,
        stage: "action",
        message: task.pendingAction.formFilled
          ? (isAutoTakeover(task)
            ? `已在目标页准备${pendingActionLabel(task.pendingAction)}，全自动接管将直接执行`
            : `已填写${pendingActionLabel(task.pendingAction)}表单，请在目标页点击入场按钮；成交后自动监控离场`)
          : `${pendingTargetLabel(task.pendingAction)}建议待确认；目标页未填写表单，尚未提交`,
        data: { pendingActionId: task.pendingAction.id, targetSymbol: task.pendingAction.targetSymbol, targetSymbolName: task.pendingAction.targetSymbolName, targetInstrumentId: task.pendingAction.targetInstrumentId, filled: task.pendingAction.formFilled, submitted: false },
      });
    }
  } catch (error) {
    task.pendingAction.formFilled = false;
    task.pendingAction.message = `${task.pendingAction.message}；填表失败：${error.message}`;
  }
  if (automatic && task.pendingAction?.status === "WAITING") {
    try {
      if (isLiveTask(task) && !isTradingSwitchOn()) throw new Error("TRADING_DISABLED");
      await confirmPendingAction(task.id, { source: "auto_timeout", runtime });
    } catch (error) {
      const recoveryPending = task.pendingAction?.status === "UNVERIFIED";
      if (recoveryPending) {
        // Login recovery already marked the write uncertain. Preserve it so the
        // next cycle reads real positions/orders before deciding whether to retry.
        task.nextTrigger = "原动作结果未知；先核实真实持仓与委托，不重复提交";
        setNextPoll(task, 0);
        addEvent("automatic_order_recovery", task.nextTrigger, { taskId: task.id, pendingActionId: task.pendingAction.id, code: error?.message || "REAUTH_REQUIRED" });
        if (run) appendAgentOutput({
          taskId: task.id,
          runId: run.id,
          stage: "login",
          kind: "order",
          message: task.nextTrigger,
          data: { pendingActionId: task.pendingAction.id, source: "auto_timeout", submitted: false, retryScheduled: true, code: error?.message || "REAUTH_REQUIRED" },
        });
      } else {
        task.pendingAction = {
          ...task.pendingAction,
          status: "CANCELLED",
          source: "auto_timeout",
          resolvedAt: new Date().toISOString(),
          formSubmitBlocked: false,
          message: `${task.pendingAction.message}；自动执行失败：${error.message}，下一轮继续监控并重新判断`,
        };
        task.nextTrigger = task.pendingAction.message;
        if (!task.pendingAction.exitType) task.lastEntryKWindow = null;
        setNextPoll(task, monitorRetryDelay(task));
        addEvent("automatic_order_failed", task.pendingAction.message, { taskId: task.id, code: error?.message || "TRADE_SUBMIT_FAILED" });
        if (run) {
          appendAgentOutput({
            taskId: task.id,
            runId: run.id,
            stage: "action",
            kind: "order",
            level: "error",
            message: task.pendingAction.message,
            data: { pendingActionId: task.pendingAction.id, source: "auto_timeout", submitted: false, retryScheduled: true, code: error?.message || "TRADE_SUBMIT_FAILED" },
          });
        }
      }
      persistTask(task);
    }
    return task.pendingAction;
  }
  schedulePendingActionTimeout(task);
  persistTask(task);
  return task.pendingAction;
}

export function setAutoDecision(taskId, { enabled, countdownSec } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  task.autoDecisionEnabled = enabled === true;
  if (countdownSec !== undefined) {
    const next = Number(countdownSec);
    if (!Number.isFinite(next)) throw new Error("COUNTDOWN_INVALID");
    task.autoDecisionCountdownSec = Math.max(5, Math.min(300, Math.round(next)));
  } else if (!Number.isFinite(Number(task.autoDecisionCountdownSec))) {
    task.autoDecisionCountdownSec = DEFAULT_AUTO_DECISION_COUNTDOWN_SEC;
  }
  if (task.pendingAction?.status === "WAITING") {
    if (task.autoDecisionEnabled) {
      clearPendingAction(task, { persist: false });
      task.nextTrigger = "自动接管已开启；旧建议已取消，等待重新分析";
      resumeMonitoringAfterAction(task);
    } else {
      task.pendingAction.countdownSec = 0;
      task.pendingAction.deadlineAt = null;
      task.pendingAction.message = `${pendingTargetLabel(task.pendingAction)}：${pendingWaitMessage(task, { auto: isAutoTakeover(task, task.pendingAction) })}`;
      clearPendingActionTimer(task.id);
    }
  }
  task.updatedAt = new Date().toISOString();
  addEvent("auto_decision_updated", isLiveTask(task)
    ? (task.autoDecisionEnabled ? "自动入场已开启：AI 决定入场，程序监控汇总离场" : "手动入场：AI 填表，用户点击入场；后续自动确认、监控与离场")
    : task.autoDecisionEnabled ? "已打开自动确认，观察模式不会下单" : "已关闭自动确认，建议需弹窗确认", { taskId, enabled: task.autoDecisionEnabled, countdownSec: task.autoDecisionCountdownSec });
  persistTask(task);
  return task;
}

export function setTaskProvider(taskId, providerId, userId = "") {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const ownerUserId = String(task.ownerUserId || userId || "");
  if (!ownerUserId || (userId && String(userId) !== ownerUserId)) throw new Error("TASK_ACCESS_DENIED");
  if (!String(providerId || "").trim()) throw new Error("PROVIDER_NOT_READY");
  const provider = findProviderForUser(String(providerId || ""), ownerUserId);
  if (!provider?.encryptedKey || !provider.baseUrl) throw new Error("PROVIDER_NOT_READY");
  // Relay this desktop's selection to its user's running tasks only in memory.
  // The enabled provider is a local preference, never durable task configuration.
  for (const current of state.tasks) {
    if (current.id === taskId || String(current.ownerUserId || "") === ownerUserId) current.providerId = provider.id;
  }
  return task;
}

export function setTaskMarketSelection(taskId, selection = {}, userId = "") {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const ownerUserId = String(task.ownerUserId || userId || "");
  if (!ownerUserId || (userId && String(userId) !== ownerUserId)) throw new Error("TASK_ACCESS_DENIED");
  const symbol = String(selection.symbol || selection.instrumentId || selection.symbolName || "").trim().slice(0, 64);
  if (!symbol) throw new Error("MARKET_SYMBOL_REQUIRED");
  const wasMonitoring = monitoringIntent(task);
  if (wasMonitoring) stopController(task.id);
  advanceTaskGeneration(task);
  task.symbol = symbol;
  task.target.selectedSymbol = symbol;
  task.target.selectedSymbolName = String(selection.symbolName || "").trim().slice(0, 160);
  task.target.selectedInstrumentId = String(selection.instrumentId || "").trim().slice(0, 64);
  task.lastObservedFingerprint = "";
  task.lastAnalyzedFingerprint = "";
  task.lastAnalysisSucceeded = false;
  setNextPoll(task, 0);
  task.nextTrigger = `已切换监测盘口并重新启动监控：${task.target.selectedSymbolName || symbol}`;
  task.updatedAt = new Date().toISOString();
  addEvent("market_selected", task.nextTrigger, { taskId, symbol, instrumentId: task.target.selectedInstrumentId, userId, restarted: wasMonitoring });
  persistTask(task);
  if (wasMonitoring) startController(task.id, { userId: task.ownerUserId || userId });
  return task;
}

export function setTaskMode(taskId, mode) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const next = mode === "LIVE" ? "LIVE" : mode === "SHADOW" ? "SHADOW" : mode === "PAPER" ? "PAPER" : "";
  if (!next) throw new Error("TASK_MODE_INVALID");
  if (task.pendingAction?.status === "SUBMITTING") throw new Error("PENDING_ACTION_BUSY");
  const previous = task.mode;
  task.mode = next;
  if (task.pendingAction?.status === "WAITING") {
    clearPendingAction(task, { persist: false });
    task.nextTrigger = "运行模式已切换；旧建议已取消，等待重新分析";
    resumeMonitoringAfterAction(task);
  }
  task.updatedAt = new Date().toISOString();
  addEvent("task_mode_updated", next === "LIVE"
    ? (task.autoDecisionEnabled ? "任务已切换为实盘全自动接管" : "任务已切换为实盘：AI 填表，用户在目标页提交")
    : `任务已切换为${next === "SHADOW" ? "影子记录" : "观察 / 建议"}`, { taskId, mode: next, previous });
  persistTask(task);
  return task;
}

function recordConfirmedOrder(task, pending, { status, submitted, source, message }) {
  const existing = state.orders.find((order) => order.idempotencyKey === `pending:${pending.id}`);
  if (existing) return existing;
  const order = {
    id: `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `pending:${pending.id}`,
    taskId: task.id,
    symbol: String(pending.targetSymbol || pending.targetSymbolName || pending.targetInstrumentId || task.market?.symbol || task.symbol || ""),
    symbolName: String(pending.targetSymbolName || ""),
    instrumentId: String(pending.targetInstrumentId || ""),
    action: pending.action,
    entryPurpose: pending.entryPurpose || "NORMAL",
    orderType: pending.orderType || "MARKET",
    exitType: pending.exitType || null,
    targetPositionIds: pending.targetPositionIds || [],
    targetSummary: pending.targetSummary || null,
    mode: task.mode,
    status,
    targetPositionPct: Number(task.decision?.targetPositionPct || 0),
    maxOrderValuePct: Number(task.decision?.maxOrderValuePct || 0),
    suggestedPrice: pending.suggestedPrice,
    suggestedQty: pending.suggestedQty,
    entryPrice: pending.entryPrice,
    takeProfitPrice: pending.takeProfitPrice,
    stopLossPrice: pending.stopLossPrice,
    bullishProfitProbability: pending.bullishProfitProbability,
    bearishProfitProbability: pending.bearishProfitProbability,
    submitted,
    source,
    message,
    createdAt: new Date().toISOString(),
  };
  state.orders.unshift(order);
  persistOrder(order);
  return order;
}

function reconcilePositionAction(task, market, pending) {
  if (pending?.targetSummary && market.account?.positionSummariesVerified !== true) return pending;
  if (!pending || !["WAITING", "AWAITING_FILL", "UNVERIFIED"].includes(pending.status) || task.mode !== "LIVE" || (pending.targetSummary ? market.account?.positionSummariesVerified !== true : market.account?.positionsVerified === false) || pending.baselinePositionsVerified === false) return pending;
  if (!pending.source && (pending.exitType || task.autoDecisionEnabled === true)) return pending;
  if (pending.entrustedOrderIds?.some((id) => market.account?.openOrders?.some((order) => order.orderId === id && order.remainingQuantity > 0))) return pending;
  const baseline = Number(pending.baselinePositionQty || 0);
  const quantity = Number(pending.suggestedQty || 0);
  if (quantity <= 0) return pending;
  const observed = pendingPositionQuantity(market, pending);
  const addedPositions = !pending.exitType && pending.baselinePositions
    ? pendingPositions(market, pending).filter((item) => item.positionOrderId).map((item) => ({ id: item.positionOrderId, added: Math.max(0, Number(item.quantity) - Number(pending.baselinePositions[item.positionOrderId] || 0)) }))
    : null;
  const filled = pending.exitType ? baseline > 0 && observed <= Math.max(0, baseline - quantity)
    : addedPositions ? addedPositions.reduce((sum, item) => sum + item.added, 0) >= quantity : observed >= baseline + quantity;
  if (!filled) return pending;
  if (addedPositions) {
    // Allocate observed entry quantity once across outstanding same-direction orders.
    let remaining = quantity;
    for (const position of addedPositions) {
      const claimed = Math.min(remaining, position.added);
      remaining -= claimed;
      if (!claimed) continue;
      for (const other of unsettledActions(task)) {
        if (other.id === pending.id || other.exitType || other.action !== pending.action || !other.baselinePositions) continue;
        const targets = [pending.targetSymbol, pending.targetSymbolName, pending.targetInstrumentId].filter(Boolean);
        if (!targets.some((target) => [other.targetSymbol, other.targetSymbolName, other.targetInstrumentId].includes(target))) continue;
        other.baselinePositions[position.id] = Math.max(Number(other.baselinePositions[position.id] || 0), Number(pending.baselinePositions[position.id] || 0) + claimed);
      }
    }
  }
  if (pending.exitType) task.lastAnalyzedFingerprint = "";
  const order = recordConfirmedOrder(task, pending, {
    status: "filled",
    submitted: true,
    source: pending.source || "manual_browser",
    message: "已通过目标页持仓变化核实成交",
  });
  order.status = "filled";
  order.message = "已通过目标页持仓变化核实成交";
  persistOrder(order);
  const reconciled = {
    ...pending,
    status: "CONFIRMED",
    source: pending.source || "manual_browser",
    resolvedAt: new Date().toISOString(),
    retryAfterLogin: false,
    formSubmitBlocked: false,
    message: `${pendingActionLabel(pending)}已通过持仓变化核实，继续监控`,
  };
  appendAgentOutput({ taskId: task.id, runId: task.activeRunId || "", stage: "collect", kind: "order", message: reconciled.message, data: { pendingActionId: pending.id, orderId: order.id, observedQuantity: observed } });
  return reconciled;
}

function reconcilePendingPosition(task, market) {
  const waiting = task.pendingAction;
  if (isLiveTask(task) && waiting?.status === "WAITING" && !waiting.exitType
    && ((waiting.entryPurpose && waiting.entryPurpose !== "NORMAL") || !meetsOrderBoundary(waiting))) {
    waiting.status = "CANCELLED";
    waiting.message = "旧入场建议不符合当前AI方向概率至少45%的普通入场规则，已取消";
    clearPendingActionTimer(task.id);
  }
  if (market.account?.openOrdersVerified) {
    const claimed = new Set([task.pendingAction, ...(task.unsettledActions || [])].flatMap((pending) => pending?.entrustedOrderIds || []));
    for (const pending of [task.pendingAction, ...(task.unsettledActions || [])].filter(Boolean)) {
      if (!["WAITING", "AWAITING_FILL", "UNVERIFIED"].includes(pending.status) || pending.entrustedOrderIds?.length || !Array.isArray(pending.baselineOpenOrderIds)) continue;
      const targets = [pending.targetSymbol, pending.targetSymbolName, pending.targetInstrumentId].filter(Boolean);
      const candidates = market.account.openOrders.filter((order) => !claimed.has(order.orderId) && !pending.baselineOpenOrderIds.includes(order.orderId)
        && targets.some((target) => [order.symbol, order.symbolName, order.instrumentId].includes(target))
        && (pending.action === "BUY" ? /买|多|long/i.test(order.side) : /卖|空|short/i.test(order.side))
        && (pending.exitType ? /转让/.test(order.orderKind) : /订立/.test(order.orderKind))
        && Number(order.quantity) === Number(pending.suggestedQty) && Number(order.orderPrice) === Number(pending.suggestedPrice));
      if (candidates.length === 1) {
        pending.entrustedOrderIds = [candidates[0].orderId];
        claimed.add(candidates[0].orderId);
      }
    }
  }
  task.unsettledActions = (task.unsettledActions || []).map((pending) => reconcilePositionAction(task, market, pending)).filter((pending) => pending.status !== "CONFIRMED");
  const reconciled = reconcilePositionAction(task, market, task.pendingAction);
  if (reconciled !== task.pendingAction) {
    clearPendingActionTimer(task.id);
    task.pendingAction = reconciled;
    task.nextTrigger = reconciled.message;
  }
  // Verified absence establishes no current exposure, not a historical fill.
  // Retire old unresolved entries only after every account table is freshly clear.
  const account = market.account;
  const flat = account?.positionsVerified === true && account?.positionSummariesVerified === true
    && account?.openOrdersVerified === true && !(account.positions || []).some(p => Number(p.quantity) > 0)
    && !(account.positionSummaries || []).some(p => Number(p.quantity) > 0)
    && !(account.openOrders || []).some(p => Number(p.remainingQuantity) > 0)
    && Number.isFinite(Date.parse(market.observedAt)) && Math.abs(Date.now() - Date.parse(market.observedAt)) <= 5000
    && !pendingConfirmLocks.has(task.id);
  if (flat) {
    for (const pending of [task.pendingAction, ...(task.unsettledActions || [])].filter(Boolean)) {
      if (!["AWAITING_FILL", "UNVERIFIED"].includes(pending.status)
        || Date.parse(market.observedAt) < Date.parse(pending.submissionStartedAt || pending.createdAt) + CURRENT_ORDER_WAIT_MS) continue;
      pending.status = "RECONCILED";
      pending.resolvedAt = market.observedAt;
      pending.message = "当前持仓、持仓汇总与委托均已核实清零，本轮结束；不推断历史成交结果";
      task.lastAnalyzedFingerprint = "";
      const order = recordConfirmedOrder(task, pending, { status: "reconciled_flat", submitted: Boolean(pending.source), source: "account_reconciliation", message: pending.message });
      Object.assign(order, { status: "reconciled_flat", message: pending.message, source: "account_reconciliation" });
      persistOrder(order);
    }
    task.unsettledActions = (task.unsettledActions || []).filter(p => !["RECONCILED", "CANCELLED"].includes(p.status));
    task.summaryExitReviews = [];
  }
  persistTask(task);
}

export async function confirmPendingAction(taskId, { source = "manual_confirm", runtime } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.pendingAction?.status !== "WAITING") throw new Error("PENDING_ACTION_NOT_FOUND");
  const exitGuard = task.pendingAction.exitGuard;
  if (isLiveTask(task) && task.pendingAction.exitType && (!task.pendingAction.targetSummary || !exitGuard?.summary)) {
    task.pendingAction.status = "CANCELLED";
    task.pendingAction.message = "旧逐仓离场已停用，由程序按当前规则监控持仓汇总离场";
    persistTask(task);
    throw new Error("SUMMARY_EXIT_REQUIRED");
  }
  if (isLiveTask(task) && task.pendingAction.exitType) {
    const pending = task.pendingAction;
    const authorized = summaryExitAllowsPrice(pending.targetSummary, pending.suggestedPrice, exitGuard?.aiAuthorization)
      && (pending.exitType === "TAKE_PROFIT" ? exitGuard?.programProfit === true
        : (task.summaryExitReviews || []).some(r => r.id === exitGuard?.aiAuthorization?.id && r.decision === "EXIT"));
    if (!["TAKE_PROFIT", "STOP_LOSS"].includes(pending.exitType) || !authorized) {
      pending.status = "CANCELLED";
      pending.message = "离场条件已失效：盈利需达1点，亏损离场需当前AI决定";
      persistTask(task);
      throw new Error("SUMMARY_EXIT_AUTHORIZATION_REQUIRED");
    }
  }
  if (isLiveTask(task) && !task.pendingAction.exitType) {
    if (task.pendingAction.entryPurpose && task.pendingAction.entryPurpose !== "NORMAL") throw new Error("RETIRED_ENTRY_PURPOSE");
    const block = entryRoundBlock(task, task.market, { pendingId: task.pendingAction.id });
    if (block) throw new Error(block);
    if (!meetsOrderBoundary(task.pendingAction)) throw new Error("ENTRY_PROBABILITY_BELOW_45");
  }
  if (isLiveTask(task) && !task.pendingAction.exitType && Number(task.pendingAction.suggestedQty) !== entryQuantityForTask(task.pendingAction.entryQuantity ? task.pendingAction : task)) throw new Error("LIVE_ENTRY_QUANTITY_LIMIT");
  if (isLiveTask(task) && !isTradingSwitchOn()) throw new Error("TRADING_DISABLED");
  if (pendingConfirmLocks.has(taskId)) throw new Error("CONFIRM_IN_PROGRESS");
  const generation = taskGeneration(task);
  const pendingId = task.pendingAction.id;
  const assertSubmissionCurrent = () => {
    assertCycleCurrent(task, generation);
    if (getTask(taskId) !== task || task.pendingAction?.id !== pendingId || task.pendingAction?.status !== "SUBMITTING") throw new Error("TRADE_SUBMIT_CANCELLED");
  };
  pendingConfirmLocks.add(taskId);
  try {
    clearPendingActionTimer(task.id);
    const actionLabel = pendingActionLabel(task.pendingAction);
    const tools = resolveRuntime(runtime, { userId: task.ownerUserId || "", providerId: task.providerId || "" });
    if (isLiveTask(task) && !isAutomaticAction(task)) {
      task.pendingAction = {
        ...task.pendingAction,
        status: "AWAITING_FILL",
        source: "manual_browser",
        message: "手动入场由用户在目标页提交；AI 继续监控持仓，成交后自动判断离场",
      };
      task.nextTrigger = task.pendingAction.message;
      persistTask(task);
      return task;
    }
    if (shouldSubmitLiveOrder(task, source)) {
      task.pendingAction = {
        ...task.pendingAction,
        status: "SUBMITTING",
          submissionStartedAt: new Date().toISOString(),
          message: `正在向${pendingTargetLabel(task.pendingAction)}执行${actionLabel}…`,
      };
      persistTask(task);
      const sessionId = task.target?.browserSessionId || `task:${task.id}`;
      const submissionAbort = new AbortController();
      const cancelSubmission = () => submissionAbort.abort(new Error("TRADE_SUBMIT_CANCELLED"));
      pendingSubmissionCancels.set(taskId, cancelSubmission);
      const submissionStartedAt = Date.now();
      let submitted;
      try {
        submitted = await tools.submitSuggestionForm({
          sessionId,
          confirmationId: task.pendingAction.id,
          action: task.pendingAction.action,
          price: task.pendingAction.suggestedPrice,
          quantity: task.pendingAction.suggestedQty,
          symbol: task.pendingAction.targetSymbol,
          symbolName: task.pendingAction.targetSymbolName,
          instrumentId: task.pendingAction.targetInstrumentId,
          exitType: task.pendingAction.exitType,
          orderType: task.pendingAction.orderType,
          targetPositionIds: task.pendingAction.targetPositionIds,
          targetSummary: task.pendingAction.targetSummary,
          targetPrice: task.pendingAction.targetPrice,
          exitGuard: task.pendingAction.exitGuard,

        }, { signal: submissionAbort.signal });
        submissionAbort.signal.throwIfAborted();
        assertSubmissionCurrent();
        if (submitted && /REAUTH|LOGIN|SESSION_EXPIRED|AUTH/i.test(String(submitted.code || submitted.message || ""))) {
          const error = new Error(submitted.code || "REAUTH_REQUIRED");
          error.code = submitted.code || "REAUTH_REQUIRED";
          throw error;
        }
      } catch (error) {
        if (getTask(taskId) === task && taskGeneration(task) === generation && !task.stopLocked && task.pendingAction?.id === pendingId && task.pendingAction?.status === "SUBMITTING") {
          const authExpired = /REAUTH|LOGIN|SESSION_EXPIRED|AUTH/i.test(String(error?.message || error?.code || ""));
          const writeUnverified = !["DESKTOP_BROWSER_UPDATE_REQUIRED", "DESKTOP_BROWSER_OFFLINE"].includes(error?.message);
          task.pendingAction = {
            ...task.pendingAction,
            source: writeUnverified ? source : task.pendingAction.source,
            status: authExpired || writeUnverified ? "UNVERIFIED" : "WAITING",
            retryAfterLogin: authExpired,
            formSubmitBlocked: false,
            lastExecution: { code: String(error?.code || error?.message || "DESKTOP_BROWSER_CALL_FAILED").slice(0, 160), stage: "desktop_call", durationMs: Date.now() - submissionStartedAt, checkedAt: new Date().toISOString() },
            message: authExpired
              ? "登录态已失效；已自动恢复登录并继续核实本次动作，确认未成交后立即重试"
              : writeUnverified ? `${task.pendingAction.targetSummary ? "汇总离场" : "入场"}调用中断，先核实当前委托与持仓，禁止重复提交：${error?.message}`
              : `确认后下单失败：${error?.message || "目标页未响应，请重试或取消"}`,
          };
          if (authExpired) task.target.loginStatus = "REAUTH_REQUIRED";
          task.nextTrigger = task.pendingAction.message;
          if (authExpired) setNextPoll(task, 0);
          persistTask(task);
        }
        if (/REAUTH|LOGIN|SESSION_EXPIRED|AUTH/i.test(String(error?.message || error?.code || ""))) {
          try {
            const connector = getConnector(task.target.connectorId);
            await ensureLoggedIn(task, connector, { id: task.activeRunId || null }, { code: "REAUTH_REQUIRED" }, resolveRuntime(runtime, { userId: task.ownerUserId || "", providerId: task.providerId || "" }), () => assertCycleCurrent(task, generation));
          } catch (recoveryError) {
            task.pendingAction = {
              ...task.pendingAction,
              loginRecoveryError: String(recoveryError?.message || recoveryError || "LOGIN_RECOVERY_FAILED").slice(0, 240),
            };
            persistTask(task);
          }
        }
        throw error;
      } finally {
        if (pendingSubmissionCancels.get(taskId) === cancelSubmission) pendingSubmissionCancels.delete(taskId);
      }
      task.pendingAction.formFilled = submitted?.filled === true;
      task.pendingAction.executionDurationMs = Date.now() - submissionStartedAt;
      task.pendingAction.lastExecution = { code: submitted?.code || "TRADE_SUBMIT_FAILED", stage: submitted?.stage || "prepare", uncertain: submitted?.uncertain === true, durationMs: task.pendingAction.executionDurationMs, checkedAt: new Date().toISOString() };
      if (task.pendingAction?.exitType && submitted?.completedPositionIds?.length) {
        const partial = { ...task.pendingAction, targetPositionIds: submitted.completedPositionIds };
        task.pendingAction = { ...partial, baselinePositionQty: pendingPositionQuantity(task.market, partial), suggestedQty: pendingPositionQuantity(task.market, partial) };
      }
      if (task.pendingAction?.exitType && Number(submitted?.submittedQuantity) > 0) task.pendingAction.suggestedQty = Number(submitted.submittedQuantity);
      if (submitted?.submitted === true && submitted.ok !== true) {
        const order = recordConfirmedOrder(task, task.pendingAction, {
          status: "rejected",
          submitted: true,
          source,
          message: submitted.message || submitted.code || "交易所拒绝下单",
        });
        task.pendingAction = {
          ...task.pendingAction,
          status: "REJECTED",
          source,
          resolvedAt: new Date().toISOString(),
          formSubmitBlocked: true,
          message: `已点击${actionLabel}但未成交：${order.message}`,
        };
        task.status = "MONITORING";
        task.nextTrigger = task.pendingAction.message;
        addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: true, orderId: order.id, submitted: true });
        appendAgentOutput({
          taskId,
          runId: task.activeRunId || "",
          stage: "action",
          kind: "order",
          level: "error",
          message: task.pendingAction.message,
          data: { pendingActionId: task.pendingAction.id, source, submitted: true, orderCreated: true, orderId: order.id },
        });
        persistTask(task);
        return task;
      }
      if (!submitted?.ok || submitted.submitted !== true) {
        if (["EXIT_CONDITION_CHANGED", "EXIT_QUOTE_UNVERIFIED", "EXIT_SUMMARY_CONDITION_CHANGED", "EXIT_SUMMARY_EXPIRED", "EXIT_SUMMARY_QUANTITY_CHANGED"].includes(String(submitted?.code || ""))) {
          task.pendingAction = {
            ...task.pendingAction,
            status: "CANCELLED",
            source: "realtime_recheck",
            resolvedAt: new Date().toISOString(),
            formSubmitBlocked: false,
            message: "确认前盘口或持仓条件已变化，未提交订单；继续由程序读取最新汇总重新判断",
          };
          setNextPoll(task, 0);
          task.nextTrigger = task.pendingAction.message;
          addEvent("automatic_order_recheck", task.pendingAction.message, { taskId, pendingActionId: task.pendingAction.id, code: submitted.code, submitted: false });
          appendAgentOutput({
            taskId,
            runId: task.activeRunId || "",
            stage: "action",
            kind: "order",
            message: task.pendingAction.message,
            data: { pendingActionId: task.pendingAction.id, source: "realtime_recheck", submitted: false, retryScheduled: true, code: submitted.code },
          });
          persistTask(task);
          return task;
        }
        if (submitted?.uncertain === true) {
          task.pendingAction = {
            ...task.pendingAction,
            status: "AWAITING_FILL",
            source,
            formSubmitBlocked: false,
            message: `${actionLabel}已点击，页面未返回明确结果；继续监控持仓变化核实成交`,
          };
          task.status = "MONITORING";
          task.nextTrigger = task.pendingAction.message;
          persistTask(task);
          return task;
        }
        task.pendingAction = {
          ...task.pendingAction,
          status: "WAITING",
          message: `确认后下单失败：${submitted?.message || submitted?.code || "请检查目标页登录态后重试"}`,
        };
        task.nextTrigger = task.pendingAction.message;
        persistTask(task);
        throw new Error(submitted?.message || submitted?.code || "TRADE_SUBMIT_FAILED");
      }
      const order = recordConfirmedOrder(task, task.pendingAction, {
        status: "submitted",
        submitted: true,
        source,
        message: submitted.message || "已提交实盘订单",
      });
      task.pendingAction = {
        ...task.pendingAction,
        status: "AWAITING_FILL",
        source,
        formSubmitBlocked: false,
        message: `已提交${actionLabel}请求，后台核实成交；继续核实持仓与委托`,
      };
      task.nextTrigger = task.pendingAction.message;
      addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: true, orderId: order.id, submitted: true });
      appendAgentOutput({
        taskId,
        runId: task.activeRunId || "",
        stage: "action",
        kind: "order",
        message: task.pendingAction.message,
        data: { pendingActionId: task.pendingAction.id, source, submitted: true, orderCreated: true, orderId: order.id, executionDurationMs: task.pendingAction.executionDurationMs },
      });
      persistTask(task);
      return task;
    }

    if (task.mode === "SHADOW") {
      recordConfirmedOrder(task, task.pendingAction, {
        status: "shadow",
        submitted: false,
        source,
        message: "影子记录，未提交实盘",
      });
    }

    task.pendingAction = {
      ...task.pendingAction,
      status: "CONFIRMED",
      source,
      resolvedAt: new Date().toISOString(),
      formSubmitBlocked: true,
      message: source === "auto_timeout"
        ? `倒计时结束，已自动确认${actionLabel}建议；观察模式未提交交易单`
        : task.mode === "SHADOW"
          ? `已确认${actionLabel}建议，已写入影子记录`
          : `已确认${actionLabel}建议；观察模式未提交交易单`,
    };
    task.nextTrigger = task.pendingAction.message;
    addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: task.mode === "SHADOW", submitted: false });
    appendAgentOutput({
      taskId,
      runId: task.activeRunId || "",
      stage: "action",
      kind: "suggestion",
      message: task.pendingAction.message,
      data: { pendingActionId: task.pendingAction.id, source, submitted: false, orderCreated: task.mode === "SHADOW" },
    });
    if (task.mode === "PAPER" && state.orders.some((order) => order.taskId === taskId && order.mode === "LIVE" && order.status !== "rejected")) {
      throw new Error("ORDER_CREATED_UNEXPECTEDLY");
    }
    persistTask(task);
    return task;
  } finally {
    pendingConfirmLocks.delete(taskId);
    if (getTask(taskId) === task && taskGeneration(task) === generation && !task.stopLocked) resumeMonitoringAfterAction(task);
  }
}

export function cancelPendingAction(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.pendingAction?.status === "SUBMITTING") {
    pendingSubmissionCancels.get(taskId)?.();
    clearPendingActionTimer(task.id);
    task.pendingAction = {
      ...task.pendingAction,
      status: "CANCELLED",
      source: "manual_cancel",
      resolvedAt: new Date().toISOString(),
      message: "已取消下单请求，未下单",
    };
    task.nextTrigger = task.pendingAction.message;
    addEvent("suggestion_cancelled", task.pendingAction.message, { taskId, action: task.pendingAction.action });
    persistTask(task);
    resumeMonitoringAfterAction(task);
    return task;
  }
  if (task.pendingAction?.status !== "WAITING") throw new Error("PENDING_ACTION_NOT_FOUND");
  clearPendingActionTimer(task.id);
  task.pendingAction = {
    ...task.pendingAction,
    status: "CANCELLED",
    source: "manual_cancel",
    resolvedAt: new Date().toISOString(),
    message: "已取消本次建议，未下单",
  };
  task.nextTrigger = task.pendingAction.message;
  addEvent("suggestion_cancelled", task.pendingAction.message, { taskId, action: task.pendingAction.action });
  persistTask(task);
  resumeMonitoringAfterAction(task);
  return task;
}

export function takeoverPendingAction(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (isLiveTask(task) || isAutoTakeover(task)) return task;
  if (["WAITING", "AWAITING_FILL", "UNVERIFIED", "REJECTED"].includes(task.pendingAction?.status)) {
    clearPendingActionTimer(task.id);
    task.pendingAction = {
      ...task.pendingAction,
      status: "TAKEN_OVER",
      source: "manual_takeover",
      resolvedAt: new Date().toISOString(),
      message: "已人工接管，请在目标页核对订单与持仓",
    };
  }
  return claimManual(taskId);
}

function monitoringIntent(task) {
  return Boolean(task && !task.stopLocked && (task.monitoringEnabled === true || (task.monitoringEnabled === undefined && task.status === "MONITORING")));
}

export function monitoringPollIntervalMs(task) {
  const configured = Number(process.env.MONITOR_POLL_INTERVAL_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.min(MAX_MONITOR_POLL_MS, Math.max(1000, configured));
  return DEFAULT_MONITOR_POLL_MS;
}

function latestPrice(market) {
  const value = Number(market?.latest?.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function indicatorNumber(market, key) {
  const value = Number(market?.indicators?.[key]);
  return Number.isFinite(value) ? value : null;
}

function selectedBook(market) {
  return market?.books?.find((book) => String(book?.symbol || "") === String(market?.symbol || "")) || market;
}

export function entryConditionReached(previous, next, task) {
  if (!previous || decisionExpired(task)) return true;
  const before = selectedBook(previous);
  const current = selectedBook(next);
  const beforePrice = latestPrice(before);
  const currentPrice = latestPrice(current);
  if (beforePrice && currentPrice && Math.abs(currentPrice / beforePrice - 1) >= 0.004) return true;
  const beforeEma = indicatorNumber(before, "ema20");
  const currentEma = indicatorNumber(current, "ema20");
  if (beforePrice && currentPrice && beforeEma && currentEma && ((beforePrice <= beforeEma && currentPrice > currentEma) || (beforePrice >= beforeEma && currentPrice < currentEma))) return true;
  const beforeRsi = indicatorNumber(before, "rsi14");
  const currentRsi = indicatorNumber(current, "rsi14");
  const rsiZone = (value) => value !== null && (value <= 35 || value >= 65);
  if (!rsiZone(beforeRsi) && rsiZone(currentRsi)) return true;
  const beforeVolume = indicatorNumber(before, "volumeRatio");
  const currentVolume = indicatorNumber(current, "volumeRatio");
  if ((beforeVolume === null || beforeVolume < 1.2) && currentVolume !== null && currentVolume >= 1.2) return true;
  const beforeImbalance = Number(before?.orderBook?.imbalance);
  const currentImbalance = Number(current?.orderBook?.imbalance);
  if (Number.isFinite(currentImbalance) && (!Number.isFinite(beforeImbalance) || Math.sign(beforeImbalance) !== Math.sign(currentImbalance) || Math.abs(currentImbalance) >= 0.35 && Math.abs(beforeImbalance) < 0.35)) return true;
  return String(before?.trend || "") !== String(current?.trend || "");
}

function monitorRetryDelay(task) {
  const failures = Math.max(1, Number(task?.monitorFailureCount || 1));
  const base = Math.max(DEFAULT_MONITOR_RETRY_MS, monitoringPollIntervalMs(task));
  return Math.min(MAX_MONITOR_POLL_MS, base * (2 ** Math.min(5, failures - 1)));
}

function decisionExpired(task) {
  const createdAt = new Date(task?.decision?.observedAt || task?.decision?.createdAt || "").getTime();
  const ttlSec = Number(task?.decision?.ttlSec || 0);
  return !Number.isFinite(createdAt) || !Number.isFinite(ttlSec) || ttlSec <= 0 || Date.now() >= createdAt + ttlSec * 1000;
}

function setNextPoll(task, delayMs = monitoringPollIntervalMs(task)) {
  task.nextPollAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();
  task.nextTrigger = `等待行情变化，约 ${Math.ceil(Math.max(0, Number(delayMs) || 0) / 1000)} 秒后检查`;
}

function pauseForPendingAction(task) {
  const pending = task?.pendingAction;
  if (pending?.status !== "SUBMITTING") return false;
  // A browser call can be interrupted by a desktop reconnect or an expired
  // session. Do not leave the whole controller paused forever; keep the
  // action as UNVERIFIED so the next observation reconciles the real order.
  const startedAt = new Date(pending.submissionStartedAt || pending.createdAt || 0).getTime();
  if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt >= SUBMITTING_RECOVERY_TIMEOUT_MS) {
    pending.status = "UNVERIFIED";
    pending.formSubmitBlocked = false;
    pending.message = "下单请求超过响应时限；保留为待核实状态，继续读取真实委托与持仓";
    pending.recoveryAt = new Date().toISOString();
    pendingSubmissionCancels.get(task.id)?.();
    pendingSubmissionCancels.delete(task.id);
    persistTask(task);
    return false;
  }
  return true;
}

function resumeMonitoringAfterAction(task) {
  if (!monitoringIntent(task) || pauseForPendingAction(task)) return;
  const recheckMessage = task.pendingAction?.source === "realtime_recheck" ? task.pendingAction.message : "";
  setNextPoll(task, 0);
  if (recheckMessage) task.nextTrigger = recheckMessage;
  persistTask(task);
  if (!controllerLoops.has(task.id)) {
    startController(task.id, { userId: task.ownerUserId || "" });
    return;
  }
  scheduleController(task.id, 0);
}

function renewLease(task) {
  const now = new Date().toISOString();
  task.heartbeatAt = now;
  task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  if (!task.lastHeartbeatEventAt || Date.now() - new Date(task.lastHeartbeatEventAt).getTime() > 60000) {
    task.lastHeartbeatEventAt = now;
    addEvent("controller_heartbeat", "任务租约已续期，服务端监控保持在线", { taskId: task.id, leaseExpiresAt: task.leaseExpiresAt });
  }
}

function notifyCycleIdle(taskId) {
  const waiters = cycleWaiters.get(taskId) || [];
  cycleWaiters.delete(taskId);
  for (const resolve of waiters) resolve();
}

function waitForIdleCycle(taskId) {
  if (!activeCycles.has(taskId)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = cycleWaiters.get(taskId) || [];
    list.push(resolve);
    cycleWaiters.set(taskId, list);
  });
}

async function acquireCycle(taskId, { wait = false } = {}) {
  while (activeCycles.has(taskId)) {
    if (!wait) return false;
    await waitForIdleCycle(taskId);
  }
  activeCycles.add(taskId);
  return true;
}

function holdDecision(code, invalidation) {
  return {
    action: "HOLD",
    confidence: 0,
    profitProbability: 0,
    targetPositionPct: 0,
    maxOrderValuePct: 0,
    reasonCodes: [],
    evidenceIds: [],
    invalidation,
    riskFlags: [code],
    createdAt: new Date().toISOString(),
    ttlSec: 300,
  };
}

function stoppedRunResult(task, run, market = task.market || null) {
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "system", level: "warn", message: "任务已停止锁定，跳过本轮后续分析" });
  finishAgentRun(run.id, { status: "skipped", action: task.decision?.action || "HOLD", route: "STOP_LOCKED", code: "STOP_LOCKED" });
  return { task, market, skipped: true, reason: "STOP_LOCKED", route: "STOP_LOCKED", run, analysisTriggered: false };
}

function invalidatedRunResult(taskId, run, market = null) {
  const task = getTask(taskId);
  appendAgentOutput({ taskId, runId: run.id, stage: "system", level: "warn", message: "任务生命周期已变化，已丢弃旧轮次结果" });
  finishAgentRun(run.id, { status: "stale", action: null, route: "CYCLE_INVALIDATED", code: "CYCLE_INVALIDATED" });
  return { task, market: task?.market || market, skipped: true, reason: "CYCLE_INVALIDATED", route: "CYCLE_INVALIDATED", run, analysisTriggered: false };
}

function transitionWorkflow(task, activeKey, detail) {
    const activeIndex = task.workflow.findIndex((item) => item.key === activeKey);
  task.workflow = task.workflow.map((step, index) => {
    if (step.key === activeKey) return { ...step, status: "active", detail: detail || step.detail };
    return { ...step, status: index < activeIndex ? "complete" : "pending" };
  });
}

function completeWorkflow(task, key, detail) {
  task.workflow = task.workflow.map((step) => step.key === key ? { ...step, status: "complete", detail } : step);
}

function logStage(task, run, stage, message, data = null, level = "info") {
  transitionWorkflow(task, stage, message);
  appendAgentOutput({ taskId: task.id, runId: run.id, stage, kind: "stage", level, message, data });
  persistTask(task);
}

function startupChecks(task) {
  const connector = getConnector(task.target.connectorId);
  const readonlyReady = connector?.reviewStatus === "APPROVED"
    && connector.adapterId === "haohan-readonly"
    && connector.capabilities.includes("read_visible_market");
  const credentialReady = readonlyReady || (
    task.target.credentialStatus === "已托管"
    && Boolean(task.target.credentialRef)
    && task.target.credentialRef !== "credential:demo"
    && Boolean(task.ownerUserId)
    && credentialExists(task.target.credentialRef, { ownerUserId: task.ownerUserId })
  );
  return [
    { key: "target", label: "目标连接", passed: Boolean(task.target.url || task.target.installPath || task.target.connectorId) },
    { key: "credentials", label: readonlyReady ? "只读行情" : "凭据托管", passed: credentialReady },
    { key: "risk", label: "风控配置", passed: Boolean(task.riskProfile) },
    { key: "mode", label: "观察模式", passed: task.mode === "PAPER" || task.mode === "SHADOW" || task.mode === "LIVE" },
    { key: "adapter", label: "目标适配器", passed: Boolean(task.target.connectorId) },
  ];
}

function applyFreshnessRules(task, market) {
  const freshness = task.rules.find((rule) => rule.mode === "AUTO" && /新鲜/.test(rule.name));
  if (freshness) {
    const stale = Number(market.freshnessSec) > 5;
    freshness.status = stale ? "pending" : "passed";
    freshness.detail = stale ? `数据延迟 ${market.freshnessSec} 秒` : `延迟 ${market.freshnessSec} 秒`;
  }
  const position = task.rules.find((rule) => rule.mode === "AUTO" && /仓位/.test(rule.name));
  if (position) {
    const exposure = Number(task.metrics?.exposurePct || 0);
    position.status = exposure > 30 ? "pending" : "passed";
    position.detail = `当前 ${exposure}%`;
  }
  const anomalyRule = task.rules.find((rule) => rule.mode === "BLOCK");
  if (anomalyRule) {
    anomalyRule.status = market.anomaly ? "pending" : "standby";
    anomalyRule.detail = market.anomaly ? "ATR 异常放大，自动动作已锁定" : "未触发";
  }
}

export function startTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (["MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING", "STARTING"].includes(task.status)) return task;
  advanceTaskGeneration(task);
  const checks = startupChecks(task);
  const failed = checks.filter((check) => !check.passed);
  if (failed.length) {
    task.monitoringEnabled = false;
    task.nextPollAt = null;
    task.nextTrigger = "启动检查未通过";
    stopController(taskId);
    task.status = "BLOCKED";
    addEvent("startup_blocked", `启动检查未通过：${failed.map((item) => item.label).join("、")}`, { taskId, checks });
    persistTask(task);
    return task;
  }
  task.status = "STARTING";
  task.stopLocked = false;
  if (task.pendingAction?.status === "TAKEN_OVER") {
    clearPendingActionTimer(task.id);
    task.pendingAction = null;
  }
  task.monitoringEnabled = true;
  task.monitorFailureCount = 0;
  task.lastObservedFingerprint = "";
  task.lastAnalyzedFingerprint = "";
  task.lastAnalysisSucceeded = false;
  // A new monitoring lifecycle must analyze existing holdings before arming exits.
  task.exitPlans = [];
  task.positionTracking = {};
  task.nextPollAt = null;
  task.monitoringRound = Number(task.monitoringRound || 0);
  transitionWorkflow(task, "connect", "启动检查通过，准备连接目标");
  addEvent("task_starting", "开始启动检查，正在恢复账户现场", { taskId });
  task.status = "MONITORING";
  task.heartbeatAt = new Date().toISOString();
  task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  setNextPoll(task, 0);
  transitionWorkflow(task, "analyze", "进入持续观察，等待分析触发");
  task.updatedAt = new Date().toISOString();
  addEvent("task_monitoring", isLiveTask(task)
    ? "启动检查通过，Agent 持续监控并自动执行入场与离场"
    : "启动检查通过，Agent 已进入持续监控；买卖只给出建议", { taskId });
  persistTask(task);
  startController(taskId, { userId: task.ownerUserId || "" });
  return task;
}

export function stopTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status === "MANUAL_CONTROL" && task.stopLocked) return task;
  advanceTaskGeneration(task);
  task.stopLocked = true;
  task.monitoringEnabled = false;
  task.nextPollAt = null;
  task.nextTrigger = "已停止观察";
  task.exitPlans = [];
  clearPendingAction(task, { persist: false });
  stopController(taskId);
  task.status = "STOPPING";
  addEvent("stop_requested", "已阻断新决策和新订单，开始对账", { taskId });
  task.workflow = task.workflow.map((step) => ({
    ...step,
    status: step.key === "connect" || step.key === "login" ? "complete" : "pending",
  }));
  task.status = "MANUAL_CONTROL";
  task.target.connectionStatus = task.target.connectionStatus === "connected" ? "connected" : task.target.connectionStatus;
  task.updatedAt = new Date().toISOString();
  addEvent("manual_control", "用户已停止自动运行；现有持仓保持不变", { taskId });
  persistTask(task);
  return task;
}

export function claimManual(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (isLiveTask(task) || isAutoTakeover(task)) return task;
  advanceTaskGeneration(task);
  task.stopLocked = true;
  task.monitoringEnabled = false;
  task.nextPollAt = null;
  task.nextTrigger = "已切换人工接管";
  if (task.pendingAction?.status === "WAITING") {
    clearPendingActionTimer(task.id);
    task.pendingAction = {
      ...task.pendingAction,
      status: "TAKEN_OVER",
      source: "manual_takeover",
      resolvedAt: new Date().toISOString(),
      message: "人工已接管，自动确认已取消",
    };
  }
  stopController(taskId);
  task.status = "MANUAL_CONTROL";
  addEvent("manual_claimed", "人工已接管任务，Agent 禁止自动买卖", { taskId });
  persistTask(task);
  return task;
}

export function autoJudge(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const pending = task.rules.find((rule) => rule.status === "pending" && rule.mode === "REVIEW");
  if (!pending) return task;
  advanceTaskGeneration(task);
  pending.status = "passed";
  pending.detail = "人工确认通过，已记录审计";
  addEvent("rule_approved", `规则 ${pending.order} 已人工确认，允许进入风控`, { taskId, ruleId: pending.id });
  const blocked = task.rules.some((rule) => rule.status === "pending" && rule.mode === "BLOCK");
  if (!blocked && task.status === "PAUSED" && !task.stopLocked) {
    task.status = "MONITORING";
    task.heartbeatAt = new Date().toISOString();
    task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    addEvent("task_resumed", "人工规则确认完成，任务恢复持续监控", { taskId });
    startController(taskId, { userId: task.ownerUserId || "" });
  }
  persistTask(task);
  return task;
}

async function ensureConnected(task, connector, run, runtime, assertCurrent = () => {}) {
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  task.target.browserSessionId = sessionId;
  const url = String(task.target.url || connector?.target || HAO_HAN_TARGET_URL);
  assertCurrent();
  logStage(task, run, "connect", `打开目标：${url}`, { url, sessionId, adapterId: connector?.adapterId || "" });
  const opened = await runtime.openMarketBrowser(task, connector);
  assertCurrent();
  if (!opened.ok && opened.code === "BROWSER_SESSION_NOT_FOUND") {
    return opened;
  }
  if (!opened.ok && opened.code !== "BROWSER_SESSION_NOT_FOUND") {
    logStage(task, run, "connect", `浏览器连接失败：${opened.message || opened.code}`, { code: opened.code }, "error");
    return opened;
  }
  completeWorkflow(task, "connect", opened.ok ? `浏览器会话 ${opened.mode || "ready"}` : "改用只读接口");
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "connect", message: opened.ok ? `已打开 ${opened.url || url}` : "页面未打开，后续将尝试只读行情接口", data: { code: opened.code || "OK" } });
  return opened;
}

async function ensureLoggedIn(task, connector, run, pageResult, runtime, assertCurrent = () => {}) {
  // Analysis and the fast exit monitor share one browser and one login attempt.
  // Key by browser session so two concurrent controller paths cannot navigate
  // the same page through separate login flows.
  const loginKey = task.target.browserSessionId || `task:${task.id}`;
  if (loginRecoveryRuns.has(loginKey)) {
    const result = await loginRecoveryRuns.get(loginKey);
    assertCurrent();
    return result;
  }
  const operation = performLoginCheck(task, connector, run, pageResult, runtime, assertCurrent);
  loginRecoveryRuns.set(loginKey, operation);
  try { return await operation; }
  finally { if (loginRecoveryRuns.get(loginKey) === operation) loginRecoveryRuns.delete(loginKey); }
}

async function performLoginCheck(task, connector, run, pageResult, runtime, assertCurrent) {
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  assertCurrent();
  const loginState = await runtime.browserLoginStatus({ sessionId, adapterId: task.target.adapterId || connector?.adapterId });
  assertCurrent();
  task.target.loginHeartbeatAt = new Date().toISOString();
  const needsLogin = pageResult?.code === "REAUTH_REQUIRED" || /#\/login/.test(String(pageResult?.url || pageResult?.page?.url || "")) || !loginState.authenticated;
  if (!needsLogin && pageResult?.ok) {
    task.target.loginStatus = "authenticated";
    completeWorkflow(task, "login", "登录态有效");
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", message: "目标页面已登录，继续采集" });
    persistTask(task);
    return { ok: true, authenticated: true };
  }
  logStage(task, run, "login", needsLogin ? "检测到登录页或登录过期，准备填充并提交登录" : "确认登录态");
  if (!task.target.credentialRef || task.target.credentialRef === "credential:demo") {
    task.target.loginStatus = "REAUTH_REQUIRED";
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: "缺少托管凭据，无法自动登录" });
    persistTask(task);
    return { ok: false, code: "REAUTH_REQUIRED", message: "目标网页登录态已失效，需要重新登录" };
  }
  const login = await runtime.browserLogin({
    sessionId,
    credentialRef: task.target.credentialRef,
    ownerUserId: task.ownerUserId || "",
    adapterId: task.target.adapterId || connector?.adapterId,
    targetUrl: task.target.url || connector?.target || HAO_HAN_TARGET_URL,
    automationAuthorized: true,
    submit: true,
  });
  assertCurrent();
  if (!login.ok) {
    task.target.loginStatus = "REAUTH_REQUIRED";
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: `登录失败：${login.message || login.code}`, data: { code: login.code } });
    persistTask(task);
    return login;
  }
  task.target.loginStatus = login.authenticated ? "authenticated" : "credential_required";
  if (login.authenticated) {
    task.target.sessionRevision = Number(task.target.sessionRevision || 0) + 1;
    task.monitorFailureCount = 0;
    setNextPoll(task, 0);
    const controller = controllerLoops.get(task.id);
    if (controller && !controller.running && !controller.stopped) {
      clearTimeout(controller.timer);
      controller.timer = null;
      scheduleController(task.id, 0);
    }
  }
  completeWorkflow(task, "login", login.authenticated ? "登录已提交" : "已填充登录表单");
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", message: login.authenticated ? "登录已提交，等待交易页" : "登录表单已填充但未确认提交" });
  persistTask(task);
  return login;
}

async function observeWithLoginRecovery(task, connector, run, runtime, observe, assertCurrent) {
  const revision = Number(task.target.sessionRevision || 0);
  const lastHeartbeatAt = task.target.loginHeartbeatAt ? new Date(task.target.loginHeartbeatAt).getTime() : NaN;
  const heartbeatDue = (task.target.loginStatus === "authenticated" || Number.isFinite(lastHeartbeatAt))
    && (!Number.isFinite(lastHeartbeatAt) || Date.now() - lastHeartbeatAt >= LOGIN_HEARTBEAT_INTERVAL_MS);
  if (heartbeatDue && typeof runtime.browserLoginStatus === "function") {
    const sessionId = task.target.browserSessionId || `task:${task.id}`;
    let loginState = null;
    try { loginState = await runtime.browserLoginStatus({ sessionId, adapterId: task.target.adapterId || connector?.adapterId }); } catch {}
    assertCurrent();
    task.target.loginHeartbeatAt = new Date().toISOString();
    if (loginState && loginState.authenticated === false) {
      const login = await ensureLoggedIn(task, connector, run, { code: "REAUTH_REQUIRED", url: loginState?.url || "" }, runtime, assertCurrent);
      assertCurrent();
      if (!login?.ok || !login.authenticated) return { ...login, ok: false, code: "REAUTH_REQUIRED", loginCode: login?.code };
    }
  }
  const market = await observe();
  assertCurrent();
  if (market?.code !== "REAUTH_REQUIRED") return market;
  // A concurrent monitor may already have recovered while this read was queued.
  if (Number(task.target.sessionRevision || 0) === revision) {
    const login = await ensureLoggedIn(task, connector, run, market, runtime, assertCurrent);
    assertCurrent();
    if (!login.ok || !login.authenticated) return { ...login, ok: false, code: "REAUTH_REQUIRED", loginCode: login.code };
  }
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", message: "登录已恢复，立即重新读取持仓和委托并继续监控" });
  // Only retry the read. Never replay an order whose submission is uncertain.
  const fresh = await observe();
  assertCurrent();
  return fresh;
}

function stopForLoginFailure(task, run, result) {
  const code = String(result?.code || "LOGIN_NOT_CONFIRMED");
  const reauth = /LOGIN|REAUTH|CREDENTIAL|BROWSER_SESSION|TARGET_MISMATCH|NAVIGATION/.test(code);
  const route = reauth ? "REAUTH_REQUIRED" : "CONNECT_FAILED";
  task.decision = holdDecision(code, reauth ? "重新登录并确认目标页面后重试" : "恢复目标连接后重试");
  task.monitorFailureCount = Number(task.monitorFailureCount || 0) + 1;
  task.status = task.stopLocked ? "MANUAL_CONTROL" : (run.trigger === "controller" || task.monitoringEnabled === true ? "PAUSED" : "BLOCKED");
  setNextPoll(task, monitorRetryDelay(task));
  task.target.loginStatus = reauth ? "reauth_required" : "connection_failed";
  completeWorkflow(task, "login", result?.message || code);
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: `登录或连接未确认：${result?.message || code}`, data: { code } });
  addEvent("login_blocked", "目标登录或连接未确认，分析保持 HOLD", { taskId: task.id, runId: run.id, code, route });
  finishAgentRun(run.id, { status: "paused", action: "HOLD", route, code });
  persistTask(task);
  return { task, market: task.market || null, run, route, login: result, analysisTriggered: false };
}

function toTaskMarket(market) {
  return {
    ok: market.ok !== false,
    code: market.code || "READONLY_MARKET_READ",
    message: market.message || "",
    source: market.source,
    sourceKind: market.sourceKind,
    symbol: market.symbol,
    symbolName: market.symbolName,
    instrumentId: market.instrumentId,
    instrument: market.instrument || market.page?.instrument || null,
    timeframe: market.timeframe,
    historyCount: market.historyCount || market.history?.length || 0,
    completeHistoryCount: market.completeHistoryCount || 0,
    latest: market.quote || market.latest || { price: 0, open: 0, high: 0, low: 0, volume: 0 },
    changePct: market.changePct === null || market.changePct === undefined ? null : Number(market.changePct),
    indicators: market.indicators || { ema20: null, ema50: null, sma20: null, rsi14: null, atr14: null, volumeRatio: null, macd: { line: null, signal: null, histogram: null }, bollinger: { middle: null, upper: null, lower: null } },
    trend: market.trend,
    anomaly: Boolean(market.anomaly),
    freshnessSec: market.freshnessSec === null || market.freshnessSec === undefined ? null : Number(market.freshnessSec),
    evidenceId: market.evidenceId,
    fingerprint: market.fingerprint,
    observedAt: market.observedAt,
    dataAt: market.dataAt,
    dataQuality: market.dataQuality,
    missingFields: market.missingFields || [],
    marketClosed: Boolean(market.marketClosed),
    history: Array.isArray(market.history) ? market.history : [],
    ticks: Array.isArray(market.ticks) ? market.ticks : [],
    timeframes: market.timeframes && typeof market.timeframes === "object" ? market.timeframes : {},
    availableTimeframes: Array.isArray(market.availableTimeframes) ? market.availableTimeframes : [],
    timeline: market.timeline || { kind: "timeline", ticks: Array.isArray(market.ticks) ? market.ticks : [], tickCount: Array.isArray(market.ticks) ? market.ticks.length : 0 },
    page: market.page || null,
    pageView: market.pageView || market.page?.view || null,
    orderBook: market.orderBook || null,
    raw: market.raw || null,
    account: market.account || { availableFunds: null, equity: null, riskRate: null, dayPnl: null },
    books: Array.isArray(market.books) ? market.books : [],
    availableBoards: Array.isArray(market.availableBoards) ? market.availableBoards : [],
    bookCount: Number(market.bookCount || market.books?.length || 0),
    expectedBookCount: Number(market.expectedBookCount || market.boardCoverage?.expected || market.books?.length || 0),
    boardCoverage: market.boardCoverage || null,
  };
}

function syncTaskMetricsFromMarket(task, market) {
  task.metrics = accountMetricsFromMarket(market?.account || {}, task.metrics || {});
}

function marketQualityIssues(market) {
  const issues = blockingMissingFields(market?.missingFields);
  if (Number(market?.historyCount || market?.history?.length || 0) < 20) issues.push("HISTORY_INSUFFICIENT");
  if (Number(market?.freshnessSec) > 5) issues.push("STALE_MARKET_DATA");
  return [...new Set(issues)];
}

function monitoredBooks(market) {
  const books = Array.isArray(market?.books) ? market.books.filter(Boolean) : [];
  return books.length ? books : market ? [market] : [];
}

function normalizedInstrumentValues(value) {
  return [value?.symbol, value?.symbolName, value?.instrumentId]
    .map((item) => String(item || "").trim().toLocaleLowerCase())
    .filter(Boolean);
}

export function decisionTargetBook(decision, market) {
  const targetValues = normalizedInstrumentValues({
    symbol: decision?.targetSymbol,
    symbolName: decision?.targetSymbolName,
    instrumentId: decision?.targetInstrumentId,
  });
  if (!targetValues.length) return null;
  const targetSet = new Set(targetValues);
  return monitoredBooks(market).find((book) => normalizedInstrumentValues(book).some((value) => targetSet.has(value))) || null;
}

export function bindDecisionToMarket(decision, market) {
  const books = monitoredBooks(market);
  const boardAssessments = uniqueBoardAssessments(decision?.boardAssessments, books);
  if (!decision || (decision.action !== "BUY" && decision.action !== "SELL")) return decision ? { ...decision, boardAssessments } : decision;
  if (decision.exitType && decision.targetPositionIds?.length) {
    const verified = openPositionsFromMarket(market).filter((position) => decision.targetPositionIds.includes(String(position.positionOrderId || "")));
    if (verified.length === decision.targetPositionIds.length && verified.every((position) => closingActionForPositions([position]) === decision.action)) return { ...decision, boardAssessments };
  }
  const requestedTarget = normalizedInstrumentValues({
    symbol: decision.targetSymbol,
    symbolName: decision.targetSymbolName,
    instrumentId: decision.targetInstrumentId,
  });
  const assessmentTarget = !requestedTarget.length
    ? boardAssessments
      .filter((item) => item.action === decision.action)
      .sort((left, right) => Number(right.profitProbability || 0) - Number(left.profitProbability || 0))[0]
    : null;
  const primaryValues = normalizedInstrumentValues(market);
  const target = decisionTargetBook(decision, market)
    || (assessmentTarget ? decisionTargetBook({
      targetSymbol: assessmentTarget.symbol,
      targetSymbolName: assessmentTarget.symbolName,
      targetInstrumentId: assessmentTarget.instrumentId,
    }, market) : null)
    || (!requestedTarget.length && primaryValues.length ? books.find((book) => normalizedInstrumentValues(book).some((value) => primaryValues.includes(value))) : null)
    || (!requestedTarget.length && books.length === 1 ? books[0] : null);
  if (!target) {
    return {
      ...decision,
      action: "HOLD",
      targetSymbol: "",
      targetSymbolName: "",
      targetInstrumentId: "",
      targetPositionPct: 0,
      maxOrderValuePct: 0,
      invalidation: requestedTarget.length ? "模型指定的盘口不在本轮监控列表中" : "多个盘口下的买卖建议必须明确指定目标盘口",
      riskFlags: [...new Set([...(decision.riskFlags || []), requestedTarget.length ? "TARGET_BOARD_NOT_MONITORED" : "TARGET_BOARD_REQUIRED"])],
      boardAssessments,
    };
  }
  return {
    ...decision,
    targetSymbol: String(target.symbol || ""),
    targetSymbolName: String(target.symbolName || ""),
    targetInstrumentId: String(target.instrumentId || ""),
    boardAssessments,
  };
}

function failedAutomaticRules(task) {
  return task.rules.filter((rule) => rule.mode === "AUTO" && rule.status === "pending");
}

function recentAnalysisRounds(taskId, limit = 8) {
  return state.analyses
    .filter((analysis) => String(analysis.taskId) === String(taskId))
    .slice(0, Math.max(1, Number(limit) || 8))
    .reverse()
    .map((analysis, index) => ({
      round: analysis.round ?? index + 1,
      trigger: analysis.trigger || "",
      route: analysis.route || "",
      createdAt: analysis.createdAt || null,
      market: {
        fingerprint: analysis.market?.fingerprint || "",
        symbol: analysis.market?.symbol || "",
        symbolName: analysis.market?.symbolName || "",
        timeframe: analysis.market?.timeframe || "",
        trend: analysis.market?.trend || "",
        latest: analysis.market?.latest || analysis.market?.quote || null,
        changePct: analysis.market?.changePct ?? null,
        indicators: analysis.market?.indicators || null,
        dataQuality: analysis.market?.dataQuality || "",
        missingFields: analysis.market?.missingFields || [],
      },
      decision: analysis.decision || holdDecision("PRIOR_DECISION_UNAVAILABLE", "当前轮次重新读取数据后判断"),
    }));
}

function decisionExecutionPolicy(task) {
  return isLiveTask(task) ? {
    entryMode: task.autoDecisionEnabled ? "automatic" : "manual_submit", entryDecision: "AI_ONLY",
    minimumProbability: MIN_PROFIT_PROBABILITY, emptyOnly: true,
    exitsAutomatic: true, exitDecision: "PROGRAM_PROFIT_AI_LOSS", cancellationsAutomatic: true,
    summaryExitReview: { profitPoints: SUMMARY_PROFIT_POINTS, lossPoints: SUMMARY_LOSS_POINTS,
      unit: "DIRECTIONAL_PRICE_POINTS", execution: "SUMMARY_TRANSFER" },
    currentOrderCancellation: { waitMs: CURRENT_ORDER_WAIT_MS, scope: "unfilled_remainder", priceIndependent: true },
    rulesRole: "advisory", rulesBlockExecution: false,
  } : undefined;
}

function previousAnalysisContext(task) {
  return {
    fingerprint: task.lastAnalyzedFingerprint || null,
    succeeded: task.lastAnalysisSucceeded !== false,
    decision: task.decision,
    analyzedAt: task.lastAnalysisAt || null,
    exitPlans: isLiveTask(task) ? [] : (task.exitPlans || []).map(plan => ({ ...plan })),
  };
}

export function buildDecisionContext(task, market, evidence, trigger, analysisMarket = market) {
  const layered = analysisMarket?.analysisLayers ? analysisMarket : buildLayeredAnalysisMarket(analysisMarket || task.market);
  const positionContext = updatePositionTracking(task, market, Date.now());
  return {
    market: {
      symbol: market.symbol,
      symbolName: market.symbolName,
      instrumentId: market.instrumentId,
      instrument: market.instrument,
      timeframe: layered.timeframe,
      trend: layered.trend,
      anomaly: layered.anomaly,
      freshnessSec: market.freshnessSec,
      indicators: layered.indicators,
      latest: layered.latest,
      historyCount: layered.historyCount,
      history: layered.history,
      ticks: layered.ticks || [],
      timeline: layered.timeline,
      timeframes: layered.timeframes,
      availableTimeframes: layered.availableTimeframes,
      analysisLayers: layered.analysisLayers,
      quote: layered.quote,
      dataQuality: market.dataQuality,
      missingFields: market.missingFields || [],
      marketClosed: Boolean(market.marketClosed),
      source: market.source,
      sourceKind: market.sourceKind,
      dataAt: market.dataAt,
      observedAt: market.observedAt,
      nextCandle: layered.nextCandle || nextCandleTarget({ ...layered, quote: market.quote, latest: task.market?.latest || market.latest || market.quote }, Date.now()),
      strategy: layered.strategy || LIVE_BOARD_STRATEGY,
      books: layered.books || [],
      bookCount: Number(layered.bookCount || layered.books?.length || 0),
      expectedBookCount: Number(layered.expectedBookCount || layered.boardCoverage?.expected || layered.books?.length || 0),
      boardCoverage: layered.boardCoverage || null,
      page: layered.page ?? task.market.page,
      pageView: layered.pageView ?? task.market.pageView ?? task.market.page?.view ?? null,
      positions: positionContext,
      rawPositions: Array.isArray(layered.positions) ? layered.positions : Array.isArray(market.account?.positions) ? market.account.positions : [],
      positionContext,
      orderBook: layered.orderBook || null,
      raw: layered.raw,
    },
    account: {
      ...task.metrics,
      ...(market.account || {}),
      positionContext,
    },
    realtimeObservations: recentLiveObservations(task),
    rules: task.rules,
    executionPolicy: decisionExecutionPolicy(task),
    strategy: { ...LIVE_BOARD_STRATEGY, entryQuantity: entryQuantityForTask(task) },
    approvedSkills: approvedSkillsForContext(evidence),
    experiencePrompt: buildApprovedExperiencePrompt(evidence),
    evidence: evidence.map(({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, tags, segmentId, rowStart, rowEnd, rowCount, contentHash }) => ({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, tags, segmentId, rowStart, rowEnd, rowCount, contentHash })),
    evidenceIds: evidence.map((item) => item.evidenceId).filter(Boolean),
    previousAnalysis: previousAnalysisContext(task),
    conversation: {
      round: Number(task.monitoringRound || 0) + 1,
      trigger,
      previousFingerprint: task.lastAnalyzedFingerprint || null,
      recentRounds: recentAnalysisRounds(task.id),
    },
  };
}

function segmentConcurrency() {
  const value = Number(process.env.ANALYSIS_SEGMENT_CONCURRENCY || 3);
  return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 3));
}

function segmentRetries() {
  const value = Number(process.env.ANALYSIS_SEGMENT_RETRIES || 1);
  return Math.min(2, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 1));
}

function segmentLabel(segment) {
  if (segment.kind === "kline" || segment.kind === "timeframe_ticks") return `${segment.timeframe} ${segment.kind === "kline" ? "K 线" : "逐笔"}`;
  if (segment.kind === "live_ticks") return "实时逐笔";
  if (segment.kind === "snapshot_context") return "报价与账户只读字段";
  if (segment.kind === "page") return "页面可见字段";
  return "只读原始字段";
}

function directAnalysisCoverage(market) {
  const timeframeEntries = Object.values(market?.timeframes || {});
  const totalKlineRows = timeframeEntries.length
    ? timeframeEntries.reduce((sum, snapshot) => sum + Number(snapshot?.historyCount ?? snapshot?.history?.length ?? 0), 0)
    : Number(market?.historyCount ?? market?.history?.length ?? 0);
  return {
    mode: "direct_full_snapshot",
    fingerprint: String(market?.fingerprint || ""),
    estimatedDirectBytes: estimateMarketContextBytes(market),
    totalSegments: 1,
    totalKlineRows,
    totalLiveTickRows: Array.isArray(market?.ticks) ? market.ticks.length : 0,
    reviewedSegments: 1,
    failedSegments: [],
    complete: true,
  };
}

async function reviewAllMarketSegments({ task, run, provider, runtime, market, evidence, assertCurrent = () => {}, signal } = {}) {
  assertCurrent();
  const plan = buildMarketAnalysisSegments(market);
  const reviews = new Array(plan.segments.length);
  const failures = [];
  let cursor = 0;
  let stopped = false;
  const segmentContext = {
    symbol: market.symbol,
    symbolName: market.symbolName,
    primaryTimeframe: market.timeframe,
    rules: task.rules,
    experiencePrompt: buildApprovedExperiencePrompt(evidence),
    evidence: evidence.map(({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, tags }) => ({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, tags })),
    coverage: plan.coverage,
  };
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "coverage", message: `分层行情已拆分为 ${plan.segments.length} 个 AI 分析片段：走完的 K 作历史，预测下一根将在每分钟第50秒打印的K`, data: { coverage: plan.coverage } });
  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw analysisTimeoutError(signal.reason);
      if (task.stopLocked) {
        stopped = true;
        return;
      }
      assertCurrent();
      const index = cursor;
      cursor += 1;
      if (index >= plan.segments.length) return;
      const segment = plan.segments[index];
      let review = null;
      let lastFailure = null;
      for (let attempt = 0; attempt <= segmentRetries(); attempt += 1) {
        if (task.stopLocked) {
          stopped = true;
          return;
        }
        assertCurrent();
        try {
          review = await runtime.requestSegmentReview(provider, segment, segmentContext, {
            ...(analysisTimeoutMs() > 0 ? { timeoutMs: analysisTimeoutMs() } : {}),
            signal,
          });
          assertCurrent();
          if (review?.ok && String(review.segmentId) === String(segment.segmentId) && String(review.contentHash) === String(segment.contentHash) && Number(review.rowCount) === Number(segment.rowCount)) break;
          lastFailure = review || { ok: false, code: "INVALID_SEGMENT_REVIEW" };
        } catch (error) {
          if (error instanceof CycleAbortError) throw error;
          if (isAnalysisTimeout(error) || signal?.aborted) throw analysisTimeoutError(error);
          lastFailure = { ok: false, code: error?.message || "SEGMENT_REVIEW_FAILED" };
        }
      }
      if (task.stopLocked) {
        stopped = true;
        return;
      }
      if (review?.ok && String(review.segmentId) === String(segment.segmentId) && String(review.contentHash) === String(segment.contentHash) && Number(review.rowCount) === Number(segment.rowCount)) {
        reviews[index] = review;
        appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "segment", message: `片段 ${index + 1}/${plan.segments.length} 已完成：${segmentLabel(segment)}，${segment.rowCount} 行`, data: { segmentId: segment.segmentId, contentHash: segment.contentHash, rowCount: segment.rowCount } });
      } else {
        const failure = { segmentId: segment.segmentId, kind: segment.kind, timeframe: segment.timeframe, rowStart: segment.rowStart, rowEnd: segment.rowEnd, rowCount: segment.rowCount, contentHash: segment.contentHash, code: String(lastFailure?.code || "SEGMENT_REVIEW_FAILED") };
        failures.push(failure);
        appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "segment", level: "error", message: `片段 ${index + 1}/${plan.segments.length} 未完成：${segmentLabel(segment)}，下一轮重试`, data: failure });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(segmentConcurrency(), plan.segments.length) }, () => worker()));
  assertCurrent();
  failures.sort((left, right) => String(left.segmentId).localeCompare(String(right.segmentId)));
  const coverage = {
    ...plan.coverage,
    reviewedSegments: reviews.filter(Boolean).length,
    failedSegments: failures,
    complete: !stopped && failures.length === 0 && reviews.filter(Boolean).length === plan.segments.length,
  };
  return { ...plan, reviews, failures, coverage, stopped };
}

export function enforceDecisionLimits(decision) {
  if (decision.action === "HOLD") return { ...decision, targetPositionPct: 0, maxOrderValuePct: 0 };
  const targetPositionPct = Number(decision.targetPositionPct) || 0;
  const maxOrderValuePct = Number(decision.maxOrderValuePct) || 0;
  return { ...decision, targetPositionPct, maxOrderValuePct };
}

function abandonTimedOutAnalysis(task, run, market) {
  task.lastAnalysisSucceeded = false;
  task.status = monitoringIntent(task) ? "MONITORING" : "MANUAL_CONTROL";
  task.nextTrigger = "分析超时未返回，刷新页面数据后继续监控";
  completeWorkflow(task, "analyze", "分析超时，放弃本轮结果");
  completeWorkflow(task, "rules", "本轮未形成有效决策");
  completeWorkflow(task, "action", "刷新页面数据继续监控");
  appendAgentOutput({
    taskId: task.id,
    runId: run.id,
    stage: "analyze",
    level: "error",
    message: "分析超时未返回，已放弃本轮结果；刷新页面数据并继续监控",
  });
  finishAgentRun(run.id, { status: "timeout", action: "HOLD", route: "ANALYSIS_TIMEOUT", code: "ANALYSIS_TIMEOUT" });
  setNextPoll(task, 0);
  task.nextTrigger = "分析超时未返回，刷新页面数据后继续监控";
  persistTask(task);
  return { task, market, run, skipped: true, reason: "ANALYSIS_TIMEOUT", analysisTriggered: false, route: "ANALYSIS_TIMEOUT" };
}

function abandonChangedAnalysis(task, run, market, code) {
  task.lastAnalysisSucceeded = false;
  task.decision = { ...holdDecision(code, "使用最新盘面重新分析"), observedAt: market.observedAt };
  task.status = monitoringIntent(task) ? "MONITORING" : "MANUAL_CONTROL";
  task.nextTrigger = "盘面或持仓已变化，使用最新数据重新分析";
  completeWorkflow(task, "analyze", task.nextTrigger);
  completeWorkflow(task, "rules", "旧分析失效");
  completeWorkflow(task, "action", "继续监控已授权条件，重新分析新动作");
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "exit_monitor",
    message: "分析期间盘面或持仓已变化，废弃旧结论，立即读取最新数据重算", data: { code } });
  finishAgentRun(run.id, { status: "skipped", action: "HOLD", route: code, code });
  setNextPoll(task, 0);
  persistTask(task);
  return { task, market, run, skipped: true, reason: code, route: code, analysisTriggered: false };
}

// User policy: give each current order 120 seconds to fill before withdrawing
// its verified remainder, independently of AI or current price.
// The existing submission slot prevents cancellation racing a browser write.
async function cancelCurrentOrders(task, market, connector, run, runtime, assertCurrent, now = Date.now()) {
  if (!isLiveTask(task) || !isTradingSwitchOn() || market.account?.openOrdersVerified !== true
    || pendingConfirmLocks.has(task.id)) return null;
  assertCurrent();
  const previousIds = new Set(Object.keys(task.currentOrderTracking || {}));
  const { orderIds: expiredIds, waiting } = currentOrderCancellationPlan(task, market.account, now);
  const orderIds = expiredIds;
  const newWaiting = waiting.filter(item => !previousIds.has(item.orderId));
  if (newWaiting.length) appendAgentOutput({ taskId: task.id, runId: run?.id, stage: "action", kind: "order",
    message: `${newWaiting.length} 笔当前委托等待成交，满 2 分钟后仍未成交才撤剩余数量`, data: { waiting: newWaiting } });
  if (!orderIds.length) return null;
  const abort = new AbortController();
  const cancelSubmission = () => abort.abort(new Error("ORDER_CANCEL_ABORTED"));
  pendingConfirmLocks.add(task.id);
  pendingSubmissionCancels.set(task.id, cancelSubmission);
  appendAgentOutput({ taskId: task.id, runId: run?.id, stage: "action", kind: "order",
    message: `${orderIds.length} 笔当前委托已等待至少 2 分钟，撤销剩余未成交数量`, data: { orderIds } });
  let cancellation;
  try {
    try {
      cancellation = await runtime.cancelOpenOrders({ sessionId: task.target.browserSessionId || `task:${task.id}`, orderIds }, { signal: abort.signal });
    } catch (error) {
      assertCurrent();
      abort.signal.throwIfAborted();
      if (!/REAUTH|LOGIN|SESSION_EXPIRED|AUTH/i.test(String(error?.message || error?.code || ""))) throw error;
      const login = await ensureLoggedIn(task, connector, run || { id: null }, { code: "REAUTH_REQUIRED" }, runtime, assertCurrent);
      assertCurrent();
      abort.signal.throwIfAborted();
      if (!login?.ok || !login.authenticated) throw new Error("ORDER_CANCEL_REAUTH_FAILED");
      cancellation = await runtime.cancelOpenOrders({ sessionId: task.target.browserSessionId || `task:${task.id}`, orderIds }, { signal: abort.signal });
    }
  } catch (error) {
    assertCurrent();
    abort.signal.throwIfAborted();
    cancellation = { ok: false, code: "ORDER_CANCEL_FAILED", message: error.message };
  } finally {
    if (pendingSubmissionCancels.get(task.id) === cancelSubmission) pendingSubmissionCancels.delete(task.id);
    pendingConfirmLocks.delete(task.id);
  }
  assertCurrent();
  const results = orderIds.map(orderId => cancellation?.results?.find(result => String(result.orderId) === orderId)
    || { orderId, ok: false, cancelled: false, code: cancellation?.code || "ORDER_CANCEL_RESULT_MISSING", message: cancellation?.message || "未收到该委托的撤销结果，不能认定撤单成功" });
  cancellation = { ...cancellation, results, ok: results.every(result => result.cancelled === true) };
  for (const result of results) appendAgentOutput({ taskId: task.id, runId: run?.id, stage: "action", kind: "order",
    message: result.cancelled ? `委托 ${result.orderId} 已撤销剩余未成交数量` : `委托 ${result.orderId} 撤销结果：${result.message || result.code}，继续核对当前委托`, data: result });
  const cancelledIds = new Set(results.filter(result => result.cancelled === true).map(result => String(result.orderId)));
  for (const pending of [task.pendingAction, ...(task.unsettledActions || [])].filter(Boolean)) {
    if (!["WAITING", "AWAITING_FILL", "UNVERIFIED"].includes(pending.status) || !pending.entrustedOrderIds?.length
      || !pending.entrustedOrderIds.every(id => cancelledIds.has(String(id)))) continue;
    pending.status = "CANCELLED";
    pending.resolvedAt = new Date().toISOString();
    pending.message = "已按策略撤销委托剩余数量；已成交部分继续按持仓监控";
    recordConfirmedOrder(task, pending, { status: "cancelled_remainder", submitted: true, source: "current_order_policy", message: pending.message });
  }
  task.unsettledActions = (task.unsettledActions || []).filter(pending => pending.status !== "CANCELLED");
  task.decision = { ...task.decision, orderCancellation: cancellation };
  return cancellation;
}

export async function runAnalysis(taskId, providerId = "", { trigger = "manual", userId = "", skipIfUnchanged = false, monitorRecentOnly = false, runtime: runtimeOverrides = {} } = {}) {
  const existing = getTask(taskId);
  if (!existing) throw new Error("TASK_NOT_FOUND");
  const resolvedUserId = userId || existing.ownerUserId || "";
  if (desktopAiRequired() && !hasDesktopAi(resolvedUserId) && typeof runtimeOverrides.requestDecision !== "function") {
    throw new Error("DESKTOP_AI_OFFLINE");
  }
  if (pauseForPendingAction(existing) && trigger !== "manual") {
    return { task: existing, market: existing.market || null, skipped: true, reason: "PENDING_USER_CONFIRM", analysisTriggered: false };
  }
  const acquired = await acquireCycle(taskId, { wait: trigger === "manual" });
  if (!acquired) return { task: existing, market: existing.market || null, skipped: true, reason: "CYCLE_IN_PROGRESS", analysisTriggered: false };
  const task = getTask(taskId);
  if (!task) {
    activeCycles.delete(taskId);
    notifyCycleIdle(taskId);
    throw new Error("TASK_NOT_FOUND");
  }
  const runtime = resolveRuntime(runtimeOverrides, { userId: resolvedUserId, providerId: providerId || existing.providerId || "" });
  const run = startAgentRun(taskId, { trigger });
  const generation = taskGeneration(task);
  const assertCurrent = () => assertCycleCurrent(task, generation);
  const statusBeforeCycle = task.status;
  const cycleStartedAt = Date.now();
  const exitRevisionAtStart = Number(task.exitExecutionRevision || 0);
  let modelStartedAt = cycleStartedAt;
  try {
    assertCurrent();
    task.status = "ANALYZING";
    task.lastCycleAt = new Date().toISOString();
    persistTask(task);
    const connector = getConnector(task.target.connectorId);
    const opened = await ensureConnected(task, connector, run, runtime, assertCurrent);
    assertCurrent();
    const loginResult = opened?.ok
      ? await ensureLoggedIn(task, connector, run, opened, runtime, assertCurrent)
      : { ok: false, authenticated: false, code: opened?.code || "BROWSER_NOT_OPENED", message: opened?.message || "目标页面未打开" };
    assertCurrent();
    if (!loginResult.ok || !loginResult.authenticated) return stopForLoginFailure(task, run, loginResult);

    if (isLiveTask(task) && !task.autoDecisionEnabled && !task.pendingAction?.exitType && ["WAITING", "AWAITING_FILL"].includes(task.pendingAction?.status)) {
      const continued = await runtime.continueManualEntry({ sessionId: task.target?.browserSessionId || `task:${task.id}`, action: task.pendingAction.action,  });
      assertCurrent();
      if (continued?.continued) {
        task.pendingAction = { ...task.pendingAction, status: "AWAITING_FILL", source: "manual_browser", message: "用户已点击入场，Agent 已自动处理网页确认；继续监控成交与离场" };
      }
    }

    logStage(task, run, "collect", "读取网页可见数据与只读行情");
    await positionExitRuns.get(taskId)?.catch(() => {});
    let market = await observeWithLoginRecovery(task, connector, run, runtime,
      () => runtime.observeMarket(task, connector), assertCurrent);
    assertCurrent();
    if (!market.ok) {
      const paused = market.code === "REAUTH_REQUIRED";
      const route = paused ? "REAUTH_REQUIRED" : "COLLECT_FAILED";
      task.decision = holdDecision(market.code, paused ? "重新登录后重试" : "数据采集恢复后重试");
      task.status = paused ? "BLOCKED" : "PAUSED";
      task.target.loginStatus = paused ? "REAUTH_REQUIRED" : task.target.loginStatus;
      setNextPoll(task, monitorRetryDelay(task));
      appendAgentOutput({ taskId, runId: run.id, stage: "collect", level: "error", message: `数据采集暂停：${market.message}`, data: { code: market.code } });
      addEvent("market_paused", `数据采集暂停：${market.message}`, { taskId, code: market.code, runId: run.id });
      finishAgentRun(run.id, { status: "paused", action: "HOLD", route, code: market.code });
      persistTask(task);
      return { task, market, run, route };
    }
    if (isLiveTask(task) && task.pendingAction?.status === "WAITING" && !task.pendingAction.source
      && Date.parse(market.observedAt) > Date.parse(task.decision?.observedAt || task.pendingAction.createdAt) + Number(task.decision?.ttlSec || 300) * 1000) {
      task.pendingAction.status = "CANCELLED";
      task.pendingAction.message = "未提交入场建议已过期，重新请求AI判断";
    }
    const previousMarket = task.market;
    const sessionRevision = Number(task.target.sessionRevision || 0);
    task.market = toTaskMarket(market);
    reconcilePendingPosition(task, market);
    syncTaskMetricsFromMarket(task, market);
    if (typeof market.account?.openOrdersVerified === "boolean") appendAgentOutput({
      taskId, runId: run.id, stage: "collect", kind: "order",
      message: market.account.openOrdersVerified
        ? `当前委托已核实：${market.account.openOrders?.length || 0} 笔；等待满 2 分钟后仍未成交才撤剩余数量`
        : "当前委托读取未核实；不能当作没有委托，下轮继续读取",
      data: { verified: market.account.openOrdersVerified, orderIds: (market.account.openOrders || []).map(order => order.orderId),
        availableFunds: market.account.availableFunds ?? null, frozenFunds: market.account.frozenFunds ?? null, frozenMargin: market.account.frozenMargin ?? null },
    });
    const cycleCancellation = await cancelCurrentOrders(task, market, connector, run, runtime, assertCurrent);
    if (cycleCancellation) {
      const fresh = await observeWithLoginRecovery(task, connector, run, runtime,
        () => runtime.observeExecutionMarket(task, connector, { accountScope: "full" }), assertCurrent);
      assertCurrent();
      market = { ...market, account: fresh?.ok ? fresh.account : { ...market.account, positionsVerified: false, openOrdersVerified: false } };
      task.market = toTaskMarket(market);
      reconcilePendingPosition(task, market);
      syncTaskMetricsFromMarket(task, market);
    }
    task.lastPolledAt = new Date().toISOString();
    task.lastObservedFingerprint = String(market.fingerprint || "");
    task.monitorFailureCount = 0;
    const monitoredBoardLabels = (market.books || []).map((book) => book.symbolName || book.symbol || book.instrumentId).filter(Boolean);
    const monitoredCount = Number(market.bookCount || market.books?.length || 1);
    const expectedCount = Number(market.expectedBookCount || market.boardCoverage?.expected || monitoredCount);
    completeWorkflow(task, "collect", `${monitoredCount}/${expectedCount} 个盘 · ${task.market.historyCount} 根主盘 K 线 · ${market.source}`);
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "collect",
      message: `已采集 ${monitoredCount}/${expectedCount} 个盘${monitoredBoardLabels.length ? `（${monitoredBoardLabels.join("、")}）` : ""} · 当前盘 ${market.symbolName || market.symbol || task.symbol} 最新价 ${task.market.latest.price}，趋势 ${market.trend}，来源 ${market.source}`,
      data: { source: market.source, freshnessSec: market.freshnessSec, historyCount: task.market.historyCount, bookCount: monitoredCount, expectedBookCount: expectedCount, boardCoverage: market.boardCoverage || null, books: (market.books || []).map((book) => ({ symbol: book.symbol, symbolName: book.symbolName, historyCount: book.historyCount })), missingFields: market.missingFields || [] },
    });
    if (isLiveTask(task)) {
      const roundBlock = entryRoundBlock(task, market);
      if (roundBlock) {
        task.status = "MONITORING";
        const message = ({ ROUND_HOLDING: "本轮持仓中；盈利≥1点立即离场；亏损≤-2点请求AI判断是否离场，清零后开始下一轮",
          ROUND_ORDER_PENDING: "本轮委托尚未完成，继续核实成交；不重复入场",
          ROUND_ACTION_PENDING: "本轮入场等待提交或核实，不生成第二笔入场",
          ACCOUNT_UNVERIFIED: "账户表格未全部核实，继续读取持仓汇总与当前委托" })[roundBlock];
        task.decision = { ...holdDecision(roundBlock, message), analysisSummary: message };
        if (cycleCancellation) task.decision.orderCancellation = cycleCancellation;
        completeWorkflow(task, "analyze", message);
        completeWorkflow(task, "action", message);
        finishAgentRun(run.id, { status: "skipped", action: "HOLD", route: roundBlock, code: roundBlock });
        setNextPoll(task, 2000);
        persistTask(task);
        return { task, market, run, skipped: true, reason: roundBlock, route: roundBlock, analysisTriggered: false };
      }
    }
    const currentKWindow = nextCandleTarget({}, Date.now()).closeTime;
    const lastAnalyzedKWindow = task.lastAnalysisAt ? nextCandleTarget({}, new Date(task.lastAnalysisAt).getTime()).closeTime : null;
    const marketUnchanged = Boolean(skipIfUnchanged && openPositionCount(market) === 0 && !market.account?.openOrders?.length && market.account?.openOrdersVerified !== false && market.fingerprint && task.lastAnalyzedFingerprint === market.fingerprint && task.lastAnalysisSucceeded !== false && !decisionExpired(task) && lastAnalyzedKWindow === currentKWindow);
    if (marketUnchanged) {
      const pendingRule = task.rules.some((rule) => rule.status === "pending");
      task.status = monitoringIntent(task)
        ? (["PAUSED", "BLOCKED"].includes(statusBeforeCycle) && pendingRule ? statusBeforeCycle : "MONITORING")
        : "MANUAL_CONTROL";
      task.nextTrigger = "行情未变化，等待下一次只读检查";
      completeWorkflow(task, "analyze", "行情指纹未变化，跳过模型请求");
      completeWorkflow(task, "rules", "本轮未触发新分析");
      completeWorkflow(task, "action", "沿用上一轮建议，未执行任何动作");
      appendAgentOutput({ taskId, runId: run.id, stage: "system", kind: "poll", message: "本轮只读行情与上轮一致，跳过模型请求并继续监测" });
      finishAgentRun(run.id, { status: "skipped", action: task.decision.action, route: "WAITING_FOR_CHANGE", code: "MARKET_UNCHANGED" });
      setNextPoll(task);
      persistTask(task);
      return { task, market, run, skipped: true, reason: "MARKET_UNCHANGED", route: "WAITING_FOR_CHANGE", analysisTriggered: false };
    }
    if (skipIfUnchanged && market.fingerprint && task.lastAnalyzedFingerprint === market.fingerprint && decisionExpired(task)) {
      appendAgentOutput({ taskId, runId: run.id, stage: "system", kind: "poll", message: "上一轮建议已过期，重新请求模型确认" });
    }
    applyFreshnessRules(task, market);
    let qualityIssues = marketQualityIssues(market);
    const automaticRuleFailures = failedAutomaticRules(task);

    logStage(task, run, "analyze", "读取本轮实盘数据并请求模型自主判断");
    const clientAnalysis = desktopBrowserRequired();
    const recentOnly = shouldUseRecentMonitoring(monitorRecentOnly, market);
    const analysisNowMs = Date.now();
    let analysisMarket = clientAnalysis ? null : (recentOnly
      ? buildRecentMonitoringMarket(compactCollectedMarket(task.market), analysisNowMs)
      : buildLayeredAnalysisMarket(compactCollectedMarket(task.market), analysisNowMs));
    if (analysisMarket) appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      kind: "coverage",
      message: recentOnly
        ? `空仓：走完的K作历史，预测下一根将在每分钟第50秒打印的K（45–50秒窗口）`
        : `持仓：分层K作历史，预测下一根将在每分钟第50秒打印的K（45–50秒窗口）`,
      data: { analysisLayers: analysisMarket.analysisLayers, nextCandle: analysisMarket.nextCandle || null },
    });
    const knowledgeLimit = Number(process.env.ANALYSIS_KNOWLEDGE_MAX_BYTES || DEFAULT_ANALYSIS_KNOWLEDGE_BYTES);
    const knowledge = approvedKnowledgeForAnalysis(state.skills, Number.isFinite(knowledgeLimit) && knowledgeLimit > 0 ? knowledgeLimit : DEFAULT_ANALYSIS_KNOWLEDGE_BYTES);
    const experiencePrompt = buildApprovedExperiencePrompt(knowledge, (Number.isFinite(knowledgeLimit) && knowledgeLimit > 0 ? knowledgeLimit : DEFAULT_ANALYSIS_KNOWLEDGE_BYTES) + 4096);
    const evidence = [
      { evidenceId: market.evidenceId, type: "market_snapshot", excerpt: `${market.symbol} ${market.timeframe} ${market.trend} · ${market.historyCount} 根主周期 K 线 · ${market.availableTimeframes?.length || 0} 个周期 · EMA20 ${market.indicators?.ema20} · RSI ${market.indicators?.rsi14}` },
      ...knowledge,
    ];
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      message: knowledge.length
        ? `本轮喂入共享知识库已审核的 ${knowledge.length} 条 Skill，与出K策略、K 线、各盘买卖档位一起分析`
        : "共享知识库没有已发布 Skill，本轮仅基于实时实盘数据和出K策略分析",
    });
    const resolvedProviderId = String(providerId || task.providerId || "");
    const provider = resolvedProviderId ? findProviderForUser(resolvedProviderId, resolvedUserId) : null;
    if (provider?.id) task.providerId = provider.id;
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      message: provider?.encryptedKey
        ? `使用 ${provider.name}（${provider.model}）请求结构化建议`
        : "未配置可用 Provider，将保持观望",
    });
    let decision;
    let providerSucceeded = true;
    let orderAssessmentSucceeded = false;
    let analysisCoverage = clientAnalysis ? { mode: "direct_client", complete: false, totalSegments: 1, reviewedSegments: 0, failedSegments: [] } : directAnalysisCoverage(analysisMarket);
    let segmentReviews = [];
    const analysisDeadlineMs = analysisTimeoutMs();
    modelStartedAt = Date.now();
    const analysisAbort = new AbortController();
    liveAnalyses.set(taskId, { market: structuredClone(market), generation, abort: analysisAbort });
    const analysisTimer = analysisDeadlineMs > 0
      ? setTimeout(() => analysisAbort.abort(analysisTimeoutError()), analysisDeadlineMs)
      : null;
    analysisTimer?.unref?.();
    const analysisOptions = analysisDeadlineMs > 0
      ? { timeoutMs: analysisDeadlineMs, signal: analysisAbort.signal, fastAnalysis: true }
      : { signal: analysisAbort.signal, fastAnalysis: true };
    try {
      assertCurrent();
      if (clientAnalysis) {
        const positionContext = updatePositionTracking(task, market, Date.now());
        appendAgentOutput({ taskId, runId: run.id, stage: "analyze", message: "客户端直接将各盘 K 线、买卖档位、出K策略和已审核 Skill 交给 AI 分析" });
        const result = await runtime.requestMarketAnalysis(provider, {
          marketRef: {
            sessionId: task.target.browserSessionId || `task:${task.id}`,
            fingerprint: task.market.fingerprint,
            observedAt: market.observedAt,
            freshnessSec: market.freshnessSec,
          },
          account: { ...task.metrics, ...(market.account || {}), positionContext },
          positions: positionContext,
          realtimeObservations: recentLiveObservations(task),
          rawPositions: market.account?.positions || [],
          rules: task.rules,
          executionPolicy: decisionExecutionPolicy(task),
          strategy: { ...LIVE_BOARD_STRATEGY, entryQuantity: entryQuantityForTask(task) },
          approvedSkills: approvedSkillsForContext(knowledge),
          evidence,
          experiencePrompt,
          evidenceIds: evidence.map((item) => item.evidenceId),
          previousAnalysis: previousAnalysisContext(task),
          conversation: { round: Number(task.monitoringRound || 0) + 1, trigger, recentRounds: recentAnalysisRounds(task.id) },
          monitoringWindow: recentOnly ? "last_1h" : "layered",
        }, analysisOptions);
        assertCurrent();
        decision = result.decision;
        analysisMarket = result.market;
        analysisCoverage = result.coverage;
        task.analysisCoverage = analysisCoverage;
        appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "coverage", message: `客户端已返回分析响应：${analysisCoverage.bookCount} 个盘、${analysisCoverage.totalKlineRows} 根 K 线、${knowledge.length} 条 Skill`, data: analysisCoverage });
      } else if (provider?.encryptedKey && shouldUseSegmentedAnalysis(analysisMarket)) {
        const segmented = await reviewAllMarketSegments({ task, run, provider, runtime, market: analysisMarket, evidence, assertCurrent, signal: analysisAbort.signal });
        assertCurrent();
        analysisCoverage = segmented.coverage;
        task.analysisCoverage = analysisCoverage;
        if (segmented.stopped) return stoppedRunResult(task, run, task.market);
        segmentReviews = segmented.reviews.filter(Boolean).map(compactSegmentReview);
        const coverageEvidenceId = `evidence:coverage:${String(market.fingerprint || "snapshot").slice(0, 24)}`;
        evidence.push({
          evidenceId: coverageEvidenceId,
          type: "market_coverage",
          excerpt: `分层覆盖 ${analysisCoverage.totalSegments} 个片段、${analysisCoverage.totalKlineRows} 根 K 线；完成 ${analysisCoverage.reviewedSegments} 个片段`,
          contentHash: String(market.fingerprint || ""),
        });
        for (const segment of segmented.segments) {
          const review = segmented.reviews[segment.segmentIndex];
          const failure = segmented.failures.find((item) => item.segmentId === segment.segmentId);
          evidence.push({
            evidenceId: `evidence:${segment.segmentId}`,
            type: review ? "market_segment_review" : "market_segment_failure",
            excerpt: review ? `${segmentLabel(segment)}：${review.summary}` : `${segmentLabel(segment)}：${failure?.code || "SEGMENT_REVIEW_FAILED"}`,
            segmentId: segment.segmentId,
            rowStart: segment.rowStart,
            rowEnd: segment.rowEnd,
            rowCount: segment.rowCount,
            contentHash: segment.contentHash,
          });
        }
        if (!analysisCoverage.complete) {
          decision = holdDecision("ANALYSIS_INCOMPLETE", "全量行情片段全部完成 AI 复核后重新决策");
          decision.evidenceIds = [coverageEvidenceId, ...segmentReviews.slice(0, 7).map((review) => `evidence:${review.segmentId}`)];
          providerSucceeded = false;
          appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "coverage", level: "error", message: `全量分析未完成：${analysisCoverage.failedSegments.length} 个片段失败；本轮不生成方向性决策，后台将重试`, data: { coverage: analysisCoverage } });
        } else {
          appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "coverage", message: "全部数据片段已完成 AI 复核，开始结合多轮上下文生成最终建议", data: { coverage: analysisCoverage } });
          const decisionContext = buildDecisionContext(task, market, evidence, trigger, analysisMarket);
          decision = await runtime.requestDecision(provider, {
            ...decisionContext,
            analysisMode: "hierarchical_full_coverage",
            market: summarizeMarketForDecision(analysisMarket, analysisCoverage),
            coverage: analysisCoverage,
            segmentReviews,
          }, analysisOptions);
          assertCurrent();
        }
      } else {
        task.analysisCoverage = analysisCoverage;
        appendAgentOutput({ taskId, runId: run.id, stage: "analyze", message: `直接分析 ${analysisMarket.books?.length || 1} 个盘的 K 线、盘口、出K策略和已审核 Skill`, data: { contextBytes: estimateMarketContextBytes(analysisMarket), knowledgeCount: knowledge.length } });
        decision = await runtime.requestDecision(provider, buildDecisionContext(task, market, evidence, trigger, analysisMarket), analysisOptions);
        assertCurrent();
      }
      if (analysisAbort.signal.aborted) throw analysisTimeoutError();
      orderAssessmentSucceeded = providerSucceeded && !["PROVIDER_NOT_CONFIGURED", "PROVIDER_NOT_READY", "PROVIDER_REQUEST_FAILED", "EMPTY_MODEL_RESPONSE", "INVALID_MODEL_JSON"].some((code) => (decision.riskFlags || []).includes(code));
      providerSucceeded = orderAssessmentSucceeded && !(decision.riskFlags || []).includes("ANALYSIS_INCOMPLETE");
    } catch (error) {
      if (error instanceof CycleAbortError) throw error;
      assertCurrent();
      const changedCode = analysisAbort.signal.reason?.message;
      if (["MARKET_CHANGED_DURING_ANALYSIS", "CANDLE_CHANGED_DURING_ANALYSIS", "POSITION_CHANGED_DURING_ANALYSIS", "LIVE_OBSERVATION_UNVERIFIED"].includes(changedCode)) {
        return abandonChangedAnalysis(task, run, market, changedCode);
      }
      if (isAnalysisTimeout(error) || analysisAbort.signal.aborted) return abandonTimedOutAnalysis(task, run, market);
      providerSucceeded = false;
      decision = {
        action: "HOLD",
        confidence: 0,
        profitProbability: 0,
        targetPositionPct: 0,
        maxOrderValuePct: 0,
        reasonCodes: [],
        evidenceIds: [market.evidenceId],
        invalidation: "模型请求失败后保持观望",
        riskFlags: ["PROVIDER_REQUEST_FAILED"],
        decisionTtlSec: 300,
      };
      appendAgentOutput({ taskId, runId: run.id, stage: "analyze", level: "error", message: `模型请求失败：${provider?.name || "Provider"} ${error.message}` });
    } finally {
      clearTimeout(analysisTimer);
      if (liveAnalyses.get(taskId)?.abort === analysisAbort) liveAnalyses.delete(taskId);
    }
    await positionExitRuns.get(taskId)?.catch(() => {});
    assertCurrent();
    actionPhaseLocks.add(taskId);
    analysisCoverage = { ...analysisCoverage, finalDecisionCompleted: providerSucceeded, complete: analysisCoverage.complete && providerSucceeded };
    task.analysisCoverage = analysisCoverage;
    decision = enforceProfitProbability(decision);
    if (isLiveTask(task)) {
      decision = { ...decision, exitPlans: [], ...((decision.exitType || decision.entryPurpose === "RESCUE" || decision.holdingPlan?.decision === "EXIT_NOW") ? { action: "HOLD", exitType: null, entryPurpose: "NORMAL", targetPositionIds: [],
        holdingPlan: { ...decision.holdingPlan, decision: "HOLD_FOR_TARGET", rationale: "离场由程序按持仓汇总执行" } } : {}) };
      task.exitPlans = [];
    }
    let exitMarket = market;
    // Recheck holdings and entry quotes after AI analysis. Summary exits run
    // independently; a HOLD never needs an AI exit plan to remain valid.
    const explicitExit = !isLiveTask(task) && (decision.exitType === "TAKE_PROFIT" || decision.exitType === "STOP_LOSS");
    const liveExitGuards = new Map();
    decision = applyEntryBoundary(bindDecisionToMarket(enforceDecisionLimits(attachPositionExit(decision, exitMarket)), exitMarket), exitMarket);
    if (explicitExit && decision.exitType) {
      const expiresAt = new Date(Date.parse(market.observedAt) + (decision.decisionTtlSec || 300) * 1000).toISOString();
      decision.exitGuard = { positions: pendingPositions(exitMarket, decision).map(position => liveExitGuards.get(position.positionOrderId) || ({
        positionId: position.positionOrderId, heldSide: heldDirection(position), quantity: Number(position.quantity),
        entryPrice: positionEntryPrice(position), expiresAt, triggerPrice: executableExitQuote(exitMarket, position)?.price,
        comparison: "EQ", exitType: decision.exitType,
      })) };
    }
    const targetBook = decisionTargetBook(decision, market);
    if (targetBook) qualityIssues = marketQualityIssues(targetBook);
    if (market.boardCoverage?.complete === false) qualityIssues = [...new Set([...qualityIssues, "BOARD_COVERAGE_INCOMPLETE"])];
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    const invalidEvidenceReference = (decision.evidenceIds || []).some((evidenceId) => !evidenceIds.has(evidenceId));
    decision.evidenceIds = (decision.evidenceIds || []).filter((evidenceId) => evidenceIds.has(evidenceId));
    if (invalidEvidenceReference) decision.riskFlags = [...(decision.riskFlags || []), "INVALID_EVIDENCE_REFERENCE"];
    if (qualityIssues.length) decision.riskFlags = [...new Set([...(decision.riskFlags || []), ...qualityIssues])];
    if (automaticRuleFailures.length) decision.riskFlags = [...new Set([...(decision.riskFlags || []), "AUTO_RULE_FAILED"])];
    task.lastAnalysisSucceeded = providerSucceeded;
    if (providerSucceeded && market.fingerprint) task.lastAnalyzedFingerprint = market.fingerprint;
    task.lastAnalysisAt = new Date().toISOString();
    task.monitoringRound = Number(task.monitoringRound || 0) + 1;
    task.decision = { ...decision, ...(cycleCancellation ? { orderCancellation: cycleCancellation } : {}), runId: run.id, observedAt: market.observedAt, analysisDurationMs: Date.now() - modelStartedAt, collectionDurationMs: modelStartedAt - cycleStartedAt, createdAt: new Date().toISOString(), ttlSec: decision.decisionTtlSec || 300 };
    const positionChangedDuringAnalysis = Number(task.exitExecutionRevision || 0) !== exitRevisionAtStart;
    const sessionChangedDuringAnalysis = Number(task.target.sessionRevision || 0) !== sessionRevision;
    if (!isLiveTask(task) && providerSucceeded && !positionChangedDuringAnalysis && !sessionChangedDuringAnalysis && !decisionExpired(task)) {
      const validated = validateExitPlans(decision, market, task);
      // Omission is not revocation. Keep only still-valid, unchanged AI plans
      // for positions omitted this round, with their original expiry intact.
      const suppliedIds = new Set((decision.exitPlans || []).map(p => String(p.positionId ?? p.position_id ?? "")));
      const retained = (task.exitPlans || []).filter(plan => !suppliedIds.has(plan.positionId)
        && ["ARMED", "TRIGGERED", "QUOTE_UNVERIFIED"].includes(evaluateExitPlan(plan, market).status));
      task.exitPlans = [...validated.plans, ...retained];
      task.decision.exitPlanRejections = validated.rejected;
    }
    task.decision.positionAudit = { observedAt: market.observedAt, positionsVerified: market.account?.positionsVerified === true, positions: updatePositionTracking(task, market), holdingPlan: decision.holdingPlan || null };
    appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "positions", message: market.account?.positionsVerified === true ? `持仓已核实：${openPositionCount(market)} 笔；离场由程序按持仓汇总监控` : "持仓尚未核实，禁止将缺失数据认定为空仓", data: task.decision.positionAudit });
    const modelFailure = (decision.modelDiagnostics?.attempts || [decision.modelDiagnostics]).find(item => item && item.jsonStatus !== "COMPLETE_JSON");
    if (modelFailure) task.lastModelFailure = {
      runId: run.id, providerId: provider?.id || task.providerId || "", createdAt: task.decision.createdAt,
      code: modelFailure.jsonStatus === "EMPTY_TEXT" ? "EMPTY_MODEL_RESPONSE" : "INVALID_MODEL_JSON",
      recovered: providerSucceeded, modelDiagnostics: decision.modelDiagnostics,
    };
    const decisionBoardLabel = decision.targetSymbolName || decision.targetSymbol || decision.targetInstrumentId || "";
    completeWorkflow(task, "analyze", providerSucceeded ? `${decisionBoardLabel ? `${decisionBoardLabel} · ` : ""}${decision.action} · ${Math.round((decision.confidence || 0) * 100)}%` : `模型分析未完成：${decision.invalidation}`);
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      kind: "decision",
      level: providerSucceeded ? "info" : "error",
      message: providerSucceeded ? `模型输出${decisionBoardLabel ? ` ${decisionBoardLabel}` : ""} ${decision.entryBlock?.requestedAction || decision.action}${decision.entryBlock ? `；入场拦截 ${decision.entryBlock.reason}，执行 HOLD` : ""}，置信度 ${Math.round((decision.confidence || 0) * 100)}%` : `模型分析未完成：${decision.invalidation}`,
      data: { action: decision.action, marketRegime: decision.marketRegime, entryBlock: decision.entryBlock, analysisSummary: decision.analysisSummary, forecastHorizon: decision.forecastHorizon, targetSymbol: decision.targetSymbol, targetSymbolName: decision.targetSymbolName, targetInstrumentId: decision.targetInstrumentId, reasonCodes: decision.reasonCodes, riskFlags: decision.riskFlags, boardAssessments: decision.boardAssessments || [], modelDiagnostics: decision.modelDiagnostics, observedAt: task.decision.observedAt, analysisDurationMs: task.decision.analysisDurationMs, collectionDurationMs: task.decision.collectionDurationMs },
    });

    logStage(task, run, "rules", "执行确定性规则与红线检查");
    task.status = "RISK_CHECK";
    const blocked = task.rules.some((rule) => rule.status === "pending" && rule.mode === "BLOCK");
    const reviewRequired = task.rules.some((rule) => rule.status === "pending" && rule.mode === "REVIEW");
    // Rule results remain visible evidence, but they do not replace the AI's directional decision.
    // LIVE entries follow the AI action with complete direction fields; exits target existing positions.
    const liveExecution = isLiveTask(task);
    const rulePaused = liveExecution ? false : blocked || reviewRequired || automaticRuleFailures.length > 0;
    let route = "SUGGESTION_PENDING";
    const decisionFlags = new Set(decision.riskFlags || []);
    const invalidEvidence = decisionFlags.has("INVALID_EVIDENCE_REFERENCE");
    const providerUnavailable = decisionFlags.has("PROVIDER_NOT_CONFIGURED") || decisionFlags.has("PROVIDER_REQUEST_FAILED");
    const riskLimitExceeded = decisionFlags.has("RISK_LIMIT_EXCEEDED");
    const holdRequired = decision.action === "HOLD" || (!liveExecution && (invalidEvidence || providerUnavailable || riskLimitExceeded || qualityIssues.length > 0));
    if (blocked || reviewRequired || automaticRuleFailures.length || holdRequired) {
      if (blocked && !liveExecution) decisionFlags.add("RED_LINE_TRIGGERED");
      if (reviewRequired && !liveExecution) decisionFlags.add("HUMAN_REVIEW_REQUIRED");
      if (automaticRuleFailures.length) decisionFlags.add("AUTO_RULE_FAILED");
      for (const issue of qualityIssues) decisionFlags.add(issue);
      task.decision.riskFlags = [...decisionFlags];
      task.status = "MONITORING";
      route = liveExecution ? (providerSucceeded ? (decision.action === "HOLD" ? "HOLD" : "SUGGESTION_PENDING") : "ANALYSIS_FAILED") : blocked ? "BLOCKED"
        : reviewRequired ? "REVIEW"
          : automaticRuleFailures.length ? "HOLD_RULE"
            : qualityIssues.length ? "HOLD_DATA_QUALITY"
              : riskLimitExceeded ? "RISK_BLOCKED"
                : invalidEvidence ? "HOLD_INVALID_EVIDENCE"
                  : providerUnavailable ? "HOLD_PROVIDER"
                    : "HOLD";
      const actionLabel = task.decision.action === "BUY" ? "买入" : task.decision.action === "SELL" ? pendingActionLabel(task.decision) : "观望";
      const targetedActionLabel = decisionBoardLabel ? `${decisionBoardLabel} ${actionLabel}` : actionLabel;
      const ruleMessage = blocked
        ? `${targetedActionLabel}建议已保留；规则标记已记录，继续按 AI 决策执行`
        : reviewRequired
          ? `${targetedActionLabel}建议已保留；复核标记已记录，继续按 AI 决策执行`
          : automaticRuleFailures.length
            ? `${targetedActionLabel}建议已保留；自动规则标记已记录，继续按 AI 决策执行`
            : task.decision.action === "HOLD"
              ? decisionFlags.has("RANGE_MARKET_NO_ENTRY") ? "旧版横盘限制已取消，重新评估短线机会"
                : decisionFlags.has("ENTRY_MARKET_REGIME_UNKNOWN") ? "目标盘口主情景未明确，不新开仓；继续监控并重新分析"
                  : "模型建议观望，当前轮次无需动作"
              : riskLimitExceeded
                ? `${targetedActionLabel}建议已保留；单笔入场数量使用配置值 ${entryQuantityForTask(task)}`
                : `${targetedActionLabel}建议已保留；数据标记已记录，继续按 AI 决策执行`;
      completeWorkflow(task, "rules", ruleMessage);
      appendAgentOutput({ taskId, runId: run.id, stage: "rules", message: ruleMessage });
    } else {
      completeWorkflow(task, "rules", isAutoTakeover(task)
        ? (isLiveTask(task) ? "规则通过，全自动接管将直接下单或离场" : "规则通过，全自动记录建议")
        : (isLiveTask(task) ? "规则通过，AI 填表后由用户点击入场；后续自动监控离场" : "规则通过，买卖意图转为建议"));
      appendAgentOutput({ taskId, runId: run.id, stage: "rules", message: isAutoTakeover(task)
        ? (isLiveTask(task) ? "规则通过；全自动接管，不再弹窗" : "规则通过；观察模式不会下单")
        : (isLiveTask(task) ? "规则通过；手动入场后程序自动确认、监控汇总离场" : "规则通过；观察模式不会自动下单") });
    }

    logStage(task, run, "action", isAutoTakeover(task)
      ? (isLiveTask(task) ? "路由 AI 入场决定，程序独立监控离场" : "路由 AI 动作，自动记录建议")
      : (isLiveTask(task) ? "准备入场表单，等待用户点击入场按钮" : "路由最终建议，等待确认后决定是否下单"));
    assertCurrent();
    task.decision = executableExitDecision(task, task.decision, exitMarket);
    const browserActionInProgress = pendingConfirmLocks.has(taskId);
    const duplicateExit = Boolean(task.decision.exitType) && task.decision.targetPositionIds.length === 0;
    const roundEntryBlock = isLiveTask(task) && !task.decision.exitType ? entryRoundBlock(task, task.market) : null;
    const executionBlocked = !liveExecution && (rulePaused || holdRequired);
    const accountUnverified = isLiveTask(task) && market.account?.positionsVerified === false;
    const staleDecision = decisionExpired(task);
    const canPromptOrder = !browserActionInProgress && providerSucceeded && !roundEntryBlock && !duplicateExit && !task.stopLocked && !executionBlocked && !accountUnverified && !staleDecision && !positionChangedDuringAnalysis && !sessionChangedDuringAnalysis && meetsOrderBoundary(task.decision);
    const execution = canPromptOrder
      ? await runtime.executeDecision(task, task.decision, connector)
      : {
        ok: true,
        skipped: true,
        reason: duplicateExit ? "EXIT_ALREADY_SUBMITTED" : task.decision.action === "HOLD" ? "HOLD" : rulePaused || holdRequired ? "RISK_GATE" : "BOUNDARY",
        route,
        code: roundEntryBlock || (sessionChangedDuringAnalysis ? "SESSION_CHANGED_DURING_ANALYSIS" : accountUnverified ? "POSITIONS_UNVERIFIED" : staleDecision ? "DECISION_EXPIRED" : positionChangedDuringAnalysis ? "POSITION_CHANGED_DURING_ANALYSIS" : duplicateExit ? "EXIT_ALREADY_SUBMITTED" : task.decision.action === "HOLD" ? "HOLD" : rulePaused || holdRequired ? "RISK_GATE_BLOCKED" : "INCOMPLETE_DIRECTIONAL_PROBABILITIES"),
      };
    assertCurrent();
    task.decision.riskFlags = [...new Set([...(task.decision.riskFlags || []), ...(execution.ok ? [] : [execution.code].filter(Boolean))])];
    if (canPromptOrder && !pendingConfirmLocks.has(taskId) && Number(task.exitExecutionRevision || 0) === exitRevisionAtStart) {
      await openPendingAction(task, { runtime, run, market: exitMarket });
    } else if (!pendingConfirmLocks.has(taskId) && !roundEntryBlock && !duplicateExit) {
      clearPendingAction(task, { persist: false });
    }
    if (execution.code === "SUGGESTION_PENDING" || execution.code === "TRADING_DISABLED") {
      task.status = task.stopLocked ? "MANUAL_CONTROL" : rulePaused ? "PAUSED" : "MONITORING";
      const waiting = task.pendingAction?.status === "WAITING";
      const submitted = ["CONFIRMED", "AWAITING_FILL", "UNVERIFIED"].includes(task.pendingAction?.status);
      const actionName = pendingActionLabel(task.pendingAction || task.decision);
      completeWorkflow(task, "action", waiting
        ? (isAutoTakeover(task) ? `${decisionBoardLabel} ${actionName} 自动执行中` : isLiveTask(task) ? `${decisionBoardLabel} ${actionName} 等待用户点击入场；后续自动监控离场` : `${decisionBoardLabel} ${actionName} 建议待确认`)
        : submitted && isAutoTakeover(task)
          ? `${decisionBoardLabel} ${actionName} 已自动执行，继续监控`
          : `${decisionBoardLabel ? `${decisionBoardLabel} ` : ""}${actionName} 建议已生成`);
        appendAgentOutput({ taskId, runId: run.id, stage: "action", kind: "suggestion", message: waiting
          ? (isAutoTakeover(task) ? `${decisionBoardLabel} ${actionName}自动执行中` : `${decisionBoardLabel} ${actionName}待用户在目标页提交`)
          : submitted && isAutoTakeover(task)
            ? `${decisionBoardLabel} ${actionName}已自动执行；继续监控持仓离场`
            : `${decisionBoardLabel ? `${decisionBoardLabel} ` : ""}${actionName}建议已生成`, data: { action: task.decision.action, exitType: task.decision.exitType || null, targetPositionIds: task.decision.targetPositionIds || [], targetSymbol: task.decision.targetSymbol, targetSymbolName: task.decision.targetSymbolName, targetInstrumentId: task.decision.targetInstrumentId, route, executionCode: execution.code, pendingActionId: task.pendingAction?.id || null } });
    } else if (!execution.ok) {
      task.status = "PAUSED";
      route = execution.route || "BLOCKED";
      completeWorkflow(task, "action", execution.message || execution.code);
      appendAgentOutput({ taskId, runId: run.id, stage: "action", level: "error", message: `动作未执行：${execution.message}`, data: { code: execution.code } });
    } else {
      task.status = task.stopLocked ? "MANUAL_CONTROL" : rulePaused ? "PAUSED" : "MONITORING";
      const actionMessage = execution.reason === "EXIT_ALREADY_SUBMITTED" ? "目标持仓已提交转让，继续核实持仓与委托"

          : execution.reason === "HOLD" ? "保持观望" : execution.reason === "RISK_GATE" ? "风险或数据规则未通过，禁止下单" : execution.reason === "BOUNDARY" ? "模型动作或方向证据不完整，未执行" : "已记录受控动作";
      const boundaryMessage = roundEntryBlock ? `本轮尚未结束（${roundEntryBlock}），继续核实持仓与委托`
        : task.decision.entryBlock?.reason === "LOW_PROFIT_PROBABILITY" ? "AI选定方向盈利概率不足45%，继续观察"
        : sessionChangedDuringAnalysis ? "分析期间登录已恢复，立即用新会话数据重新分析"
        : accountUnverified ? "持仓未核实，禁止下单" : staleDecision ? "AI结果已过期，重新分析"
        : positionChangedDuringAnalysis ? "分析期间持仓动作已执行，丢弃旧动作" : actionMessage;
      completeWorkflow(task, "action", boundaryMessage);
      appendAgentOutput({ taskId, runId: run.id, stage: "action", message: boundaryMessage });
    }
    const analysis = {
      id: run.id,
      taskId,
      round: task.monitoringRound,
      trigger,
      market: analysisMarket || compactCollectedMarket(task.market),
      evidence,
      decision: task.decision,
      coverage: analysisCoverage,
      segmentReviews,
      route,
      createdAt: new Date().toISOString(),
    };
    state.analyses.unshift(analysis);
    if (state.analyses.length > 20) state.analyses.length = 20;
    persistAnalysis(analysis);
    finishAgentRun(run.id, { status: providerSucceeded ? "completed" : "error", action: task.decision.action, route, code: providerSucceeded ? execution.code || route : decision.riskFlags.find((code) => ["PROVIDER_NOT_CONFIGURED", "PROVIDER_NOT_READY", "PROVIDER_REQUEST_FAILED", "EMPTY_MODEL_RESPONSE", "INVALID_MODEL_JSON", "ANALYSIS_INCOMPLETE"].includes(code)) || "ANALYSIS_INCOMPLETE" });
    if (monitoringIntent(task)) setNextPoll(task, pauseForPendingAction(task) ? DEFAULT_MONITOR_RETRY_MS : undefined);
      persistTask(task);
    return { task, market: task.market, evidence, execution, run, route, analysisTriggered: true };
  } catch (error) {
    if (error instanceof CycleAbortError) {
      return error.code === "STOP_LOCKED"
        ? stoppedRunResult(task, run, task.market)
        : invalidatedRunResult(taskId, run, task.market);
    }
    task.monitorFailureCount = Number(task.monitorFailureCount || 0) + 1;
    task.status = task.stopLocked ? "MANUAL_CONTROL" : "PAUSED";
    if (monitoringIntent(task)) setNextPoll(task, monitorRetryDelay(task));
    appendAgentOutput({ taskId, runId: run.id, stage: "system", level: "error", message: `分析异常：${error.message}` });
    finishAgentRun(run.id, { status: "error", code: error.message });
    addEvent("analysis_paused", `分析异常，已暂停自动动作：${error.message}`, { taskId, runId: run.id });
    persistTask(task);
    throw error;
  } finally {
    actionPhaseLocks.delete(taskId);
    activeCycles.delete(taskId);
    notifyCycleIdle(taskId);
    if (taskGeneration(task) === generation && !task.stopLocked) {
    task.updatedAt = new Date().toISOString();
    persistTask(task);
    }
  }
}

export async function runMonitoringCycle(taskId, { providerId = "", userId = "", runtime = {} } = {}) {
    const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (!monitoringIntent(task)) return { task, skipped: true, reason: "MONITORING_STOPPED" };
  if (pauseForPendingAction(task)) return { task, skipped: true, reason: "PENDING_USER_CONFIRM", analysisTriggered: false };
  const generation = taskGeneration(task);
    if (task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= Date.now()) {
      task.status = "PAUSED";
    task.decision = holdDecision("LEASE_EXPIRED", "监控租约已恢复，等待下一轮只读检查");
    addEvent("lease_expired", "任务租约曾过期，已锁定交易动作并恢复只读监控", { taskId });
  }
  renewLease(task);
  const result = await runAnalysis(taskId, providerId || task.providerId || "", {
    trigger: "controller",
    userId: userId || task.ownerUserId || "",
    skipIfUnchanged: true,
    monitorRecentOnly: true,
    runtime,
  });
  const current = getTask(taskId);
  if (!current || taskGeneration(current) !== generation || current.stopLocked) {
    return { ...result, task: current || task, market: result.market || current?.market || null };
  }
  if (result.skipped && result.reason === "CYCLE_IN_PROGRESS") {
    if (monitoringIntent(task)) setNextPoll(task, monitoringPollIntervalMs(task));
      persistTask(task);
    return { ...result, market: result.market || task.market || null, route: "CYCLE_IN_PROGRESS", analysisTriggered: false };
  }
  if (result.reason === "ANALYSIS_TIMEOUT") {
    persistTask(task);
    return result;
  }
  const failed = result.market?.ok !== true || result.task.lastAnalysisSucceeded === false || ["REAUTH_REQUIRED", "CONNECT_FAILED", "COLLECT_FAILED"].includes(result.route);
  task.monitorFailureCount = failed ? Math.max(1, Number(task.monitorFailureCount || 0)) : 0;
  if (monitoringIntent(task)) setNextPoll(task, failed ? monitorRetryDelay(task) : (pauseForPendingAction(task) ? DEFAULT_MONITOR_RETRY_MS : monitoringPollIntervalMs(task)));
  persistTask(task);
  return result;
}

function scheduleSummaryExitReviews(task, market, runtime, now = Date.now()) {
  const contexts = summaryExitReviewContexts(market, now).filter(context => context.reviewType === "STOP_LOSS");
  task.summaryExitReviews = (task.summaryExitReviews || []).filter(record => contexts.some(c => c.key === record.key
    && c.signature === record.signature && c.reviewType === record.reviewType));
  for (const [key, run] of summaryReviewRuns) {
    if (run.taskId === task.id && !contexts.some(c => c.key === run.key && c.signature === run.signature && c.reviewType === run.reviewType)) {
      run.abort.abort(new Error("SUMMARY_REVIEW_INVALIDATED"));
      summaryReviewRuns.delete(key);
    }
  }
  for (const context of contexts) {
    const key = `${task.id}:${context.key}`;
    if (summaryReviewRuns.has(key)) continue;
    const previous = task.summaryExitReviews.find(r => r.key === context.key);
    if (previous && Date.parse(previous.expiresAt) > now
      && (previous.decision === "EXIT" || previous.quotePrice === context.quote.price)) continue;
    if (previous?.status === "FAILED" && now - Date.parse(previous.requestedAt) < 5000) continue;
    const observedAt = new Date(context.quote.observedAt).toISOString();
    const record = { id: `exit-review:${task.id}:${context.key}:${now}`, key: context.key, signature: context.signature,
      reviewType: context.reviewType, quotePrice: context.quote.price, pnlPoints: context.pnlPoints,
      status: "REQUESTING", requestedAt: new Date(now).toISOString(), observedAt,
      expiresAt: new Date(Date.parse(observedAt) + SUMMARY_REVIEW_TTL_MS).toISOString() };
    task.summaryExitReviews = [...task.summaryExitReviews.filter(r => r.key !== context.key), record];
    const generation = taskGeneration(task), abort = new AbortController();
    const run = { taskId: task.id, key: context.key, signature: context.signature, reviewType: context.reviewType, abort };
    summaryReviewRuns.set(key, run);
    const current = () => !abort.signal.aborted && !task.stopLocked && monitoringIntent(task)
      && taskGeneration(task) === generation && task.summaryExitReviews.includes(record);
    const snapshot = positionMarketSnapshot(market, context.summary);
    const history = positionMarketSnapshot(task.market, context.summary);
    Promise.resolve().then(async () => {
      if (!current()) return;
      const provider = findProviderForUser(String(task.providerId || ""), String(task.ownerUserId || ""));
      const result = await runtime.requestSummaryExitDecision(provider, {
        observedAt, reviewType: context.reviewType, pnlPoints: context.pnlPoints, summary: context.summary,
        market: { observedAt: snapshot?.observedAt || market.observedAt, orderBook: snapshot?.orderBook || snapshot?.pageView?.orderBook,
          history: history?.history || [], historyObservedAt: history?.observedAt || null },
        previousReview: previous ? { decision: previous.decision, rationale: previous.rationale, pnlPoints: previous.pnlPoints, observedAt: previous.observedAt } : null,
      }, { signal: abort.signal, timeoutMs: 30000 });
      if (!current()) return;
      if (result?.ok !== true || !["EXIT", "HOLD"].includes(result.decision) || !String(result.rationale || "").trim()) throw new Error(result?.code || "INVALID_SUMMARY_EXIT_DECISION");
      if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("SUMMARY_EXIT_DECISION_EXPIRED");
      record.decision = result.decision;
      record.rationale = String(result.rationale);
      record.status = "REVIEWED";
      appendAgentOutput({ taskId: task.id, stage: "analyze", kind: "summary_exit_review",
        message: `${context.summary.symbolName || context.summary.symbol} ${context.pnlPoints}点：AI${result.decision === "EXIT" ? "决定离场" : "决定继续持仓"}；${record.rationale}`, data: record });
    }).catch(error => {
      if (!current()) return;
      record.status = "FAILED";
      record.code = error?.message || "SUMMARY_EXIT_REVIEW_FAILED";
      appendAgentOutput({ taskId: task.id, stage: "analyze", kind: "summary_exit_review", level: "error",
        message: `AI离场判断失败：${record.code}；保持持仓并继续请求判断` });
    }).finally(() => {
      if (summaryReviewRuns.get(key) === run) summaryReviewRuns.delete(key);
      if (current()) persistTask(task);
    });
  }
}

export function runPositionExitCycle(taskId, { runtime: runtimeOverrides = {}, now } = {}) {
  if (positionExitRuns.has(taskId)) return positionExitRuns.get(taskId);
  const exitAbort = new AbortController();
  const cancelExit = () => exitAbort.abort(new Error("EXIT_MONITOR_STOPPED"));
  positionExitCancels.set(taskId, cancelExit);
  const operation = Promise.resolve().then(async () => {
    const task = getTask(taskId);
    if (!task || !isLiveTask(task) || !monitoringIntent(task) || !task.target?.browserSessionId) return { skipped: true };
    const generation = taskGeneration(task);
    const assertCurrent = () => { exitAbort.signal.throwIfAborted(); assertCycleCurrent(task, generation); };
    const runtime = resolveRuntime(runtimeOverrides, { userId: task.ownerUserId || "", providerId: task.providerId || "" });
    const connector = getConnector(task.target.connectorId);
    const observationStartedAt = Date.now();
    const clockBase = now ?? observationStartedAt;
    const currentTime = () => clockBase + Date.now() - observationStartedAt;

    const waitingManualEntry = task.pendingAction?.status === "WAITING"
      && !task.pendingAction.exitType && task.autoDecisionEnabled !== true;
    const latestAccount = task.lastPositionAudit?.positionsVerified === true
      && new Date(task.lastPositionAudit.observedAt).getTime() >= new Date(task.market?.observedAt || 0).getTime()
      ? task.lastPositionAudit : task.market?.account;
    // A manual entry form is waiting for the user's one click. Do not switch
    // the browser to the holdings tab while no existing position needs exit
    // monitoring; the target page keeps its own live data updated.
    if (waitingManualEntry && latestAccount?.positionsVerified === true
      && !task.market?.account?.openOrders?.length && !unsettledActions(task).some(pending => pending.entrustedOrderIds?.length)
      && latestAccount.positionSummariesVerified === true && !latestAccount.positionSummaries?.some(position => Number(position.quantity) > 0)
      && Array.isArray(latestAccount.positions) && !latestAccount.positions.some(position => Number(position.quantity) > 0)) {
      return { skipped: true, reason: "MANUAL_ENTRY_WAITING" };
    }
    const observe = (accountScope) => observeWithLoginRecovery(task, connector, { id: null }, runtime,
      () => runtime.observeExecutionMarket(task, connector, { signal: exitAbort.signal, accountScope }), assertCurrent);
    let market = await observe("full");
    assertCurrent();
    task.exitObservationIndex = Number(task.exitObservationIndex || 0) + 1;
    if (!market?.ok) throw new Error(market?.code || "EXIT_OBSERVATION_FAILED");
    recordLiveObservation(task, market);
    reconcilePendingPosition(task, market);
    task.market = { ...task.market, account: market.account };
    task.lastPositionAudit = {
      observedAt: market.observedAt, positionsVerified: market.account?.positionsVerified === true,
      positionSummariesVerified: market.account?.positionSummariesVerified === true,
      positionSummaries: market.account?.positionSummaries || [],
      positions: (market.account?.positions || []).map(p => ({ positionId: p.positionOrderId, symbol: p.symbol, symbolName: p.symbolName, side: heldDirection(p), quantity: p.quantity, entryPrice: p.orderPrice, frozenQuantity: p.frozenQuantity })),
      openOrdersVerified: market.account?.openOrdersVerified === true,
      openOrderCount: market.account?.openOrdersVerified === true ? market.account.openOrders?.length || 0 : null,
      observationDurationMs: Date.now() - observationStartedAt,
    };
    scheduleSummaryExitReviews(task, market, runtime, currentTime());
    const cancellation = await cancelCurrentOrders(task, market, connector, { id: null }, runtime, assertCurrent, currentTime());
    if (cancellation) {
      market = await observe("full");
      assertCurrent();
      if (!market?.ok || market.account?.positionsVerified !== true || market.account?.openOrdersVerified !== true) {
        task.exitMonitor = { status: "CANCELLATION_UNVERIFIED", checkedAt: new Date().toISOString(), message: "撤单后持仓或委托尚未核实，继续检查当前委托与真实持仓" };
        persistTask(task);
        return { code: "CANCELLATION_UNVERIFIED" };
      }
      task.market = { ...task.market, account: market.account };
      reconcilePendingPosition(task, market);
    }
    const candidates = summaryExitCandidates(task, market, currentTime());
    const submitted = [];
    const failures = [];
    // A model action phase is safe to overlap: its snapshot is invalidated if
    // this exit changes the position. Only a browser write already in flight
    // owns the task action slot; let that write finish, then retry this exact
    // exit plan on the next fast cycle.
    if (pendingConfirmLocks.has(taskId)) {
      task.exitMonitor = {
        status: "ACTION_PHASE_WAITING",
        checkedAt: market.observedAt,
        message: "已完成持仓读取；当前动作提交结束后立即继续执行离场计划",
      };
      persistTask(task);
      return { submitted, deferred: true, reason: "ACTION_PHASE_WAITING" };
    }
    for (const candidate of candidates) {
      assertCurrent();
      if (!isTradingSwitchOn()) break;
      const decision = executableExitDecision(task, candidate.decision, market);
      if (!decision.targetSummary) continue;
      const key = summaryKey(candidate.summary);
      archivePendingSubmission(task);
      task.pendingAction = buildPendingAction({ ...task, market }, decision);
      try { await confirmPendingAction(taskId, { source: candidate.decision.exitType === "TAKE_PROFIT" ? "program_summary_profit" : "ai_summary_exit", runtime }); }
      catch (error) {
        assertCurrent();
        failures.push({ positionId: key, code: error.message });
        appendAgentOutput({ taskId, stage: "action", kind: "exit_monitor", level: "error", message: `持仓 ${key} 离场未完成：${error.message}；继续处理其他持仓并重试` });
        continue;
      }
      assertCurrent();
      if (["AWAITING_FILL", "UNVERIFIED"].includes(task.pendingAction?.status)) {
        task.exitExecutionRevision = Number(task.exitExecutionRevision || 0) + 1;

        submitted.push(key);
      } else if (task.pendingAction?.status === "REJECTED") {
        failures.push({ positionId: key, code: "TRADE_REJECTED", message: task.pendingAction.message });
      }
    }
    task.exitMonitor = { status: submitted.length ? "AWAITING_FILL"
      : market.account.positionSummariesVerified !== true ? "SUMMARY_UNVERIFIED"
      : (task.summaryExitReviews || []).some(r => r.status === "REQUESTING") ? "AI_REVIEWING" : "WATCHING",
      checkedAt: market.observedAt, message: market.account.positionSummariesVerified !== true
        ? "持仓汇总未核实，继续读取，不猜测离场"
        : "持仓汇总监控：盈利≥1点立即整行离场；亏损≤-2点由AI决定离场或持仓，清零后开始下一轮" };
    if (failures.length) task.exitMonitor = { ...task.exitMonitor, status: "ERROR", failures, message: `${failures.length}笔离场未完成；${task.exitMonitor.message}` };
    persistTask(task);
    return { submitted };
  }).finally(() => {
    if (positionExitRuns.get(taskId) === operation) positionExitRuns.delete(taskId);
    if (positionExitCancels.get(taskId) === cancelExit) positionExitCancels.delete(taskId);
  });
  positionExitRuns.set(taskId, operation);
  return operation;
}

function schedulePositionExit(taskId) {
  const entry = controllerLoops.get(taskId);
  if (!entry || entry.stopped || entry.exitTimer) return;
  entry.exitTimer = setTimeout(async () => {
    entry.exitTimer = null;
    if (controllerLoops.get(taskId) !== entry || entry.stopped) return;
    try { await runPositionExitCycle(taskId, { runtime: entry.runtime }); }
    catch (error) {
      const task = getTask(taskId);
      if (task && !task.stopLocked && taskGeneration(task) === entry.generation) {
        task.exitMonitor = { status: "ERROR", checkedAt: new Date().toISOString(), message: error.message };
        if (entry.lastExitError !== error.message) appendAgentOutput({ taskId, stage: "action", kind: "exit_monitor", level: "error", message: `离场监控未完成：${error.message}` });
        entry.lastExitError = error.message;
        persistTask(task);
      }
    } finally { if (controllerLoops.get(taskId) === entry && !entry.stopped) schedulePositionExit(taskId); }
  }, 2000);
  entry.exitTimer.unref?.();
}

function scheduleController(taskId, delayMs) {
  const entry = controllerLoops.get(taskId);
  if (!entry || entry.stopped || entry.timer || entry.running) return;
  const task = getTask(taskId);
  if (!monitoringIntent(task)) {
      stopController(taskId);
      return;
    }
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    if (entry.stopped || controllerLoops.get(taskId) !== entry) return;
    const scheduledTask = getTask(taskId);
    if (!scheduledTask || taskGeneration(scheduledTask) !== entry.generation || scheduledTask.stopLocked) {
      stopController(taskId);
      return;
    }
    entry.running = true;
    try {
      await entry.runCycle(taskId);
    } catch (error) {
      const current = getTask(taskId);
      if (current && taskGeneration(current) === entry.generation && monitoringIntent(current)) {
        current.monitorFailureCount = Number(current.monitorFailureCount || 0) + 1;
        current.status = "PAUSED";
        setNextPoll(current, monitorRetryDelay(current));
        addEvent("analysis_retry_scheduled", `本轮失败，将继续重试：${error?.message || "未知错误"}`, { taskId, failureCount: current.monitorFailureCount });
        persistTask(current);
      }
    } finally {
      entry.running = false;
      if (controllerLoops.get(taskId) !== entry || entry.stopped) return;
      const current = getTask(taskId);
      if (!current || taskGeneration(current) !== entry.generation || !monitoringIntent(current)) {
        stopController(taskId);
        return;
      }
      if (pauseForPendingAction(current)) return;
      const nextPollAt = new Date(current.nextPollAt || "").getTime();
      const fallbackDelay = monitoringPollIntervalMs(current);
      scheduleController(taskId, Number.isFinite(nextPollAt) ? Math.max(0, nextPollAt - Date.now()) : fallbackDelay);
    }
  }, Math.max(0, Number(delayMs) || 0));
}

export function startController(taskId, options = {}) {
  if (controllerLoops.has(taskId)) return;
  const task = getTask(taskId);
  if (!monitoringIntent(task)) return;
  const userId = options.userId || task.ownerUserId || "";
  const runCycle = typeof options.runCycle === "function"
    ? options.runCycle
    : (id) => runMonitoringCycle(id, { providerId: options.providerId, userId, runtime: options.runtime });
  const entry = { timer: null, exitTimer: null, runtime: options.runtime, running: false, stopped: false, generation: taskGeneration(task), runCycle };
  controllerLoops.set(taskId, entry);
  const persistedNextPoll = new Date(task.nextPollAt || "").getTime();
  scheduleController(taskId, Number.isFinite(persistedNextPoll) ? Math.max(0, persistedNextPoll - Date.now()) : 0);
  schedulePositionExit(taskId);
}

export function stopController(taskId) {
  for (const [key, run] of summaryReviewRuns) {
    if (run.taskId !== taskId) continue;
    run.abort.abort(new Error("SUMMARY_REVIEW_STOPPED"));
    summaryReviewRuns.delete(key);
  }
  liveAnalyses.get(taskId)?.abort.abort(new CycleAbortError("CYCLE_INVALIDATED"));
  liveObservations.delete(taskId);
  positionExitCancels.get(taskId)?.();
  pendingSubmissionCancels.get(taskId)?.();
  const entry = controllerLoops.get(taskId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.exitTimer) clearTimeout(entry.exitTimer);
  entry.timer = null;
  controllerLoops.delete(taskId);
}

export function stopAllControllers() {
  for (const taskId of new Set([...controllerLoops.keys(), ...positionExitCancels.keys(), ...pendingSubmissionCancels.keys(),
    ...[...summaryReviewRuns.values()].map(run => run.taskId)])) stopController(taskId);
}
