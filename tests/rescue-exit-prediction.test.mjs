import assert from 'node:assert/strict';
import test from 'node:test';
import { requestRescueExitPrediction } from '../server/provider.mjs';
import { callProviderMethod } from '../server/desktop-ai.mjs';
import { validateRescueExitForecast } from '../server/summary-exit-policy.mjs';
function envelope(format, value) {
  const text = JSON.stringify(value);
  if (format === 'anthropic') return { content: [{ type: 'text', text }] };
  if (format === 'responses') return { output_text: text };
  if (format === 'gemini') return { candidates: [{ content: { parts: [{ text }] } }] };
  return { choices: [{ message: { content: text } }] };
}
for (const apiFormat of ['chat', 'responses', 'anthropic', 'gemini']) test(`${apiFormat} predicts only a commodity exit within five minutes`, async t => {
  const context = { instrument: { symbol: 'A' }, observedAt: new Date().toISOString(), horizonMinutes: 5,
    rescueElapsedMs: 600000, summaries: [{ side: 'LONG', quantity: 2 }, { side: 'SHORT', quantity: 4 }] };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    const messages = body.input || body.messages || body.contents.map(item => ({ content: item.parts[0].text }));
    const prompt = body.system || body.systemInstruction?.parts[0].text || messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
    assert.match(prompt, /未来5分钟内可到达的离场价/);
    assert.match(prompt, /不得决定入场、加仓、救单/);
    assert.match(prompt, /从行情observedAt起算/);
    assert.deepEqual(JSON.parse(messages.at(-1).content), context);
    return new Response(JSON.stringify(envelope(apiFormat, { quote_side: 'ASK', comparison: 'LTE', target_price: 99,
      estimated_minutes: 4, rationale: '买卖盘与分钟结构支持回落', action: 'BUY' })));
  });
  const result = await requestRescueExitPrediction({ apiKey: 'test', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiFormat }, context);
  assert.equal(result.ok, true);
  assert.equal('action' in result, false);
  assert.equal(validateRescueExitForecast(result, context.observedAt).targetPrice, 99);
});
test('missing provider or unavailable prediction never fabricates a target', async t => {
  assert.equal((await requestRescueExitPrediction(null, {})).code, 'PROVIDER_NOT_READY');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(envelope('chat', { unavailable: true, reason: '无可靠走势' }))));
  const result = await requestRescueExitPrediction({ apiKey: 'test', baseUrl: 'https://fixture.invalid', model: 'fixture' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, '无可靠走势');
  assert.throws(() => validateRescueExitForecast(result, new Date().toISOString()), /INVALID_RESCUE_EXIT_FORECAST/);
});
test('server dispatch routes rescue forecasts separately from entry decisions and carries cancellation', async t => {
  const abort = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.signal, abort.signal);
    return new Response(JSON.stringify(envelope('chat', { quote_side: 'BID', comparison: 'GTE', target_price: 101,
      estimated_minutes: 1, rationale: '分时支撑' })));
  });
  const result = await callProviderMethod('requestRescueExitPrediction', 'fixture-user', {
    provider: { apiKey: 'test', baseUrl: 'https://fixture.invalid', model: 'fixture' }, context: {}, options: { signal: abort.signal },
  });
  assert.equal(result.prediction.targetPrice, 101);
});
