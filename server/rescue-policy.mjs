import { executableExitQuote, exitNetPnl, heldDirection, isNonLosingExit, positionEntryPrice } from "./exit-policy.mjs";

const identity = item => [item?.symbol, item?.symbolName, item?.instrumentId].filter(Boolean).map(String);

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
