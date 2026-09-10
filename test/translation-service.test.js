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
