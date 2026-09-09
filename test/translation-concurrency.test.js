import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.js';
import { RuleSetRepository, TranslationJobRepository } from '../lib/repositories.js';
import { TranslationService } from '../lib/translation-service.js';
import { assertJobTransition, assertSegmentTransition } from '../lib/domain/translation-state.js';

function createPendingJob(jobs) {
  return jobs.create({
    title: '并发测试',
    targetLanguage: '中文',
    sourceBlocks: [{ kind: 'text', tag: 'p', text: '原文' }],
    segments: [{ id: 'segment-1', sourceText: '原文', status: 'pending', translatedText: '', issues: [], attempts: 0 }],
  });
}

test('translation job updates reject stale revisions', () => {
  const database = openDatabase(':memory:');
  const jobs = new TranslationJobRepository(database);
  const initial = createPendingJob(jobs);
  const updated = jobs.update(initial.id, { currentSegment: 1 }, { expectedRevision: initial.revision });
  assert.equal(updated.revision, initial.revision + 1);
  assert.throws(
    () => jobs.update(initial.id, { currentSegment: 2 }, { expectedRevision: initial.revision }),
    (error) => error.code === 'JOB_CONCURRENCY_CONFLICT' && error.status === 409,
  );
  assert.equal(jobs.getById(initial.id).currentSegment, 1);
  database.close();
});

test('only an expired translation lease can be claimed by a new worker', () => {
  const database = openDatabase(':memory:');
  const jobs = new TranslationJobRepository(database);
  const initial = createPendingJob(jobs);
  const workerA = jobs.claim(initial.id, 'worker-a', { timestamp: 1_000, leaseMs: 1_000 });
  assert.equal(workerA.workerId, 'worker-a');
  assert.equal(jobs.claim(initial.id, 'worker-b', { timestamp: 1_500, leaseMs: 1_000 }), null);
  const workerB = jobs.claim(initial.id, 'worker-b', { timestamp: 2_001, leaseMs: 1_000 });
  assert.equal(workerB.workerId, 'worker-b');
  assert.ok(workerB.revision > workerA.revision);
  assert.throws(
    () => jobs.update(initial.id, { lastError: 'late write' }, { expectedRevision: workerA.revision, expectedWorkerId: 'worker-a' }),
    (error) => error.code === 'JOB_CONCURRENCY_CONFLICT',
  );
  assert.equal(jobs.getById(initial.id).workerId, 'worker-b');
  database.close();
});

test('a cancelled job ignores a provider response that arrives late', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database);
  const jobs = new TranslationJobRepository(database);
  let markStarted;
  let returnTranslation;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const delayedResponse = new Promise((resolve) => { returnTranslation = resolve; });
  const client = {
    translateSegment: async () => {
      markStarted();
      return delayedResponse;
    },
  };
  const service = new TranslationService({ jobRepository: jobs, ruleSetRepository: ruleSets, clientFactory: async () => client });
  const prepared = service.prepare({ title: '迟到写回', blocks: [{ kind: 'text', tag: 'p', text: '原文' }], targetLanguage: '中文' });
  const running = service.run(prepared.id);
  await started;
  const cancelled = service.cancel(prepared.id);
  assert.equal(cancelled.status, 'cancelled');
  returnTranslation({ translation: '不应写入', notes: [], decisionSummary: [], uncertainties: [] });
  await running;
  const finalJob = jobs.getById(prepared.id);
  assert.equal(finalJob.status, 'cancelled');
  assert.equal(finalJob.resultBlocks.length, 0);
  assert.equal(finalJob.segments[0].translatedText, '');
  database.close();
});

test('translation state transitions reject invalid terminal rewrites', () => {
  assert.doesNotThrow(() => assertJobTransition('failed', 'pending'));
  assert.doesNotThrow(() => assertSegmentTransition('translating', 'completed'));
  assert.throws(() => assertJobTransition('completed', 'running'), (error) => error.code === 'INVALID_JOB_TRANSITION');
  assert.throws(() => assertSegmentTransition('completed', 'pending'), (error) => error.code === 'INVALID_SEGMENT_TRANSITION');
});

test('resume waits for an active foreign lease and takes over once it expires', async () => {
  const database = openDatabase(':memory:');
  const ruleSets = new RuleSetRepository(database);
  const jobs = new TranslationJobRepository(database);
  let calls = 0;
  const service = new TranslationService({
    jobRepository: jobs,
    ruleSetRepository: ruleSets,
    clientFactory: async () => ({ translateSegment: async ({ segment }) => { calls += 1; return { translation: `译：${segment.text}`, notes: [], decisionSummary: [], uncertainties: [] }; } }),
    leaseMs: 100,
    heartbeatMs: 20,
  });
  const prepared = service.prepare({ title: '崩溃恢复', blocks: [{ kind: 'text', tag: 'p', text: '原文' }], targetLanguage: '中文' });
  jobs.claim(prepared.id, 'crashed-worker', { timestamp: Date.now(), leaseMs: 25 });
  const deferred = service.resume(prepared.id);
  assert.equal(deferred.workerId, 'crashed-worker');
  assert.equal(calls, 0);
  for (let count = 0; count < 30 && jobs.getById(prepared.id).status !== 'completed'; count += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const completed = jobs.getById(prepared.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.recoveryReason, 'resume-after-expired-lease');
  assert.equal(calls, 1);
  database.close();
});
