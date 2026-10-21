import { executableExitQuote, exitNetPnl, heldDirection, isNonLosingExit, positionEntryPrice } from "./exit-policy.mjs";

const identity = item => [item?.symbol, item?.symbolName, item?.instrumentId].filter(Boolean).map(String);

export const RESCUE_LOSS_POINTS = 3;

export function isAutomaticRescue(decision) {
  return decision?.entryPurpose === "RESCUE" && !decision.exitType
    && decision.rescueTrigger?.type === "LOSS_POINTS" && decision.rescueTrigger.threshold === RESCUE_LOSS_POINTS;
}

export function rescueTriggerAllowsQuote(trigger, price) {
  if (trigger?.type !== "LOSS_POINTS" || trigger.threshold !== RESCUE_LOSS_POINTS
    || !["LONG", "SHORT"].includes(trigger.heldSide) || !(trigger.entryPrice > 0) || !(price > 0)) return false;
  const loss = (trigger.entryPrice - price) * (trigger.heldSide === "LONG" ? 1 : -1);
  return loss >= RESCUE_LOSS_POINTS && (trigger.previousLossPoints == null || loss > trigger.previousLossPoints);
}

export function activeRescuePositionIds(task) {
  return new Set(["ACTIVE", "EXITING"].includes(task.rescueSession?.status)
    ? [...(task.rescueSession.originalPositionIds || []), ...(task.rescueSession.rescuePositionIds || [])] : []);
}

export function rescueProtectedPositionIds(task, market, now = Date.now()) {
  const ids = new Set([...(task.rescueSession?.status === "ACTIVE" ? task.rescueSession.originalPositionIds || [] : []),
    ...[task.pendingAction, ...(task.unsettledActions || [])].filter(p => p?.entryPurpose === "RESCUE"
      && ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status)).flatMap(p => p.rescuePositionIds || [])]);
  for (const p of market?.account?.positions || []) {
    if (task.rescueSession?.rescuePositionIds?.includes(p.positionOrderId)) continue;
    const quote = executableExitQuote(market, p, now);
    const pnl = quote && exitNetPnl(p, quote.price);
    if (pnl && -pnl.grossPnl / pnl.quantity >= RESCUE_LOSS_POINTS) ids.add(p.positionOrderId);
  }
  return ids;
}

export function automaticRescueCandidates(task, market, now = Date.now()) {
  if (market?.account?.positionsVerified !== true || task.rescueSession?.status === "EXITING") return [];
  const outstanding = [task.pendingAction, ...(task.unsettledActions || [])].filter(Boolean);
  const rescueLegs = new Set(task.rescueSession?.rescuePositionIds || []);
  const candidates = [];
  for (const position of market.account.positions || []) {
    if (!position.positionOrderId || rescueLegs.has(position.positionOrderId) || !(Number(position.quantity) > 0)) continue;
    // Pending opposite fills must not become new originals before reconciliation.
    if (outstanding.some(p => p.entryPurpose === "RESCUE" && !["REJECTED", "CANCELLED"].includes(p.status)
      && p.baselinePositionsVerified && identity(position).some(v => identity({ symbol: p.targetSymbol, instrumentId: p.targetInstrumentId, symbolName: p.targetSymbolName }).includes(v))
      && heldDirection(position) === (p.action === "BUY" ? "LONG" : "SHORT")
      && Number(position.quantity) > Number(p.baselinePositions?.[position.positionOrderId] || 0))) continue;
    if (outstanding.some(p => p.exitType && ["SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status)
      && p.targetPositionIds?.includes(position.positionOrderId))) continue;
    const quote = executableExitQuote(market, position, now);
    const pnl = quote && exitNetPnl(position, quote.price);
    const lossPoints = pnl ? -pnl.grossPnl / pnl.quantity : null;
    if (lossPoints === null || lossPoints < RESCUE_LOSS_POINTS) continue;
    const decision = { action: heldDirection(position) === "LONG" ? "SELL" : "BUY", orderType: "MARKET",
      targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      entryPurpose: "RESCUE", rescuePositionIds: [position.positionOrderId],
      rescueTrigger: { type: "LOSS_POINTS", threshold: RESCUE_LOSS_POINTS, price: quote.price, lossPoints,
        positionId: position.positionOrderId, heldSide: heldDirection(position), entryPrice: pnl.entryPrice,
        previousLossPoints: task.rescueSession?.status === "ACTIVE" ? task.rescueSession.lastRescueByPosition?.[position.positionOrderId]?.lossPoints ?? null : null,
        observedAt: new Date(quote.observedAt).toISOString() } };
    const retry = outstanding.find(p => isAutomaticRescue(p) && p.status === "WAITING"
      && p.rescuePositionIds?.length === 1 && p.rescuePositionIds[0] === position.positionOrderId);
    try {
      validateRescueEntry(task, rescueEntryIntent(decision, market, now), retry?.id);
      candidates.push({ position, decision, replacePendingId: retry?.id });
    } catch (error) {
      if (!["RESCUE_ALREADY_PENDING", "RESCUE_LOSS_NOT_EXPANDED"].includes(error.message)) throw error;
    }
  }
  return candidates.sort((a, b) => b.decision.rescueTrigger.lossPoints - a.decision.rescueTrigger.lossPoints);
}

export function rescueEntryIntent(decision, market, now = Date.now()) {
  if (decision.entryPurpose !== "RESCUE") return { entryPurpose: "NORMAL", rescuePositionIds: [] };
  const ids = [...new Set((decision.rescuePositionIds || []).map(String))];
  const targets = identity({ symbol: decision.targetSymbol, symbolName: decision.targetSymbolName, instrumentId: decision.targetInstrumentId });
  const valid = !decision.exitType && ["BUY", "SELL"].includes(decision.action) && ids.length
    && market?.account?.positionsVerified === true && ids.every(id => {
      const position = market.account.positions.find(item => item.positionOrderId === id);
      const quote = position && executableExitQuote(market, position, now);
      const pnl = quote && exitNetPnl(position, quote.price);
      return position && identity(position).some(value => targets.includes(value))
        && heldDirection(position) === (decision.action === "BUY" ? "SHORT" : "LONG")
        && pnl && (pnl.netPnl ?? pnl.grossPnl) < 0;
    });
  if (!valid) throw new Error("INVALID_RESCUE_TARGET");
  const rescueLossReferences = Object.fromEntries(ids.map(id => {
    const position = market.account.positions.find(item => item.positionOrderId === id);
    const quote = executableExitQuote(market, position, now);
    const pnl = exitNetPnl(position, quote.price);
    return [id, { lossPoints: -pnl.grossPnl / pnl.quantity, entryPrice: pnl.entryPrice, heldSide: heldDirection(position), observedAt: new Date(quote.observedAt).toISOString() }];
  }));
  return { entryPurpose: "RESCUE", rescuePositionIds: ids, rescueLossReferences };
}

export function validateRescueEntry(task, intent, pendingId) {
  if (task.rescueSession?.status === "EXITING") throw new Error("RESCUE_EXIT_IN_PROGRESS");
  if (intent.entryPurpose !== "RESCUE") return;
  const outstanding = [task.pendingAction, ...(task.unsettledActions || [])];
  if (outstanding.some(p => p && p.id !== pendingId && ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status)
    && p.entryPurpose === "RESCUE" && intent.rescuePositionIds.some(id => p.rescuePositionIds?.includes(id))))
    throw new Error("RESCUE_ALREADY_PENDING");
  if (task.rescueSession?.status !== "ACTIVE") return;
  for (const id of intent.rescuePositionIds) {
    if (!task.rescueSession.originalPositionIds.includes(id)) continue;
    const previous = task.rescueSession.lastRescueByPosition?.[id];
    const current = intent.rescueLossReferences[id];
    if (!previous || previous.entryPrice !== current.entryPrice || previous.heldSide !== current.heldSide
      || !(current.lossPoints > previous.lossPoints)) throw new Error("RESCUE_LOSS_NOT_EXPANDED");
  }
}

export function observeRescueFill(task, market, pending) {
  if (pending?.entryPurpose !== "RESCUE" || pending.exitType || !pending.rescuePositionIds?.length
    || !["WAITING", "AWAITING_FILL", "UNVERIFIED"].includes(pending.status)
    || (!pending.source && !(pending.formFilled && pending.entrustedOrderIds?.length))
    || pending.baselinePositionsVerified !== true || !pending.baselinePositions
    || market.account?.positionsVerified !== true) return;
  const positions = market.account.positions || [];
  if (!pending.rescuePositionIds.every(id => positions.some(p => p.positionOrderId === id
    && Number(p.quantity) > 0 && heldDirection(p) === (pending.action === "BUY" ? "SHORT" : "LONG")))) return;
  const targets = [pending.targetSymbol, pending.targetSymbolName, pending.targetInstrumentId].filter(Boolean);
  // An unrelated same-direction submission can also grow holdings. Ambiguous
  // deltas must not switch an ordinary account into recovery liquidation.
  if ([task.pendingAction, ...(task.unsettledActions || [])].some(other => other && other.id !== pending.id && !other.exitType
    && ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(other.status) && other.action === pending.action
    && identity({ symbol: other.targetSymbol, symbolName: other.targetSymbolName, instrumentId: other.targetInstrumentId }).some(value => targets.includes(value)))) return;
  const added = positions.filter(p => p.positionOrderId && identity(p).some(value => targets.includes(value))
    && heldDirection(p) === (pending.action === "BUY" ? "LONG" : "SHORT")
    && Number(p.quantity) > Number(pending.baselinePositions[p.positionOrderId] || 0));
  if (!added.length) return;
  const previous = ["ACTIVE", "EXITING"].includes(task.rescueSession?.status) ? task.rescueSession : null;
  task.rescueSession = {
    ...previous, status: previous?.status || "ACTIVE", startedAt: previous?.startedAt || market.observedAt,
    originalPositionIds: [...new Set([...(previous?.originalPositionIds || []), ...pending.rescuePositionIds])],
    rescuePositionIds: [...new Set([...(previous?.rescuePositionIds || []), ...added.map(p => p.positionOrderId)])],
    lastRescueByPosition: { ...previous?.lastRescueByPosition, ...pending.rescueLossReferences },
  };
}

export function rescueExitCandidates(task, market, now = Date.now()) {
  const session = task.rescueSession;
  if (!["ACTIVE", "EXITING"].includes(session?.status)) return [];
  if (market.account?.positionsVerified !== true) { session.netPnl = null; return []; }
  const positions = (market.account.positions || []).filter(p => Number(p.quantity) > 0);
  const unresolvedEntry = [task.pendingAction, ...(task.unsettledActions || [])].some(p => p && !p.exitType
    && ["SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status));
  const relatedIds = [...session.originalPositionIds, ...session.rescuePositionIds];
  if (session.status === "ACTIVE" && !positions.some(p => relatedIds.includes(p.positionOrderId))
    && !unresolvedEntry && market.account.openOrdersVerified === true && !market.account.openOrders?.length) {
    session.status = "COMPLETE";
    session.completedAt = new Date(now).toISOString();
    return [];
  }
  if (!positions.length) {
    if (market.account.openOrdersVerified === true && !market.account.openOrders?.length && !unresolvedEntry) {
      session.status = "COMPLETE";
      session.completedAt = new Date(now).toISOString();
    }
    return [];
  }
  const priced = positions.map(position => {
    const quote = executableExitQuote(market, position, now);
    const pnl = quote && exitNetPnl(position, quote.price);
    return { position, quote, pnl };
  });
  const netKnown = priced.every(({ position, quote, pnl }) => {
    const sameBookQuantity = priced.filter(item => heldDirection(item.position) === heldDirection(position)
      && identity(item.position).some(value => identity(position).includes(value))).reduce((sum, item) => sum + Number(item.position.quantity), 0);
    return quote && quote.volume >= sameBookQuantity && pnl?.netPnl != null;
  });
  const net = netKnown ? priced.reduce((sum, item) => sum + item.pnl.netPnl, 0) : null;
  const roundingError = netKnown ? Number.EPSILON * priced.reduce((sum, item) => sum
    + (item.pnl.entryPrice + item.pnl.exitPrice) * item.pnl.quantity + item.pnl.fees, 0) * 4 : 0;
  session.netPnl = netKnown && Math.abs(net) <= roundingError ? 0 : net;
  session.checkedAt = market.observedAt;
  if (session.status === "ACTIVE") {
    if (!netKnown || session.netPnl < 0) return [];
    session.status = "EXITING";
    session.triggerNetPnl = session.netPnl;
  }
  // Once whole-account recovery triggers, finish every leg even when the
  // profitable leg fills first and the remaining open PnL becomes negative.
  return priced.flatMap(({ position, quote }) => {
    if (!quote || Number(position.frozenQuantity || 0) > 0) return [];
    const side = heldDirection(position);
    if (!["LONG", "SHORT"].includes(side) || !position.positionOrderId) return [];
    const exitType = isNonLosingExit(position, quote.price) ? "TAKE_PROFIT" : "STOP_LOSS";
    return [{ position, decision: { action: side === "LONG" ? "SELL" : "BUY", orderType: "MARKET", exitType,
      targetPositionIds: [position.positionOrderId], targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      exitGuard: { positionId: position.positionOrderId, heldSide: side, quantity: Number(position.quantity),
        entryPrice: positionEntryPrice(position), exitType, expiresAt: new Date(now + 10000).toISOString(),
        triggerPrice: quote.price, comparison: side === "LONG" ? "GTE" : "LTE", rescueRecovery: true } } }];
  });
}
