import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCollectedMarket } from "../server/market-analysis.mjs";
import { approvedKnowledgeForAnalysis, buildApprovedExperiencePrompt } from "../server/rag.mjs";
import { marketDataFingerprint } from "../server/market.mjs";
import { summarizeOrderBook } from "../server/order-book.mjs";
import { parseHaohanOrderBook } from "../server/haohan.mjs";

test("order-book parsing handles spaced levels, separators and quantity units", () => {
  const book = summarizeOrderBook(parseHaohanOrderBook("销售 ① 1,102.50 1.25万 采购一 1,101.50 3,000"));
  assert.equal(book.askVolume, 12500);
  assert.equal(book.bidVolume, 3000);
  assert.equal(book.spread, 1);
  assert.equal(summarizeOrderBook(null).status, "MISSING");
  assert.equal(summarizeOrderBook({ bids: book.bids }).imbalance, null);
});

test("secondary order-book changes trigger analysis but sample time alone does not", () => {
  const base = { symbol: "A", books: [{ symbol: "B", orderBook: { asks: [{ level: 1, price: 102, volume: 5 }], bids: [{ level: 1, price: 100, volume: 8 }], observedAt: "one" } }] };
  const original = marketDataFingerprint(base);
  base.books[0].orderBook.observedAt = "two";
  assert.equal(marketDataFingerprint(base), original);
  base.books[0].orderBook.bids[0].volume = 10;
  assert.notEqual(marketDataFingerprint(base), original);
});

test("direct analysis sends shared approved experience and both order books in one model request", async (t) => {
  const content = "成交量与趋势存在分歧时结合买卖档位判断。".repeat(30);
  const evidence = approvedKnowledgeForAnalysis([
    { id: "one", title: "经验", status: "APPROVED", ownerUserId: "owner", version: "v1", content },
    { id: "draft", status: "REVIEW", ownerUserId: "owner", content: "draft" },
    { id: "foreign", title: "共享经验", status: "APPROVED", ownerUserId: "other", version: "v1", content: "shared experience" },
    { id: "legacy", title: "公共经验", status: "APPROVED", version: "v1", content: "legacy experience" },
  ]);
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0].excerpt, content);
  const experiencePrompt = buildApprovedExperiencePrompt(evidence);
  assert.match(experiencePrompt, /标题：经验/);
  assert.match(experiencePrompt, /原文：/);
  assert.equal(evidence[0].excerpt, content);
  assert.throws(() => approvedKnowledgeForAnalysis([{ status: "APPROVED", content: "too-small-budget" }], 10), /AI_KNOWLEDGE_TOO_LARGE/);
  assert.throws(() => buildApprovedExperiencePrompt(evidence, 10), /AI_KNOWLEDGE_TOO_LARGE/);
  const now = Date.now();
  const makeBook = (symbol, price) => ({ symbol, timeframe: "1m", dataAt: new Date(now).toISOString(), history: [{ timestamp: now - 60000, open: price, high: price + 1, low: price - 1, close: price, volume: 10 }], orderBook: summarizeOrderBook({ bids: [{ level: 1, price, volume: 100 }], asks: [{ level: 1, price: price + 1, volume: 40 }] }), raw: { duplicate: "x".repeat(300000) } });
  const market = { ...makeBook("A", 100), books: [makeBook("A", 100), makeBook("B", 200)], fingerprint: "snapshot", account: { availableFunds: 500, frozenFunds: 2000, frozenMargin: 1800, positionDeposit: 1000, openOrdersVerified: true, openOrders: [{ orderId: "O-1", remainingQuantity: 1, orderPrice: 99, frozenMargin: 1800, orderDeposit: 3600 }] } };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    const input = JSON.parse(payload.messages.at(-1).content);
    const context = input.context || input;
    assert.equal(context.evidence[0].excerpt, undefined);
    assert.equal(context.experiencePrompt, undefined);
    assert.equal(context.approvedSkills[0].title, "经验");
    assert.deepEqual(context.approvedSkills.map((skill) => skill.title), ["经验", "共享经验", "公共经验"]);
    assert.equal(context.approvedSkills[0].content, undefined);
    assert.equal(payload.messages.filter((message) => message.content.includes(content)).length, 1);
    assert.ok(payload.messages.some((message) => message.content.includes(experiencePrompt)));
    assert.ok(payload.messages.some((message) => message.content.includes("shared experience") && message.content.includes("legacy experience")));
    assert.doesNotMatch(JSON.stringify(payload), /"draft"/);
    assert.equal(context.strategy.kline.printSecond, 50);
    assert.equal(context.market.books[1].orderBook.bestBid, 200);
    assert.equal(context.market.account.openOrders[0].orderId, "O-1");
    assert.equal(context.market.account.frozenFunds, 2000);
    assert.equal(context.market.account.positionDeposit, 1000);
    assert.equal(context.market.account.openOrders[0].frozenMargin, 1800);
    assert.equal(context.market.account.openOrders[0].orderDeposit, 3600);
    assert.match(payload.messages[0].content, /5根只是举例，不设固定持仓K数/);
    assert.match(payload.messages[0].content, /赚取可兑现净利润，同时减少不必要亏损/);
    assert.match(payload.messages[0].content, /买涨（多）和买跌（空）都能获利/);
    assert.equal(context.market.operatorContext.orderBookSnapshotCount, 3);
    assert.equal(context.market.raw, undefined);
    assert.equal(context.market.books[1].raw, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", profit_probability: 0.55, confidence: 0.6, target_symbol: "B", order_assessments: [{ order_id: "O-1", decision: "CANCEL", reason: "原订单收益预期转弱，释放已知冻结保证金1800更有利" }], operator_assessment: { likelihood: "MEDIUM", confidence: 0.7, evidence: ["固定间隔逐笔样本"], limitations: ["没有撤单数据"], impact: "MEDIUM" } }) } }] }), { headers: { "content-type": "application/json" } });
  });
  const result = await analyzeCollectedMarket({ apiKey: "test", apiFormat: "chat", baseUrl: "https://provider.example.test", model: "model" }, market, { evidence, evidenceIds: evidence.map((item) => item.evidenceId), experiencePrompt });
  assert.equal(calls, 1);
  assert.equal(result.coverage.mode, "direct_client");
  assert.equal(result.coverage.bookCount, 2);
  assert.equal(result.coverage.totalKlineRows, 2);
  assert.ok(result.coverage.contextBytes < 50000);
  assert.equal(result.decision.profitProbability, 0.55);
  assert.equal(result.decision.operatorAssessment.likelihood, "MEDIUM");
  assert.equal(result.decision.operatorAssessment.impact, "MEDIUM");
  assert.deepEqual(result.decision.cancelOrderIds, ["O-1"]);
  assert.match(result.decision.orderAssessments[0].reason, /1800/);
});
