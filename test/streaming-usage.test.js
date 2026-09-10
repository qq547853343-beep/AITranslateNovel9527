import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient } from '../lib/deepseek-client.js';
import { readDeepSeekEventStream, extractPartialTranslation } from '../lib/infrastructure/deepseek-stream.js';
import { normalizeTokenUsage, mergeTokenUsage, summarizeTokenUsage } from '../lib/domain/token-usage.js';
import { SessionUsageTracker } from '../lib/application/session-usage-tracker.js';

function streamResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('DeepSeek SSE reader handles split events, partial JSON text and final usage', async () => {
  const partials = []; const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
  const response = streamResponse([
    `: keepalive\n\n${event({ id: 'chat-1', model: 'deepseek-chat', choices: [{ delta: { content: '{"id":"s1","translation":"你' } }] })}`,
    event({ choices: [{ delta: { content: String.raw`好\n世界","notes":[]}` }, finish_reason: 'stop' }] }),
    event({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } }),
    'data: [DONE]\n\n',
  ]);
  const data = await readDeepSeekEventStream(response, { onContent: (content) => partials.push(extractPartialTranslation(content)) });
  assert.equal(JSON.parse(data.choices[0].message.content).translation, '你好\n世界');
  assert.equal(data.choices[0].finish_reason, 'stop');
  assert.equal(data.usage.total_tokens, 18);
  assert.equal(partials.at(-1).value, '你好\n世界');
  assert.equal(partials.at(-1).complete, true);
});

test('DeepSeek translation streams progress, records usage and keeps balance credentials server-side', async () => {
  const requests = []; const progress = []; const usageEvents = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/user/balance')) return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return streamResponse([
      'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"{\\"id\\":\\"s1\\",\\"translation\\":\\"译"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"文\\",\\"notes\\":[],\\"decisionSummary\\":[],\\"uncertainties\\":[]}"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const client = new DeepSeekClient({ apiKey: 'sk-secret-never-returned', fetchImpl, onUsage: (usage, details) => usageEvents.push({ usage, details }) });
  const result = await client.translateSegment({ segment: { id: 's1', text: '原文' }, targetLanguage: '中文', glossary: [], instructions: [], context: [], onProgress: (value) => progress.push(value) });
  const balance = await client.getBalance();
  assert.equal(result.translation, '译文'); assert.equal(result.usage.totalTokens, 24); assert.equal(progress.at(-1).translation, '译文');
  assert.equal(usageEvents.length, 1); assert.equal(usageEvents[0].usage.promptCacheMissTokens, 20);
  const chatBody = JSON.parse(requests[0].options.body); assert.equal(chatBody.stream, true); assert.deepEqual(chatBody.stream_options, { include_usage: true });
  assert.equal(requests[1].options.method, 'GET'); assert.equal('body' in requests[1].options, false); assert.match(requests[1].options.headers.Authorization, /^Bearer /);
  assert.deepEqual(balance, { isAvailable: true, balanceInfos: [{ currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.00', toppedUpBalance: '10.34' }], updatedAt: balance.updatedAt });
  assert.equal(JSON.stringify(balance).includes('sk-secret'), false);
});

test('token usage aggregation is deterministic for task and server-session estimates', () => {
  const first = normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 700 });
  const merged = mergeTokenUsage(first, { promptTokens: 500, completionTokens: 100, promptCacheHitTokens: 100, promptCacheMissTokens: 400 });
  const summary = summarizeTokenUsage(merged, 'deepseek-chat');
  assert.deepEqual({ prompt: summary.promptTokens, output: summary.completionTokens, total: summary.totalTokens, requests: summary.requestCount }, { prompt: 1500, output: 300, total: 1800, requests: 2 });
  assert.equal(summary.promptCacheHitTokens, 800); assert.ok(summary.estimatedCostUsd > 0);
  const tracker = new SessionUsageTracker({ startedAt: '2026-09-10T00:00:00.000Z' }); tracker.record(first); tracker.record({ prompt_tokens: 1, completion_tokens: 1 });
  assert.equal(tracker.snapshot().usage.requestCount, 2);
});
