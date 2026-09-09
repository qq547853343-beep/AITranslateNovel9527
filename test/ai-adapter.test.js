import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient } from '../lib/deepseek-client.js';
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
});

test('DeepSeek adapter maps provider failures without exposing transport details', async () => {
  const provider = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) }) });
  await assert.rejects(
    () => provider.translateText({ text: 'source', targetLanguage: '中文' }),
    (error) => error.code === 'AI_PROVIDER_REQUEST_FAILED' && error.status === 429 && error.provider === 'deepseek',
  );
});
