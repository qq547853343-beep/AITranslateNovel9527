import { collectRules, matchRules, resolveRuleConflicts, validateTranslation } from './rules.js';
import { compressExpressiveRuns, findTranslationShapeIssue, mergeTranslatedBlocks, protectPlaceholders, restorePlaceholders, segmentDocumentBlocks } from './text-processing.js';
import { randomUUID } from 'node:crypto';
import { assertJobTransition, assertSegmentTransition, isLeaseExpired } from './domain/translation-state.js';

export class TranslationService {
  constructor({ jobRepository, ruleSetRepository, clientFactory, leaseMs = 120000, heartbeatMs = 30000 }) {
    this.jobs = jobRepository; this.ruleSets = ruleSetRepository; this.clientFactory = clientFactory; this.controllers = new Map(); this.recoveryTimers = new Map(); this.leaseMs = leaseMs; this.heartbeatMs = heartbeatMs;
  }
  prepare({ title, blocks, targetLanguage, ruleSetIds = [], temporaryRules = [], validationMode = 'warning', includeNotes = false }) {
    const collected = collectRules(this.ruleSets, ruleSetIds);
    const temporary = temporaryRules.map((rule, index) => ({ ...rule, id: rule.id || `temporary-${index}`, ruleSetId: 'temporary', ruleSetName: '本次临时规则', ruleSetVersion: 1, enabled: true, effectivePriority: 1_000_000_000 + (Number(rule.priority) || 0) }));
    const resolved = resolveRuleConflicts([...temporary, ...collected.rules]);
    if (resolved.conflicts.length) throw Object.assign(new Error('存在同优先级规则冲突，请先处理。'), { status: 409, details: resolved.conflicts });
    const segments = segmentDocumentBlocks(blocks);
    if (!segments.length) throw Object.assign(new Error('文档中没有可翻译的文字。'), { status: 400 });
    return this.jobs.create({ title, sourceBlocks: blocks, targetLanguage, model: 'deepseek-chat', ruleSetIds, validationMode, segments, meta: { ruleSets: collected.sets.map(({ id, name, version }) => ({ id, name, version })), resolvedRules: resolved.rules, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [], includeNotes, retries: 0 } });
  }
  async run(jobId) {
    if (this.controllers.has(jobId)) return this.jobs.getById(jobId);
    this.#clearRecoveryTimer(jobId);
    const workerId = randomUUID();
    let job = this.jobs.claim(jobId, workerId, { leaseMs: this.leaseMs });
    if (!job) return this.jobs.getById(jobId);
    const controller = new AbortController(); this.controllers.set(jobId, { controller, workerId });
    try {
      const client = await this.clientFactory();
      for (let index = 0; index < job.segments.length; index += 1) {
        job = this.jobs.getById(jobId);
        if (!job || controller.signal.aborted || job.status !== 'running' || job.workerId !== workerId) break;
        const segment = job.segments[index];
        if (segment.status === 'completed') continue;
        if (!['pending', 'failed', 'cancelled'].includes(segment.status)) continue;
        if (segment.status !== 'pending') assertSegmentTransition(segment.status, 'pending');
        assertSegmentTransition('pending', 'translating');
        Object.assign(segment, { status: 'translating', error: '', lastError: '', attempts: Number(segment.attempts || 0) + 1, requestId: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null });
        job = this.jobs.update(jobId, { status: 'running', currentSegment: index + 1, segments: job.segments }, { expectedRevision: job.revision, expectedWorkerId: workerId });
        const heartbeat = setInterval(() => this.jobs.heartbeat(jobId, workerId, { leaseMs: this.leaseMs }), this.heartbeatMs); heartbeat.unref?.();
        try {
          const context = this.#context(job.segments, index);
          const matched = matchRules([segment.sourceText, ...context.map((item) => item.source)].join('\n'), job.meta.resolvedRules || []);
          const protectedSource = protectPlaceholders(segment.sourceText);
          const normalizedSource = compressExpressiveRuns(protectedSource.text);
          const response = await this.#translateWithRetry({
            jobId,
            workerId,
            index,
            client,
            signal: controller.signal,
            request: { segment: { id: segment.id, text: normalizedSource.text, repetitionHints: normalizedSource.hints }, targetLanguage: job.targetLanguage, glossary: matched, instructions: this.#instructions(job.meta.resolvedRules || []), context, includeNotes: Boolean(job.meta.includeNotes) },
          });
          clearInterval(heartbeat);
          job = this.jobs.getById(jobId);
          if (!job || job.status !== 'running' || job.workerId !== workerId) return job;
          const currentSegment = job.segments[index];
          const restored = restorePlaceholders(response.translation, protectedSource.values);
          const issues = [...restored.issues, ...validateTranslation(segment.sourceText, restored.text, matched)];
          if (job.validationMode === 'strict' && issues.length && Number(currentSegment.retries || 0) < 2) {
            assertSegmentTransition(currentSegment.status, 'failed');
            Object.assign(currentSegment, { status: 'failed', retries: Number(currentSegment.retries || 0) + 1, finishedAt: new Date().toISOString(), lastError: '严格校验未通过', error: '严格校验未通过' });
            job.meta.retries = Number(job.meta.retries || 0) + 1;
            job = this.jobs.update(jobId, { segments: job.segments, meta: job.meta, currentSegment: index + 1 }, { expectedRevision: job.revision, expectedWorkerId: workerId });
            const retrySegment = job.segments[index]; assertSegmentTransition(retrySegment.status, 'pending');
            Object.assign(retrySegment, { status: 'pending', requestId: null, startedAt: null, finishedAt: null, lastError: '', error: '' });
            job = this.jobs.update(jobId, { segments: job.segments }, { expectedRevision: job.revision, expectedWorkerId: workerId }); index -= 1;
          } else {
            assertSegmentTransition(currentSegment.status, 'completed');
            Object.assign(currentSegment, { translatedText: restored.text, issues, status: 'completed', finishedAt: new Date().toISOString(), lastError: '', error: '' });
            mergeUnique(job.meta.appliedRules, matched, 'id');
            job.meta.validationIssues.push(...issues.map((issue) => ({ ...issue, segmentId: currentSegment.id })));
            mergeUnique(job.meta.notes, response.notes); mergeUnique(job.meta.decisionSummary, response.decisionSummary); mergeUnique(job.meta.uncertainties, response.uncertainties);
            job = this.jobs.update(jobId, { segments: job.segments, resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), meta: job.meta, currentSegment: index + 1 }, { expectedRevision: job.revision, expectedWorkerId: workerId });
          }
        } catch (error) {
          clearInterval(heartbeat);
          if (error.code === 'JOB_CONCURRENCY_CONFLICT') return this.jobs.getById(jobId);
          job = this.jobs.getById(jobId);
          if (!job || job.workerId !== workerId || job.status !== 'running') return job;
          const currentSegment = job.segments[index];
          if (controller.signal.aborted || error.name === 'AbortError') {
            if (currentSegment.status === 'translating') assertSegmentTransition(currentSegment.status, 'cancelled');
            Object.assign(currentSegment, { status: 'cancelled', finishedAt: new Date().toISOString(), lastError: '翻译已取消', error: '' });
            assertJobTransition(job.status, 'cancelled');
            return this.jobs.update(jobId, { status: 'cancelled', segments: job.segments, workerId: null, leaseUntil: null, lastError: '' }, { expectedRevision: job.revision, expectedWorkerId: workerId });
          }
          if (currentSegment.status === 'translating') assertSegmentTransition(currentSegment.status, 'failed');
          Object.assign(currentSegment, { status: 'failed', finishedAt: new Date().toISOString(), lastError: error.message || '翻译失败', error: error.message || '翻译失败' });
          assertJobTransition(job.status, 'failed');
          this.jobs.update(jobId, { status: 'failed', segments: job.segments, meta: job.meta, currentSegment: index + 1, workerId: null, leaseUntil: null, lastError: currentSegment.lastError }, { expectedRevision: job.revision, expectedWorkerId: workerId }); return;
        }
      }
      job = this.jobs.getById(jobId);
      if (job?.status === 'running' && job.workerId === workerId && job.segments.every((segment) => segment.status === 'completed')) {
        assertJobTransition(job.status, 'completed');
        return this.jobs.update(jobId, { status: 'completed', resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), currentSegment: job.segments.length, workerId: null, leaseUntil: null, lastError: '' }, { expectedRevision: job.revision, expectedWorkerId: workerId });
      }
    } catch (error) {
      const job = this.jobs.getById(jobId);
      if (error.code !== 'JOB_CONCURRENCY_CONFLICT' && job?.status === 'running' && job.workerId === workerId) {
        try { assertJobTransition(job.status, 'failed'); this.jobs.update(jobId, { status: 'failed', workerId: null, leaseUntil: null, lastError: error.message || '翻译任务失败', meta: { ...job.meta, lastError: error.message || '翻译任务失败' } }, { expectedRevision: job.revision, expectedWorkerId: workerId }); } catch {}
      }
    } finally { if (this.controllers.get(jobId)?.workerId === workerId) this.controllers.delete(jobId); }
  }
  cancel(jobId) {
    this.#clearRecoveryTimer(jobId);
    const active = this.controllers.get(jobId); if (active) active.controller.abort();
    const job = this.jobs.getById(jobId); if (!job) return null;
    if (job.status === 'cancelled' || job.status === 'completed') return job;
    assertJobTransition(job.status, 'cancelled');
    const timestamp = new Date().toISOString();
    return this.jobs.update(jobId, { status: 'cancelled', workerId: null, leaseUntil: null, lastError: '', segments: job.segments.map((segment) => segment.status === 'translating' ? { ...segment, status: 'cancelled', finishedAt: timestamp, lastError: '翻译已取消' } : segment) }, { expectedRevision: job.revision });
  }
  retry(jobId, { all = false } = {}) {
    let job = this.jobs.getById(jobId); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });
    if (job.status === 'running') {
      if (!isLeaseExpired(job.leaseUntil)) throw Object.assign(new Error('翻译任务已有有效 worker 正在运行。'), { code: 'JOB_ALREADY_RUNNING', status: 409 });
      job = this.jobs.recoverExpired(jobId, { reason: 'retry-after-expired-lease' }) || this.jobs.getById(jobId);
    }
    if (job.status === 'completed') {
      if (!all) return job;
      const segments = job.segments.map((segment) => ({ ...segment, status: 'pending', translatedText: '', error: '', issues: [], requestId: null, startedAt: null, finishedAt: null, lastError: '' }));
      const replacement = this.jobs.create({ title: job.title, sourceBlocks: job.sourceBlocks, targetLanguage: job.targetLanguage, model: job.model, ruleSetIds: job.ruleSetIds, validationMode: job.validationMode, segments, meta: { ...job.meta, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [] } });
      void this.run(replacement.id); return replacement;
    }
    const segments = job.segments.map((segment) => all || ['failed','cancelled'].includes(segment.status) ? { ...segment, status: 'pending', translatedText: all ? '' : segment.translatedText, error: '', lastError: '', issues: [], requestId: null, startedAt: null, finishedAt: null } : segment);
    if (job.status !== 'pending') assertJobTransition(job.status, 'pending');
    const updated = this.jobs.update(jobId, { status: 'pending', workerId: null, leaseUntil: null, lastError: '', segments, resultBlocks: all ? [] : job.resultBlocks, meta: all ? { ...job.meta, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [] } : job.meta }, { expectedRevision: job.revision });
    void this.run(jobId); return updated;
  }
  resume(jobId) {
    let job = this.jobs.getById(jobId); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });
    if (job.status === 'completed') return job;
    if (job.status === 'running') {
      if (!isLeaseExpired(job.leaseUntil)) { this.#scheduleRecovery(job); return job; }
      job = this.jobs.recoverExpired(jobId, { reason: 'resume-after-expired-lease' }) || this.jobs.getById(jobId);
    }
    if (['failed', 'cancelled'].includes(job.status)) return this.retry(jobId);
    if (job.status === 'pending') void this.run(jobId);
    return job;
  }
  publicJob(job) {
    if (!job) return null;
    const current = job.segments[Math.max(0, job.currentSegment - 1)];
    return { id: job.id, title: job.title, targetLanguage: job.targetLanguage, model: job.model, ruleSetIds: job.ruleSetIds, validationMode: job.validationMode, status: job.status, revision: job.revision, workerId: job.workerId, leaseUntil: job.leaseUntil, lastHeartbeatAt: job.lastHeartbeatAt, lastError: job.lastError, recoveryReason: job.recoveryReason, sourceBlocks: job.sourceBlocks, totalSegments: job.totalSegments, completedSegments: job.completedSegments, currentSegment: job.currentSegment, currentSegmentText: current?.sourceText || '', currentSegmentCharacters: current?.sourceText?.length || 0, failedSegments: job.segments.filter((item) => item.status === 'failed').length, remainingSegments: job.segments.filter((item) => !['completed'].includes(item.status)).length, resultBlocks: job.resultBlocks, meta: { ...job.meta, resolvedRules: undefined }, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt };
  }
  #context(segments, index) {
    return segments.slice(Math.max(0, index - 2), index).filter((item) => item.status === 'completed').map((item) => ({ source: item.sourceText, translation: item.translatedText }));
  }
  async #translateWithRetry({ jobId, workerId, index, client, signal, request }) {
    const maximumRetries = 1;
    for (let retryAttempt = 0; ; retryAttempt += 1) {
      try {
        const response = await client.translateSegment({ ...request, retryAttempt, signal });
        const shapeIssue = findTranslationShapeIssue(request.segment.text, response.translation);
        if (shapeIssue) throw Object.assign(new Error(shapeIssue.type === 'translation-too-long' ? 'AI 返回译文长度异常，已拒绝写入。' : 'AI 返回译文包含异常连续字符，已拒绝写入。'), { code: 'AI_TRANSLATION_SHAPE_INVALID', retryable: true, details: shapeIssue });
        return response;
      }
      catch (error) {
        if (!error?.retryable || retryAttempt >= maximumRetries || signal.aborted) {
          if (error?.retryable && retryAttempt >= maximumRetries) error.message = `${error.message}（已自动重试 ${maximumRetries} 次）`;
          throw error;
        }
        const job = this.jobs.getById(jobId);
        if (!job || job.status !== 'running' || job.workerId !== workerId) throw error;
        const segment = job.segments[index];
        if (!segment || segment.status !== 'translating') throw error;
        Object.assign(segment, { attempts: Number(segment.attempts || 0) + 1, requestId: randomUUID(), startedAt: new Date().toISOString(), lastError: error.message || 'AI 响应无效', error: '' });
        this.jobs.update(jobId, { segments: job.segments, currentSegment: index + 1 }, { expectedRevision: job.revision, expectedWorkerId: workerId });
      }
    }
  }
  #instructions(rules) { return rules.filter((rule) => ['style','background','format'].includes(rule.type)).map((rule) => rule.target || rule.note).filter(Boolean); }
  #scheduleRecovery(job) {
    if (this.recoveryTimers.has(job.id) || this.controllers.has(job.id)) return;
    const delay = Math.max(1, Date.parse(job.leaseUntil) - Date.now() + 5);
    const timer = setTimeout(() => { this.recoveryTimers.delete(job.id); this.resume(job.id); }, delay);
    timer.unref?.(); this.recoveryTimers.set(job.id, timer);
  }
  #clearRecoveryTimer(jobId) { const timer = this.recoveryTimers.get(jobId); if (timer) clearTimeout(timer); this.recoveryTimers.delete(jobId); }
}

function mergeUnique(target, values, key) {
  const seen = new Set(target.map((item) => key ? item[key] : item));
  for (const value of values || []) { const identity = key ? value[key] : value; if (!seen.has(identity)) { target.push(value); seen.add(identity); } }
}
