import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { executableSummaryPortfolio, summaryExitAllowsPrice, summaryExitCandidates, summaryRuleAuthorizationCurrent } from "../server/summary-exit-policy.mjs";

function fixture() {
  const now = Date.now();
  const row = (symbol, side, quantity, averagePrice) => ({ symbol, symbolName: symbol, side, quantity, averagePrice, frozenQuantity: 0 });
  const book = (symbol, bid, ask = bid) => ({ symbol, observedAt: new Date(now).toISOString(),
    orderBook: { bids: [{ price: bid, volume: 100 }], asks: [{ price: ask, volume: 100 }] } });
  const market = { observedAt: new Date(now).toISOString(), books: [book("A", 103), book("B", 98)],
    account: { positionsVerified: true, positions: [], positionSummariesVerified: true,
      positionSummaries: [row("A", "LONG", 1, 100), row("B", "LONG", 2, 100)], openOrdersVerified: true, openOrders: [] } };
  const task = {};
  const tick = (time, bids = {}) => {
    market.observedAt = new Date(time).toISOString();
    for (const current of market.books) {
      current.observedAt = market.observedAt;
      if (bids[current.symbol] !== undefined) {
        current.orderBook.bids[0].price = bids[current.symbol];
        current.orderBook.asks[0].price = bids[current.symbol];
      }
    }
    return summaryExitCandidates(task, market, time);
  };
  const hedge = () => {
    market.account.positionSummaries[1] = row("B", "SHORT", 2, 96);
  };
  return { now, market, task, row, book, tick, hedge };
}

test("aggregate uses every actual quantity and does not mistake one winning leg for total profit", () => {
  const f = fixture();
  assert.equal(executableSummaryPortfolio(f.market, f.now).totalPnl, -1);
  assert.equal(f.tick(f.now).length, 0);
  f.market.account.positionSummaries[1].quantity = 1;
  const candidates = f.tick(f.now);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.decision.exitReason === "TOTAL_PROFIT"));
  assert.equal(candidates[1].decision.exitType, "STOP_LOSS");
  assert.equal(f.task.summaryTradingPlans, undefined);
});

test("positive total latches all exits even after the winner disappears and the remaining total turns negative", () => {
  const f = fixture();
  f.market.account.positionSummaries[1].quantity = 1;
  f.tick(f.now);
  f.market.account.positionSummaries.shift();
  const remaining = f.tick(f.now + 1000);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].decision.exitReason, "TOTAL_PROFIT");
  assert.equal(remaining[0].summary.symbol, "B");
  assert.equal(f.task.summaryExitBatch.phase, "EXIT_ALL");
});

for (const fault of ["missing-book", "stale-book", "future-book", "depth", "unverified-account", "stale-account", "frozen", "duplicate", "unrepresented-position", "quantity-mismatch", "open-order"]) {
  test(`${fault} cannot establish an aggregate-profit exit`, () => {
    const f = fixture();
    f.market.account.positionSummaries[1].quantity = 1;
    if (fault === "missing-book") f.market.books.pop();
    if (fault === "stale-book") f.market.books[1].observedAt = new Date(f.now - 5001).toISOString();
    if (fault === "future-book") f.market.books[1].observedAt = new Date(f.now + 1).toISOString();
    if (fault === "depth") f.market.books[1].orderBook.bids[0].volume = 0;
    if (fault === "unverified-account") f.market.account.positionsVerified = false;
    if (fault === "stale-account") f.market.accountObservedAt = new Date(f.now - 5001).toISOString();
    if (fault === "frozen") f.market.account.positionSummaries[1].frozenQuantity = 1;
    if (fault === "duplicate") f.market.account.positionSummaries.push({ ...f.market.account.positionSummaries[0] });
    if (fault === "unrepresented-position") f.market.account.positions = [f.row("C", "LONG", 1, 100)];
    if (fault === "quantity-mismatch") f.market.account.positions = [f.row("A", "LONG", 2, 100), f.row("B", "LONG", 1, 100)];
    if (fault === "open-order") f.market.account.openOrders = [{ symbol: "A", remainingQuantity: 1 }];
    assert.equal(summaryExitCandidates(f.task, f.market, f.now).length, 0);
    assert.equal(f.task.summaryExitBatch, undefined);
  });
}

test("all depth levels participate and a tiny positive value still triggers without a profit threshold", () => {
  const f = fixture();
  f.market.account.positionSummaries = [f.row("A", "LONG", 3, 100)];
  f.market.books[0].orderBook.bids = [{ price: 103, volume: 1 }, { price: 99, volume: 2 }];
  assert.equal(f.tick(f.now).length, 0);
  f.market.books[0].orderBook.bids[1].price = 100.00001;
  assert.equal(f.tick(f.now).length, 1);
});

test("display-only flash price cannot authorize a positive exit", () => {
  const f = fixture();
  f.market.flashK = { suspected: true, price: 150 };
  f.market.latest = { price: 150 };
  assert.equal(f.tick(f.now).length, 0);
});

test("hedged nonpositive total exits only losers and starts the winner clock after verified cleanup", () => {
  const f = fixture();
  f.hedge();
  const candidates = f.tick(f.now);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary.side, "SHORT");
  assert.equal(candidates[0].decision.exitReason, "HEDGE_LOSS");
  assert.equal(f.task.summaryExitBatch.winnerDeadlineAt, undefined);
  f.market.account.positionSummaries.pop();
  f.task.pendingAction = { targetSummary: candidates[0].summary, status: "UNVERIFIED" };
  f.tick(f.now + 1000);
  assert.equal(f.task.summaryExitBatch.phase, "EXIT_LOSERS");
  f.task.pendingAction.status = "CONFIRMED";
  assert.equal(f.tick(f.now + 2000).length, 0);
  assert.equal(f.task.summaryExitBatch.phase, "WATCH_WINNERS");
  assert.equal(f.task.summaryExitBatch.winnerDeadlineAt, new Date(f.now + 62000).toISOString());
});

test("increasing winners exit at sixty seconds without extending the deadline, including after persistence", () => {
  const f = fixture();
  f.hedge();
  f.tick(f.now);
  f.market.account.positionSummaries.pop();
  f.tick(f.now + 1000);
  const deadline = f.task.summaryExitBatch.winnerDeadlineAt;
  assert.equal(f.tick(f.now + 30000, { A: 104 }).length, 0);
  f.task.summaryExitBatch = structuredClone(compactTaskRuntime(f.task).summaryExitBatch);
  assert.equal(f.tick(f.now + 60999, { A: 105 }).length, 0);
  assert.equal(f.task.summaryExitBatch.winnerDeadlineAt, deadline);
  const candidates = f.tick(f.now + 61000, { A: 106 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].decision.exitReason, "HEDGE_WINNER_DEADLINE");
});

for (const price of [102.9, 100, 99]) test(`retained winners exit early when executable profit falls to ${price}`, () => {
  const f = fixture();
  f.hedge();
  f.tick(f.now);
  f.market.account.positionSummaries.pop();
  f.tick(f.now + 1000);
  const candidates = f.tick(f.now + 2000, { A: price });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].decision.exitReason, "HEDGE_WINNER_PULLBACK");
  assert.equal(candidates[0].decision.exitType, price > 100 ? "TAKE_PROFIT" : "STOP_LOSS");
});

test("deadline locks exit intent even while a quote is missing and resumes only with verified depth", () => {
  const f = fixture();
  f.hedge();
  f.tick(f.now);
  f.market.account.positionSummaries.pop();
  f.tick(f.now + 1000);
  f.market.books = [];
  assert.equal(f.tick(f.now + 61000).length, 0);
  assert.equal(f.task.summaryExitBatch.phase, "EXIT_WINNERS");
  f.market.books = [f.book("A", 102)];
  assert.equal(f.tick(f.now + 62000).length, 1);
});

test("a retained leg turning negative during cleanup joins the losing exits without waiting for the original transfer", () => {
  const f = fixture();
  f.hedge();
  f.tick(f.now);
  const candidates = f.tick(f.now + 1000, { A: 99 });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.decision.exitReason === "HEDGE_LOSS"));
});

test("hedged holdings that are both losing exit both sides without inventing a winner", () => {
  const f = fixture();
  f.hedge();
  const candidates = f.tick(f.now, { A: 99 });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.decision.exitType === "STOP_LOSS"));
  assert.ok(f.task.summaryExitBatch.targets.every(target => target.role === "LOSER"));
});

test("one winner's profit decline is not hidden by a different winner's increase", () => {
  const f = fixture();
  f.hedge();
  f.market.account.positionSummaries.push(f.row("C", "LONG", 1, 100));
  f.market.books.push(f.book("C", 100.1));
  f.tick(f.now);
  f.market.account.positionSummaries = f.market.account.positionSummaries.filter(row => row.symbol !== "B");
  f.tick(f.now + 1000);
  const candidates = f.tick(f.now + 2000, { A: 102.9, C: 110 });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.decision.exitReason === "HEDGE_WINNER_PULLBACK"));
});

test("user rule authorization is bound to the current cohort and rejects changed holdings or retired batches", () => {
  const f = fixture();
  f.market.account.positionSummaries[1].quantity = 1;
  const candidate = f.tick(f.now)[0];
  const authorization = candidate.decision.exitGuard.aiAuthorization;
  assert.equal(summaryRuleAuthorizationCurrent(f.task, candidate.summary, authorization), true);
  assert.equal(summaryExitAllowsPrice(candidate.summary, 99, authorization, f.now), true);
  assert.equal(summaryExitAllowsPrice({ ...candidate.summary, averagePrice: 101 }, 99, authorization, f.now), false);
  f.task.summaryExitBatch.id = "different-batch";
  assert.equal(summaryRuleAuthorizationCurrent(f.task, candidate.summary, authorization), false);
  f.market.account.positionSummaries[0].quantity = 2;
  assert.equal(f.tick(f.now + 1000).length, 0);
  assert.equal(f.task.summaryExitBatch.phase, "INVALIDATED");
});
