import { executableExitQuote, exitNetPnl, heldDirection, isNonLosingExit, positionEntryPrice } from "./exit-policy.mjs";

const identity = item => [item?.symbol, item?.symbolName, item?.instrumentId].filter(Boolean).map(String);

export const RESCUE_LOSS_POINTS = 3;
export const RESCUE_ORDERS_PER_ORIGINAL = 2;

const liveSession = task => ["ACTIVE", "EXITING"].includes(task.rescueSession?.status) ? task.rescueSession : null;
const groupIds = group => [...(group.originalPositionIds || []), ...(group.rescuePositionIds || [])];

// Old sessions have no reliable order-to-original mapping. Keep their known
// participants together, without adding unrelated holdings or guessing orders.
function rescueGroups(task) {
  const session = liveSession(task);
  if (!session) return [];
  session.groups ||= [{ id: "legacy", status: session.status, legacy: true,
    originalPositionIds: session.originalPositionIds || [], rescuePositionIds: session.rescuePositionIds || [], rescueOrders: [] }];
  return session.groups;
}

const groupForOriginal = (task, id) => rescueGroups(task).find(g => g.originalPositionIds.includes(id));
const needsSecondRescue = group => group?.status === "ACTIVE" && !group.legacy && group.rescueOrders.length === 1;

const pendingRescues = task => [task.pendingAction, ...(task.unsettledActions || [])].filter(p => p
  && !p.exitType && p.entryPurpose === "RESCUE"
  && (["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status) || p.cancellationAwaitingAudit));

export function rescueEntryLocked(task) {
  return ["ACTIVE", "EXITING"].includes(task.rescueSession?.status) || pendingRescues(task).length > 0;
}

export function rescueBatchPositionIds(task, market) {
  return (task.rescueSession?.status === "ACTIVE" ? task.rescueSession.batchOriginalPositionIds : null)
    || pendingRescues(task)[0]?.rescueBatchPositionIds
    || (market.account?.positions || []).filter(p => p.positionOrderId && Number(p.quantity) > 0).map(p => p.positionOrderId);
}

export function observeStartupRescue(task, market) {
  if (task.rescueStartupScanned || market.account?.positionsVerified !== true) return;
  task.rescueStartupScanned = true;
  if (rescueEntryLocked(task)) return;
  const positions = (market.account.positions || []).filter(p => p.positionOrderId && Number(p.quantity) > 0);
  const paired = positions.filter(p => ["LONG", "SHORT"].includes(heldDirection(p))
    && positions.some(other => heldDirection(other) === (heldDirection(p) === "LONG" ? "SHORT" : "LONG")
      && identity(p).some(value => identity(other).includes(value))));
  if (!paired.length) return;
  const groups = [];
  for (const p of paired) {
    if (groups.some(g => groupIds(g).includes(p.positionOrderId))) continue;
    const participants = paired.filter(other => identity(p).some(value => identity(other).includes(value)));
    groups.push({ id: `startup:${p.positionOrderId}`, status: "ACTIVE", legacy: true,
      originalPositionIds: participants.filter(p => heldDirection(p) === "LONG").map(p => p.positionOrderId),
      rescuePositionIds: participants.filter(p => heldDirection(p) === "SHORT").map(p => p.positionOrderId), rescueOrders: [] });
  }
  task.rescueSession = { status: "ACTIVE", startedAt: market.observedAt, source: "startup_positions", groups,
    originalPositionIds: paired.filter(p => heldDirection(p) === "LONG").map(p => p.positionOrderId),
    rescuePositionIds: paired.filter(p => heldDirection(p) === "SHORT").map(p => p.positionOrderId),
    batchOriginalPositionIds: [], lastRescueByPosition: {} };
}

export function isAutomaticRescue(decision) {
  return decision?.entryPurpose === "RESCUE" && !decision.exitType
    && decision.rescueTrigger?.type === "LOSS_POINTS" && decision.rescueTrigger.threshold === RESCUE_LOSS_POINTS;
}

export function rescueTriggerAllowsQuote(trigger, price) {
  if (trigger?.type !== "LOSS_POINTS" || trigger.threshold !== RESCUE_LOSS_POINTS
    || !["LONG", "SHORT"].includes(trigger.heldSide) || !(trigger.entryPrice > 0) || !(price > 0)) return false;
  const loss = (trigger.entryPrice - price) * (trigger.heldSide === "LONG" ? 1 : -1);
  // The first verified rescue commits this group to two rescue orders. Its
  // second leg does not wait for a fresh loss expansion or another 3-point hit.
  if (trigger.completesRescueGroup === true && trigger.rescueOrderNumber === 2) return true;
  return loss >= RESCUE_LOSS_POINTS && (trigger.previousLossPoints == null || loss > trigger.previousLossPoints);
}

export function activeRescuePositionIds(task) {
  return new Set([...rescueGroups(task).filter(g => g.status !== "COMPLETE").flatMap(groupIds),
    ...pendingRescues(task).flatMap(p => p.rescuePositionIds || [])]);
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
    const group = groupForOriginal(task, position.positionOrderId);
    const completing = needsSecondRescue(group);
    const quote = executableExitQuote(market, position, now);
    const pnl = quote && exitNetPnl(position, quote.price);
    const lossPoints = pnl ? -pnl.grossPnl / pnl.quantity : null;
    if (lossPoints === null || (!completing && lossPoints < RESCUE_LOSS_POINTS)) continue;
    const decision = { action: heldDirection(position) === "LONG" ? "SELL" : "BUY", orderType: "MARKET",
      targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      entryPurpose: "RESCUE", rescuePositionIds: [position.positionOrderId],
      rescueTrigger: { type: "LOSS_POINTS", threshold: RESCUE_LOSS_POINTS, price: quote.price, lossPoints,
        positionId: position.positionOrderId, heldSide: heldDirection(position), entryPrice: pnl.entryPrice,
        previousLossPoints: null, completesRescueGroup: completing,
        rescueOrderNumber: (group?.rescueOrders.length || 0) + 1,
        observedAt: new Date(quote.observedAt).toISOString() } };
    const retry = outstanding.find(p => isAutomaticRescue(p) && p.status === "WAITING"
      && p.rescuePositionIds?.length === 1 && p.rescuePositionIds[0] === position.positionOrderId);
    try {
      validateRescueEntry(task, rescueEntryIntent(decision, market, now, task), retry?.id);
      candidates.push({ position, decision, replacePendingId: retry?.id });
    } catch (error) {
      if (!["RESCUE_ALREADY_PENDING", "RESCUE_ENTRY_LOCKED"].includes(error.message)) throw error;
    }
  }
  return candidates.sort((a, b) => Number(b.decision.rescueTrigger.completesRescueGroup) - Number(a.decision.rescueTrigger.completesRescueGroup)
    || b.decision.rescueTrigger.lossPoints - a.decision.rescueTrigger.lossPoints);
}

export function rescueEntryIntent(decision, market, now = Date.now(), task = {}) {
  if (decision.entryPurpose !== "RESCUE") return { entryPurpose: "NORMAL", rescuePositionIds: [] };
  const ids = [...new Set((decision.rescuePositionIds || []).map(String))];
  const targets = identity({ symbol: decision.targetSymbol, symbolName: decision.targetSymbolName, instrumentId: decision.targetInstrumentId });
  const completing = ids.length === 1 && needsSecondRescue(groupForOriginal(task, ids[0]));
  const valid = !decision.exitType && ["BUY", "SELL"].includes(decision.action) && ids.length === 1
    && market?.account?.positionsVerified === true && ids.every(id => {
      const position = market.account.positions.find(item => item.positionOrderId === id);
      const quote = position && executableExitQuote(market, position, now);
      const pnl = quote && exitNetPnl(position, quote.price);
      return position && identity(position).some(value => targets.includes(value))
        && heldDirection(position) === (decision.action === "BUY" ? "SHORT" : "LONG")
        && pnl && (completing || (pnl.netPnl ?? pnl.grossPnl) < 0);
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
  if (intent.entryPurpose !== "RESCUE") {
    if (rescueEntryLocked(task)) throw new Error("RESCUE_ENTRY_LOCKED");
    return;
  }
  if (pendingRescues(task).some(p => p.id !== pendingId))
    throw new Error("RESCUE_ALREADY_PENDING");
  const session = task.rescueSession;
  const batch = session?.status === "ACTIVE" ? session.batchOriginalPositionIds || []
    : pendingRescues(task).find(p => p.id !== pendingId)?.rescueBatchPositionIds;
  if (intent.rescuePositionIds?.length !== 1) throw new Error("INVALID_RESCUE_TARGET");
  if (intent.rescuePositionIds.some(id => {
    const group = groupForOriginal(task, id);
    return (batch && !batch.includes(id)) || (group && !needsSecondRescue(group))
      || session?.rescuePositionIds?.includes(id);
  })) throw new Error("RESCUE_ENTRY_LOCKED");
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
  const groups = previous ? rescueGroups(task) : [];
  if (added.some(p => groups.some(g => !g.originalPositionIds.includes(pending.rescuePositionIds[0])
    && groupIds(g).includes(p.positionOrderId)))) return;
  let group = groups.find(g => g.originalPositionIds.includes(pending.rescuePositionIds[0]));
  if (!group) {
    group = { id: `rescue:${pending.id}`, status: "ACTIVE", originalPositionIds: [...pending.rescuePositionIds],
      rescuePositionIds: [], rescueOrders: [], ...(pending.rescuePositionIds.length !== 1 ? { legacy: true } : {}) };
    groups.push(group);
  }
  const order = group.rescueOrders.find(o => o.pendingId === pending.id);
  if (!order && group.rescueOrders.length >= RESCUE_ORDERS_PER_ORIGINAL) return;
  if (order) order.positionIds = [...new Set([...order.positionIds, ...added.map(p => p.positionOrderId)])];
  else group.rescueOrders.push({ pendingId: pending.id, positionIds: added.map(p => p.positionOrderId) });
  group.rescuePositionIds = [...new Set([...group.rescuePositionIds, ...added.map(p => p.positionOrderId)])];
  task.rescueSession = {
    ...previous, groups, status: previous?.status || "ACTIVE", startedAt: previous?.startedAt || market.observedAt,
    originalPositionIds: [...new Set([...(previous?.originalPositionIds || []), ...pending.rescuePositionIds])],
    rescuePositionIds: [...new Set([...(previous?.rescuePositionIds || []), ...added.map(p => p.positionOrderId)])],
    batchOriginalPositionIds: previous?.batchOriginalPositionIds || pending.rescueBatchPositionIds || pending.rescuePositionIds,
    lastRescueByPosition: { ...previous?.lastRescueByPosition, ...pending.rescueLossReferences },
  };
}

export function rescueExitCandidates(task, market, now = Date.now()) {
  const session = liveSession(task);
  if (!session) return [];
  if (market.account?.positionsVerified !== true) { session.netPnl = null; return []; }
  const positions = (market.account.positions || []).filter(p => Number(p.quantity) > 0);
  const unresolvedEntry = [task.pendingAction, ...(task.unsettledActions || [])].some(p => p && !p.exitType
    && (["SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status)
      || (p.entryPurpose === "RESCUE" && p.status === "WAITING") || p.cancellationAwaitingAudit));
  const ordersClear = market.account.openOrdersVerified === true && !market.account.openOrders?.length;
  const groups = rescueGroups(task);
  const candidates = [];
  for (const group of groups) {
    if (group.status === "COMPLETE") continue;
    const ids = new Set(groupIds(group));
    const members = positions.filter(p => ids.has(p.positionOrderId));
    const pending = pendingRescues(task).some(p => p.rescuePositionIds?.some(id => group.originalPositionIds.includes(id)));
    if (!members.length) {
      if (!pending && ordersClear && !unresolvedEntry) {
        group.status = "COMPLETE";
        group.completedAt = new Date(now).toISOString();
      }
      continue;
    }
    const priced = members.map(position => {
      const quote = executableExitQuote(market, position, now);
      return { position, quote, pnl: quote && exitNetPnl(position, quote.price) };
    });
    // Only this group's positions contribute to recovery. Unknown fees, stale
    // quotes, incomplete fills or an externally removed leg cannot count as zero.
    const assembled = group.legacy || (group.rescueOrders.length === RESCUE_ORDERS_PER_ORIGINAL
      && ids.size === members.length && !pending);
    const netKnown = assembled && priced.every(({ position, quote, pnl }) => {
      const sameBookQuantity = priced.filter(item => heldDirection(item.position) === heldDirection(position)
        && identity(item.position).some(value => identity(position).includes(value))).reduce((sum, item) => sum + Number(item.position.quantity), 0);
      return quote && quote.volume >= sameBookQuantity && pnl?.netPnl != null;
    });
    const net = netKnown ? priced.reduce((sum, item) => sum + item.pnl.netPnl, 0) : null;
    const roundingError = netKnown ? Number.EPSILON * priced.reduce((sum, item) => sum
      + (item.pnl.entryPrice + item.pnl.exitPrice) * item.pnl.quantity + item.pnl.fees, 0) * 4 : 0;
    group.netPnl = netKnown && Math.abs(net) <= roundingError ? 0 : net;
    group.checkedAt = market.observedAt;
    if (group.status === "ACTIVE") {
      if (!netKnown || group.netPnl < 0) continue;
      group.status = "EXITING";
      group.triggerNetPnl = group.netPnl;
    }
    // Latch the group exit: a profitable leg filling first must never cancel
    // the remaining losing legs. Retry exact position IDs until all are gone.
    candidates.push(...priced.flatMap(({ position, quote }) => {
      if (!quote || Number(position.frozenQuantity || 0) > 0) return [];
      const side = heldDirection(position);
      if (!["LONG", "SHORT"].includes(side) || !position.positionOrderId) return [];
      const exitType = isNonLosingExit(position, quote.price) ? "TAKE_PROFIT" : "STOP_LOSS";
      return [{ position, decision: { action: side === "LONG" ? "SELL" : "BUY", orderType: "MARKET", exitType,
        targetPositionIds: [position.positionOrderId], targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
        exitGuard: { positionId: position.positionOrderId, heldSide: side, quantity: Number(position.quantity),
          entryPrice: positionEntryPrice(position), exitType, expiresAt: new Date(now + 10000).toISOString(),
          triggerPrice: quote.price, comparison: side === "LONG" ? "GTE" : "LTE", rescueRecovery: true, rescueGroupId: group.id } } }];
    }));
  }
  const remaining = groups.filter(g => g.status !== "COMPLETE");
  session.netPnl = remaining.length && remaining.every(g => g.netPnl != null)
    ? remaining.reduce((sum, g) => sum + g.netPnl, 0) : null;
  session.checkedAt = market.observedAt;
  if (!remaining.length && ordersClear && !unresolvedEntry) {
    session.status = "COMPLETE";
    session.completedAt = new Date(now).toISOString();
  } else {
    session.status = remaining.some(g => g.status === "EXITING") ? "EXITING" : "ACTIVE";
  }
  return candidates;
}
