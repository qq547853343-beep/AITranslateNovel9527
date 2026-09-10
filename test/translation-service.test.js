import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.js';
import { RuleSetRepository, TranslationJobRepository } from '../lib/repositories.js';
import { TranslationService } from '../lib/translation-service.js';

test('translation jobs report progress and preserve blocks', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  const set = ruleSets.create({ name: '测试规则' });
  ruleSets.addRule(set.id, { source: '聖女', target: '圣女' });
  const client = { translateSegment: async ({ segment }) => ({ translation: segment.text.replaceAll('聖女', '圣女'), notes: [], decisionSummary: [], uncertainties: [] }) };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '测试', blocks: [{ kind: 'text', tag: 'p', text: '聖女 {name}' }, { kind: 'image', assetId: '123e4567-e89b-12d3-a456-426614174000.png', originalAssetId: '123e4567-e89b-12d3-a456-426614174001.svg', originalFormat: 'svg' }], targetLanguage: '中文', ruleSetIds: [set.id] });
  await service.run(prepared.id);
  const completed = jobs.getById(prepared.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultBlocks[0].text, '圣女 {name}');
  assert.equal(completed.resultBlocks[1].kind, 'image');
  assert.equal(completed.resultBlocks[1].originalAssetId, '123e4567-e89b-12d3-a456-426614174001.svg');
  assert.equal(completed.meta.validationIssues.length, 0);
  database.close();
});

test('translation job records provider setup failures and remains retryable', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => { throw new Error('尚未配置 API Key'); } });
  const prepared = service.prepare({ title: '失败任务', blocks: [{ kind: 'text', tag: 'p', text: '原文' }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const failed = jobs.getById(prepared.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.meta.lastError, '尚未配置 API Key');
  database.close();
});

test('translation can be cancelled while a segment request is active', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const client = { translateSegment: ({ signal }) => new Promise((_resolve, reject) => { requestStarted(); signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }); }) };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '取消任务', blocks: [{ kind: 'text', tag: 'p', text: '等待中的原文' }], targetLanguage: '中文' });
  const running = service.run(prepared.id); await started;
  service.cancel(prepared.id); await running;
  assert.equal(jobs.getById(prepared.id).status, 'cancelled');
  database.close();
});

test('completed segments remain available when a later segment fails', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  let calls = 0;
  const client = { translateSegment: async ({ segment }) => { calls += 1; if (calls === 2) throw new Error('模拟失败'); return { translation: `译：${segment.text}`, notes: [], decisionSummary: [], uncertainties: [] }; } };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '部分结果', blocks: [{ kind: 'text', tag: 'p', text: '第一段' }, { kind: 'text', tag: 'p', text: '第二段' }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const failed = jobs.getById(prepared.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.resultBlocks[0].text, '译：第一段');
  assert.equal(failed.resultBlocks[1].text, '');
  database.close();
});

test('translation retries malformed structured responses with persisted attempt metadata', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  const retryAttempts = [];
  const client = {
    translateSegment: async ({ segment, retryAttempt }) => {
      retryAttempts.push(retryAttempt);
      if (retryAttempt < 1) throw Object.assign(new Error('AI JSON 无效'), { code: 'AI_RESPONSE_INVALID', retryable: true });
      return { translation: `译：${segment.text}`, notes: [], decisionSummary: [], uncertainties: [] };
    },
  };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '自动重试', blocks: [{ kind: 'text', tag: 'p', text: '短文本' }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const completed = jobs.getById(prepared.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(retryAttempts, [0, 1]);
  assert.equal(completed.segments[0].attempts, 2);
  assert.equal(completed.segments[0].status, 'completed');
  database.close();
});

test('translation stops after one automatic structured-response retry', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  let calls = 0;
  const client = { translateSegment: async () => { calls += 1; throw Object.assign(new Error('JSON 被截断'), { code: 'AI_RESPONSE_TRUNCATED', retryable: true }); } };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '有限重试', blocks: [{ kind: 'text', tag: 'p', text: '短文本' }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const failed = jobs.getById(prepared.id);
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 2);
  assert.equal(failed.segments[0].attempts, 2);
  assert.match(failed.lastError, /已自动重试 1 次/);
  database.close();
});

test('translation sends compressed expressive runs while preserving the stored source', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  const source = 'アン「ぴぎいいいいいいいいいいげげげぐぐぐぎぎきいいいいいいいいい';
  let providerSegment;
  const client = { translateSegment: async ({ segment }) => { providerSegment = segment; return { translation: '安：“咿呀啊啊——！”', notes: [], decisionSummary: [], uncertainties: [] }; } };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '语气词压缩', blocks: [{ kind: 'text', tag: 'p', text: source }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const completed = jobs.getById(prepared.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sourceBlocks[0].text, source);
  assert.notEqual(providerSegment.text, source);
  assert.ok(providerSegment.repetitionHints.length > 0);
  assert.equal(completed.resultBlocks[0].text, '安：“咿呀啊啊——！”');
  database.close();
});

test('translation rejects a parsed but repetitive result and retries only once', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  let calls = 0;
  const client = {
    translateSegment: async () => {
      calls += 1;
      return { translation: calls === 1 ? '啊'.repeat(13) : '啊啊啊——！', notes: [], decisionSummary: [], uncertainties: [] };
    },
  };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '返回重复校验', blocks: [{ kind: 'text', tag: 'p', text: 'あああああああああああああ' }], targetLanguage: '中文' });
  await service.run(prepared.id);
  const completed = jobs.getById(prepared.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.segments[0].attempts, 2);
  assert.equal(completed.resultBlocks[0].text, '啊啊啊——！');
  assert.equal(calls, 2);
  database.close();
});

test('translation publishes in-memory partial text, accounts failed calls and retries one failed segment', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database); const jobs = new TranslationJobRepository(database);
  let calls = 0; const partials = [];
  const client = {
    model: 'deepseek-chat',
    translateSegment: async ({ segment, onProgress }) => {
      calls += 1; onProgress?.({ translation: calls === 1 ? '未完成' : '完成译文', complete: false });
      if (calls === 1) throw Object.assign(new Error('模拟提供商中断'), { usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, requestCount: 1 } });
      return { translation: `译：${segment.text}`, notes: [], decisionSummary: [], uncertainties: [], usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12, requestCount: 1 }, providerModel: 'deepseek-chat' };
    },
  };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '单段重试', blocks: [{ kind: 'text', tag: 'p', text: '原文' }], targetLanguage: '中文' });
  const unsubscribe = service.subscribe(prepared.id, ({ event, payload }) => { if (event === 'partial') partials.push(payload); });
  await service.run(prepared.id);
  let failed = jobs.getById(prepared.id); const publicFailed = service.publicJob(failed);
  assert.equal(failed.status, 'failed'); assert.equal(publicFailed.failedSegmentDetails.length, 1); assert.equal(publicFailed.failedSegmentDetails[0].sourceText, '原文');
  assert.equal(failed.meta.usage.totalTokens, 12); assert.ok(partials.some((item) => item.translation === '未完成'));
  service.retrySegment(prepared.id, failed.segments[0].id);
  for (let count = 0; count < 50; count += 1) { failed = jobs.getById(prepared.id); if (failed.status === 'completed') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
  unsubscribe();
  assert.equal(failed.status, 'completed'); assert.equal(failed.resultBlocks[0].text, '译：原文'); assert.equal(failed.meta.usage.totalTokens, 24); assert.equal(failed.meta.usage.requestCount, 2);
  database.close();
});
