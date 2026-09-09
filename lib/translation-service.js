import { collectRules, matchRules, resolveRuleConflicts, validateTranslation } from './rules.js';
import { mergeTranslatedBlocks, protectPlaceholders, restorePlaceholders, segmentDocumentBlocks } from './text-processing.js';

export class TranslationService {
  constructor({ jobRepository, ruleSetRepository, clientFactory }) {
    this.jobs = jobRepository; this.ruleSets = ruleSetRepository; this.clientFactory = clientFactory; this.controllers = new Map();
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
    if (this.controllers.has(jobId)) return;
    const controller = new AbortController(); this.controllers.set(jobId, controller);
    try {
      let job = this.jobs.getById(jobId); if (!job) return;
      job = this.jobs.update(jobId, { status: 'running' });
      const client = await this.clientFactory();
      for (let index = 0; index < job.segments.length; index += 1) {
        job = this.jobs.getById(jobId);
        if (controller.signal.aborted || job.status === 'cancelled') break;
        const segment = job.segments[index];
        if (segment.status === 'completed') continue;
        segment.status = 'translating'; segment.error = '';
        this.jobs.update(jobId, { status: 'running', currentSegment: index + 1, segments: job.segments });
        try {
          const context = this.#context(job.segments, index);
          const matched = matchRules([segment.sourceText, ...context.map((item) => item.source)].join('\n'), job.meta.resolvedRules || []);
          const protectedSource = protectPlaceholders(segment.sourceText);
          const response = await client.translateSegment({ segment: { id: segment.id, text: protectedSource.text }, targetLanguage: job.targetLanguage, glossary: matched, instructions: this.#instructions(job.meta.resolvedRules || []), context, includeNotes: Boolean(job.meta.includeNotes), signal: controller.signal });
          const restored = restorePlaceholders(response.translation, protectedSource.values);
          const issues = [...restored.issues, ...validateTranslation(segment.sourceText, restored.text, matched)];
          if (job.validationMode === 'strict' && issues.length && segment.retries < 2) {
            segment.retries += 1; job.meta.retries = Number(job.meta.retries || 0) + 1; segment.status = 'pending'; index -= 1;
          } else {
            segment.translatedText = restored.text; segment.issues = issues; segment.status = 'completed';
            mergeUnique(job.meta.appliedRules, matched, 'id');
            job.meta.validationIssues.push(...issues.map((issue) => ({ ...issue, segmentId: segment.id })));
            mergeUnique(job.meta.notes, response.notes); mergeUnique(job.meta.decisionSummary, response.decisionSummary); mergeUnique(job.meta.uncertainties, response.uncertainties);
          }
          this.jobs.update(jobId, { segments: job.segments, resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), meta: job.meta, currentSegment: index + 1 });
        } catch (error) {
          if (controller.signal.aborted || error.name === 'AbortError') { segment.status = 'cancelled'; this.jobs.update(jobId, { status: 'cancelled', segments: job.segments }); break; }
          segment.status = 'failed'; segment.error = error.message || '翻译失败';
          this.jobs.update(jobId, { status: 'failed', segments: job.segments, meta: job.meta, currentSegment: index + 1 }); return;
        }
      }
      job = this.jobs.getById(jobId);
      if (job.status !== 'cancelled' && job.segments.every((segment) => segment.status === 'completed')) {
        this.jobs.update(jobId, { status: 'completed', resultBlocks: mergeTranslatedBlocks(job.sourceBlocks, job.segments), currentSegment: job.segments.length });
      }
    } catch (error) {
      const job = this.jobs.getById(jobId);
      if (job && job.status !== 'cancelled') this.jobs.update(jobId, { status: 'failed', meta: { ...job.meta, lastError: error.message || '翻译任务失败' } });
    } finally { this.controllers.delete(jobId); }
  }
  cancel(jobId) {
    const controller = this.controllers.get(jobId); if (controller) controller.abort();
    const job = this.jobs.getById(jobId); if (!job) return null;
    return this.jobs.update(jobId, { status: 'cancelled', segments: job.segments.map((segment) => segment.status === 'translating' ? { ...segment, status: 'cancelled' } : segment) });
  }
  retry(jobId, { all = false } = {}) {
    const job = this.jobs.getById(jobId); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });
    const segments = job.segments.map((segment) => all || ['failed','cancelled'].includes(segment.status) ? { ...segment, status: 'pending', translatedText: all ? '' : segment.translatedText, error: '', issues: [] } : segment);
    const updated = this.jobs.update(jobId, { status: 'pending', segments, resultBlocks: all ? [] : job.resultBlocks, meta: all ? { ...job.meta, appliedRules: [], validationIssues: [], notes: [], decisionSummary: [], uncertainties: [] } : job.meta });
    void this.run(jobId); return updated;
  }
  publicJob(job) {
    if (!job) return null;
    const current = job.segments[Math.max(0, job.currentSegment - 1)];
    return { id: job.id, title: job.title, targetLanguage: job.targetLanguage, model: job.model, ruleSetIds: job.ruleSetIds, validationMode: job.validationMode, status: job.status, sourceBlocks: job.sourceBlocks, totalSegments: job.totalSegments, completedSegments: job.completedSegments, currentSegment: job.currentSegment, currentSegmentText: current?.sourceText || '', currentSegmentCharacters: current?.sourceText?.length || 0, failedSegments: job.segments.filter((item) => item.status === 'failed').length, remainingSegments: job.segments.filter((item) => !['completed'].includes(item.status)).length, resultBlocks: job.resultBlocks, meta: { ...job.meta, resolvedRules: undefined }, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt };
  }
  #context(segments, index) {
    return segments.slice(Math.max(0, index - 2), index).filter((item) => item.status === 'completed').map((item) => ({ source: item.sourceText, translation: item.translatedText }));
  }
  #instructions(rules) { return rules.filter((rule) => ['style','background','format'].includes(rule.type)).map((rule) => rule.target || rule.note).filter(Boolean); }
}

function mergeUnique(target, values, key) {
  const seen = new Set(target.map((item) => key ? item[key] : item));
  for (const value of values || []) { const identity = key ? value[key] : value; if (!seen.has(identity)) { target.push(value); seen.add(identity); } }
}
