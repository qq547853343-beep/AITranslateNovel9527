import { collectRules, matchRules, resolveRuleConflicts, validateTranslation } from './rules.js';
import { compressExpressiveRuns, findTranslationShapeIssue, mergeTranslatedBlocks, protectPlaceholders, restorePlaceholders, segmentDocumentBlocks } from './text-processing.js';
import { randomUUID } from 'node:crypto';
import { assertJobTransition, assertSegmentTransition, isLeaseExpired } from './domain/translation-state.js';
import { mergeTokenUsage, summarizeTokenUsage } from './domain/token-usage.js';

export class TranslationService {
  constructor({ jobRepository, ruleSetRepository, clientFactory, leaseMs = 120000, heartbeatMs = 30000 }) {
    this.jobs = jobRepository; this.ruleSets = ruleSetRepository; this.clientFactory = clientFactory; this.controllers = new Map(); this.recoveryTimers = new Map(); this.liveStates = new Map(); this.liveEmitTimes = new Map(); this.listeners = new Map(); this.leaseMs = leaseMs; this.heartbeatMs = heartbeatMs;
  }
  prepare({ title, blocks, targetLanguage, ruleSetIds = [], temporaryRules = [], validationMode = 'warning', includeNotes = false }) {
    const collected = collectRules(this.ruleSets, ruleSetIds);
    const temporary = temporaryRules.map((rule, index) => ({ ...rule, id: rule.id || `temporary-${index}`, ruleSetId: 'temporary', ruleSetName: '本次临时规则', ruleSetVersion: 1, enabled: true, effectivePriority: 1_000_000_000 + (Number(rule.priority) || 0) }));
    const resolved = resolveRuleConflicts([...temporary, ...collected.rules]);
    if (resolved.conflicts.length) throw Object.assign(new Error('存在同优先级规则冲突，请先处理。'), { status: 409, details: resolved.conflicts });
    const segments = segmentDocumentBlocks(blocks);
    if (!segments.length) throw Object.assign(new Error('文档中没有可翻译的文字。'), { status: 400 });
    return this.jobs.create({ title, sourceBlocks: blocks, targetLanguage, model: 'deepseek-chat', ruleSetIds, validationMode, segments, meta: { ruleSets: collected.sets.map(({ id, name, version }) => ({ id, name, version })), resolvedRules: resolved.rules, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [], includeNotes, retries: 0, usage: summarizeTokenUsage({}, 'deepseek-chat') } });
  }
  subscribe(jobId, listener) {
    if (typeof listener !== 'function') return () => {};
    const listeners = this.listeners.get(jobId) || new Set(); listeners.add(listener); this.listeners.set(jobId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(jobId); };
  }
  getLiveState(jobId) { const state = this.liveStates.get(jobId); return state ? { ...state } : null; }
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
        if (segment.status !== 'pending') continue;
        assertSegmentTransition('pending', 'translating');
        Object.assign(segment, { status: 'translating', error: '', lastError: '', attempts: Number(segment.attempts || 0) + 1, requestId: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null });
        job = this.jobs.update(jobId, { status: 'running', currentSegment: index + 1, segments: job.segments }, { expectedRevision: job.revision, expectedWorkerId: workerId });
        this.#setLive(jobId, { active: true, currentSegment: index + 1, segmentId: segment.id, status: 'translating', translation: '', retryAttempt: 0 });
        this.#emitJob(job);
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
            job = this.jobs.update(jobId, { segments: job.segments }, { expectedRevision: job.revision, expectedWorkerId: workerId }); this.#clearLive(jobId, 'retrying'); this.#emitJob(job); index -= 1;
          } else {
            assertSegmentTransition(currentSegment.status, 'completed');
            Object.assign(currentSegment, { translatedText: restored.text, issues, status: 'completed', finishedAt: new Date().toISOString(), lastError: '', error: '' });
            mergeUnique(job.meta.appliedRules, matched, 'id');
            job.meta.validationIssues.push(...issues.map((issue) => ({ ...issue, segmentId: currentSegment.id })));
            mergeUnique(job.meta.notes, response.notes); mergeUnique(job.meta.decisionSummary, response.decisionSummary); mergeUnique(job.meta.uncertainties, response.uncertainties);
            job = this.jobs.update(jobId, { segments: job.segments, resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), meta: job.meta, currentSegment: index + 1 }, { expectedRevision: job.revision, expectedWorkerId: workerId });
            this.#clearLive(jobId, 'completed'); this.#emitJob(job);
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
            const cancelled = this.jobs.update(jobId, { status: 'cancelled', segments: job.segments, workerId: null, leaseUntil: null, lastError: '' }, { expectedRevision: job.revision, expectedWorkerId: workerId });
            this.#clearLive(jobId, 'cancelled'); this.#emitJob(cancelled); return cancelled;
          }
          if (currentSegment.status === 'translating') assertSegmentTransition(currentSegment.status, 'failed');
          Object.assign(currentSegment, { status: 'failed', finishedAt: new Date().toISOString(), lastError: error.message || '翻译失败', error: error.message || '翻译失败' });
          assertJobTransition(job.status, 'failed');
          const failed = this.jobs.update(jobId, { status: 'failed', segments: job.segments, meta: job.meta, currentSegment: index + 1, workerId: null, leaseUntil: null, lastError: currentSegment.lastError }, { expectedRevision: job.revision, expectedWorkerId: workerId }); this.#clearLive(jobId, 'failed'); this.#emitJob(failed); return;
        }
      }
      job = this.jobs.getById(jobId);
      if (job?.status === 'running' && job.workerId === workerId && job.segments.every((segment) => segment.status === 'completed')) {
        assertJobTransition(job.status, 'completed');
        const completed = this.jobs.update(jobId, { status: 'completed', resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), currentSegment: job.segments.length, workerId: null, leaseUntil: null, lastError: '' }, { expectedRevision: job.revision, expectedWorkerId: workerId }); this.#clearLive(jobId, 'completed'); this.#emitJob(completed); return completed;
      }
      if (job?.status === 'running' && job.workerId === workerId && !job.segments.some((segment) => ['pending', 'translating'].includes(segment.status))) {
        const failedSegment = job.segments.find((segment) => segment.status === 'failed'); const targetStatus = failedSegment ? 'failed' : 'cancelled'; assertJobTransition(job.status, targetStatus);
        const stopped = this.jobs.update(jobId, { status: targetStatus, resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), workerId: null, leaseUntil: null, lastError: failedSegment?.lastError || '' }, { expectedRevision: job.revision, expectedWorkerId: workerId }); this.#clearLive(jobId, targetStatus); this.#emitJob(stopped); return stopped;
      }
    } catch (error) {
      const job = this.jobs.getById(jobId);
      if (error.code !== 'JOB_CONCURRENCY_CONFLICT' && job?.status === 'running' && job.workerId === workerId) {
        try { assertJobTransition(job.status, 'failed'); const failed = this.jobs.update(jobId, { status: 'failed', workerId: null, leaseUntil: null, lastError: error.message || '翻译任务失败', meta: { ...job.meta, lastError: error.message || '翻译任务失败' } }, { expectedRevision: job.revision, expectedWorkerId: workerId }); this.#clearLive(jobId, 'failed'); this.#emitJob(failed); } catch {}
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
    const cancelled = this.jobs.update(jobId, { status: 'cancelled', workerId: null, leaseUntil: null, lastError: '', segments: job.segments.map((segment) => segment.status === 'translating' ? { ...segment, status: 'cancelled', finishedAt: timestamp, lastError: '翻译已取消' } : segment) }, { expectedRevision: job.revision });
    this.#clearLive(jobId, 'cancelled'); this.#emitJob(cancelled); return cancelled;
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
      const replacement = this.jobs.create({ title: job.title, sourceBlocks: job.sourceBlocks, targetLanguage: job.targetLanguage, model: job.model, ruleSetIds: job.ruleSetIds, validationMode: job.validationMode, segments, meta: { ...job.meta, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [], usage: summarizeTokenUsage({}, job.model) } });
      void this.run(replacement.id); return replacement;
    }
    const segments = job.segments.map((segment) => all || ['failed','cancelled'].includes(segment.status) ? { ...segment, status: 'pending', translatedText: all ? '' : segment.translatedText, error: '', lastError: '', issues: [], requestId: null, startedAt: null, finishedAt: null } : segment);
    if (job.status !== 'pending') assertJobTransition(job.status, 'pending');
    const updated = this.jobs.update(jobId, { status: 'pending', workerId: null, leaseUntil: null, lastError: '', segments, resultBlocks: all ? [] : job.resultBlocks, meta: all ? { ...job.meta, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [] } : job.meta }, { expectedRevision: job.revision });
    void this.run(jobId); return updated;
  }
  retrySegment(jobId, segmentId) {
    let job = this.jobs.getById(jobId); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });
    if (job.status === 'running') {
      if (!isLeaseExpired(job.leaseUntil)) throw Object.assign(new Error('翻译任务已有有效 worker 正在运行。'), { code: 'JOB_ALREADY_RUNNING', status: 409 });
      job = this.jobs.recoverExpired(jobId, { reason: 'segment-retry-after-expired-lease' }) || this.jobs.getById(jobId);
    }
    const index = job.segments.findIndex((segment) => segment.id === segmentId);
    if (index < 0) throw Object.assign(new Error('翻译分段不存在。'), { status: 404, code: 'TRANSLATION_SEGMENT_NOT_FOUND' });
    const segment = job.segments[index];
    if (!['failed', 'cancelled'].includes(segment.status)) throw Object.assign(new Error('只有失败或已取消的分段可以单独重试。'), { status: 409, code: 'TRANSLATION_SEGMENT_NOT_RETRYABLE' });
    job.segments[index] = { ...segment, status: 'pending', translatedText: '', error: '', lastError: '', issues: [], requestId: null, startedAt: null, finishedAt: null };
    if (job.status !== 'pending') assertJobTransition(job.status, 'pending');
    const meta = { ...job.meta, validationIssues: (job.meta.validationIssues || []).filter((issue) => issue.segmentId !== segmentId) };
    const updated = this.jobs.update(jobId, { status: 'pending', workerId: null, leaseUntil: null, lastError: '', segments: job.segments, resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), meta }, { expectedRevision: job.revision });
    this.#emitJob(updated); void this.run(jobId); return updated;
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
    const currentIndex = Math.max(0, job.currentSegment - 1); const current = job.segments[currentIndex];
    const nearby = job.segments.slice(Math.max(0, currentIndex - 2), Math.min(job.segments.length, currentIndex + 3)).map((segment, offset) => ({ index: Math.max(0, currentIndex - 2) + offset + 1, id: segment.id, status: segment.status, attempts: Number(segment.attempts || 0) }));
    const failedSegmentDetails = job.segments.map((segment, index) => ({ segment, index })).filter(({ segment }) => segment.status === 'failed').map(({ segment, index }) => ({ index: index + 1, id: segment.id, blockIndex: segment.blockIndex, partIndex: segment.partIndex, status: segment.status, attempts: Number(segment.attempts || 0), lastError: segment.lastError || segment.error || '', sourceText: String(segment.sourceText || '').slice(0, 5000) }));
    return { id: job.id, title: job.title, targetLanguage: job.targetLanguage, model: job.model, ruleSetIds: job.ruleSetIds, validationMode: job.validationMode, status: job.status, revision: job.revision, workerId: job.workerId, leaseUntil: job.leaseUntil, lastHeartbeatAt: job.lastHeartbeatAt, lastError: job.lastError, recoveryReason: job.recoveryReason, sourceBlocks: job.sourceBlocks, totalSegments: job.totalSegments, completedSegments: job.completedSegments, currentSegment: job.currentSegment, currentSegmentText: current?.sourceText || '', currentSegmentCharacters: current?.sourceText?.length || 0, currentSegmentStatus: current?.status || '', failedSegments: failedSegmentDetails.length, failedSegmentDetails, recentSegments: nearby, remainingSegments: job.segments.filter((item) => !['completed'].includes(item.status)).length, resultBlocks: job.resultBlocks, live: this.getLiveState(job.id), meta: { ...job.meta, resolvedRules: undefined }, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt };
  }
  #context(segments, index) {
    return segments.slice(Math.max(0, index - 2), index).filter((item) => item.status === 'completed').map((item) => ({ source: item.sourceText, translation: item.translatedText }));
  }
  async #translateWithRetry({ jobId, workerId, index, client, signal, request }) {
    const maximumRetries = 1;
    for (let retryAttempt = 0; ; retryAttempt += 1) {
      try {
        const response = await client.translateSegment({ ...request, retryAttempt, signal, onProgress: (partial) => this.#setLive(jobId, { active: true, currentSegment: index + 1, segmentId: request.segment.id, status: 'translating', translation: partial.translation, retryAttempt }, { force: partial.complete }) });
        if (response.usage?.requestCount) this.#recordTaskUsage(jobId, workerId, response.usage, response.providerModel);
        const shapeIssue = findTranslationShapeIssue(request.segment.text, response.translation);
        if (shapeIssue) throw Object.assign(new Error(shapeIssue.type === 'translation-too-long' ? 'AI 返回译文长度异常，已拒绝写入。' : 'AI 返回译文包含异常连续字符，已拒绝写入。'), { code: 'AI_TRANSLATION_SHAPE_INVALID', retryable: true, details: shapeIssue });
        return response;
      }
      catch (error) {
        if (error?.usage?.requestCount) this.#recordTaskUsage(jobId, workerId, error.usage, client.model);
        if (!error?.retryable || retryAttempt >= maximumRetries || signal.aborted) {
          if (error?.retryable && retryAttempt >= maximumRetries) error.message = `${error.message}（已自动重试 ${maximumRetries} 次）`;
          throw error;
        }
        const job = this.jobs.getById(jobId);
        if (!job || job.status !== 'running' || job.workerId !== workerId) throw error;
        const segment = job.segments[index];
        if (!segment || segment.status !== 'translating') throw error;
        Object.assign(segment, { attempts: Number(segment.attempts || 0) + 1, requestId: randomUUID(), startedAt: new Date().toISOString(), lastError: error.message || 'AI 响应无效', error: '' });
        const updated = this.jobs.update(jobId, { segments: job.segments, currentSegment: index + 1 }, { expectedRevision: job.revision, expectedWorkerId: workerId });
        this.#setLive(jobId, { active: true, currentSegment: index + 1, segmentId: request.segment.id, status: 'retrying', translation: '', retryAttempt: retryAttempt + 1 }, { force: true }); this.#emitJob(updated);
      }
    }
  }
  #recordTaskUsage(jobId, workerId, usage, model) {
    const job = this.jobs.getById(jobId);
    if (!job || job.status !== 'running' || job.workerId !== workerId) return null;
    const merged = mergeTokenUsage(job.meta?.usage, usage); const meta = { ...job.meta, usage: summarizeTokenUsage(merged, model || job.model) };
    return this.jobs.update(jobId, { meta }, { expectedRevision: job.revision, expectedWorkerId: workerId });
  }
  #setLive(jobId, changes, { force = false } = {}) {
    const state = { ...(this.liveStates.get(jobId) || {}), ...changes, updatedAt: new Date().toISOString() }; this.liveStates.set(jobId, state);
    const timestamp = Date.now(); const last = this.liveEmitTimes.get(jobId) || 0;
    if (force || timestamp - last >= 80) { this.liveEmitTimes.set(jobId, timestamp); this.#emit(jobId, 'partial', { ...state }); }
  }
  #clearLive(jobId, status) {
    const current = this.liveStates.get(jobId); this.liveStates.delete(jobId); this.liveEmitTimes.delete(jobId);
    if (current) this.#emit(jobId, 'partial', { ...current, active: false, status, updatedAt: new Date().toISOString() });
  }
  #emitJob(job) { if (job) this.#emit(job.id, 'job', this.publicJob(job)); }
  #emit(jobId, event, payload) { for (const listener of this.listeners.get(jobId) || []) { try { listener({ event, payload }); } catch {} } }
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
