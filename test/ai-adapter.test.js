import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient, translationMaxTokens } from '../lib/deepseek-client.js';
import { parseStructuredAIResponse } from '../lib/ai/response-parser.js';

test('AI response parser accepts fenced JSON and rejects malformed responses with a stable code', () => {
  assert.deepEqual(parseStructuredAIResponse({ choices: [{ message: { content: '```json\n{"value":1}\n```' } }] }), { value: 1 });
  assert.throws(() => parseStructuredAIResponse({ choices: [{ message: { content: 'not-json' } }] }), (error) => error.code === 'AI_RESPONSE_INVALID');
});

test('DeepSeek adapter keeps text compatibility separate from structured translation', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const content = request.response_format ? JSON.stringify({ id: 's1', translation: '分段译文', notes: [], decisionSummary: [], uncertainties: [] }) : '旧接口译文';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const provider = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl });
  const segment = await provider.translateSegment({ segment: { id: 's1', text: 'source' }, targetLanguage: '中文', glossary: [], instructions: [], context: [] });
  const text = await provider.translateText({ text: 'legacy', targetLanguage: '中文' });
  assert.equal(segment.translation, '分段译文');
  assert.equal(text, '旧接口译文');
  assert.deepEqual(requests.map((request) => Boolean(request.response_format)), [true, false]);
  assert.equal(requests[0].max_tokens, 512);
  assert.equal('max_tokens' in requests[1], false);
});

test('DeepSeek adapter bounds structured translation output and identifies truncation', async () => {
  let request;
  const provider = new DeepSeekClient({
    apiKey: 'sk-test',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"id":"s1","translation":"未闭合' } }] }) };
    },
  });
  await assert.rejects(
    () => provider.translateSegment({ segment: { id: 's1', text: '短文本' }, targetLanguage: '中文', glossary: [], instructions: [], context: [], retryAttempt: 1 }),
    (error) => error.code === 'AI_RESPONSE_TRUNCATED' && error.retryable === true && error.maxTokens === 512,
  );
  assert.equal(request.max_tokens, 512);
  assert.match(request.messages[0].content, /重新生成/);
  assert.equal(JSON.parse(request.messages[1].content).constraints.retryAttempt, 1);
  assert.equal(translationMaxTokens('a'.repeat(5_000)), 8192);
});

test('DeepSeek adapter maps provider failures without exposing transport details', async () => {
  const provider = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) }) });
  await assert.rejects(
    () => provider.translateText({ text: 'source', targetLanguage: '中文' }),
    (error) => error.code === 'AI_PROVIDER_REQUEST_FAILED' && error.status === 429 && error.provider === 'deepseek',
  );
});
