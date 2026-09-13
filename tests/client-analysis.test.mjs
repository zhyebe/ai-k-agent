import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCollectedMarket } from "../server/market-analysis.mjs";
import { approvedKnowledgeForAnalysis } from "../server/rag.mjs";
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

test("direct analysis sends full approved owner experience and both order books in one model request", async (t) => {
  const content = "成交量与趋势存在分歧时结合买卖档位判断。".repeat(30);
  const evidence = approvedKnowledgeForAnalysis([
    { id: "one", title: "经验", status: "APPROVED", ownerUserId: "owner", version: "v1", content },
    { id: "draft", status: "REVIEW", ownerUserId: "owner", content: "draft" },
    { id: "foreign", status: "APPROVED", ownerUserId: "other", content: "secret" },
  ], "owner");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].excerpt, content);
  assert.throws(() => approvedKnowledgeForAnalysis([{ status: "APPROVED", ownerUserId: "owner", content }], "owner", 10), /EXPERIENCE_CONTEXT_TOO_LARGE/);
  const now = Date.now();
  const makeBook = (symbol, price) => ({ symbol, timeframe: "1m", dataAt: new Date(now).toISOString(), history: [{ timestamp: now - 60000, open: price, high: price + 1, low: price - 1, close: price, volume: 10 }], orderBook: summarizeOrderBook({ bids: [{ level: 1, price, volume: 100 }], asks: [{ level: 1, price: price + 1, volume: 40 }] }), raw: { duplicate: "x".repeat(300000) } });
  const market = { ...makeBook("A", 100), books: [makeBook("A", 100), makeBook("B", 200)], fingerprint: "snapshot" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    const input = JSON.parse(payload.messages.at(-1).content);
    const context = input.context || input;
    assert.equal(context.evidence[0].excerpt, content);
    assert.equal(context.market.books[1].orderBook.bestBid, 200);
    assert.equal(context.market.raw, undefined);
    assert.equal(context.market.books[1].raw, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", profit_probability: 0.55, confidence: 0.6, target_symbol: "B" }) } }] }), { headers: { "content-type": "application/json" } });
  });
  const result = await analyzeCollectedMarket({ apiKey: "test", apiFormat: "chat", baseUrl: "https://provider.example.test", model: "model" }, market, { evidence, evidenceIds: evidence.map((item) => item.evidenceId) });
  assert.equal(calls, 1);
  assert.equal(result.coverage.mode, "direct_client");
  assert.equal(result.coverage.bookCount, 2);
  assert.equal(result.coverage.totalKlineRows, 2);
  assert.ok(result.coverage.contextBytes < 50000);
  assert.equal(result.decision.profitProbability, 0.55);
});
