import { TranslationProvider } from './application/ports.js';
import { buildLegacyTranslationMessages, buildRuleProposalMessages, buildTranslationMessages } from './ai/prompt-builder.js';
import { mapAIResponseError } from './ai/error-mapper.js';
import { parseStructuredAIResponse, parseTextAIResponse } from './ai/response-parser.js';
import { readDeepSeekEventStream, extractPartialTranslation } from './infrastructure/deepseek-stream.js';
import { normalizeTokenUsage } from './domain/token-usage.js';

export class DeepSeekClient extends TranslationProvider {
  constructor({ apiKey, fetchImpl = fetch, model = 'deepseek-chat', endpoint = 'https://api.deepseek.com/chat/completions', balanceEndpoint = 'https://api.deepseek.com/user/balance', onUsage } = {}) {
    super(); this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.model = model; this.endpoint = endpoint; this.balanceEndpoint = balanceEndpoint; this.onUsage = onUsage;
  }
  async #complete(messages, { temperature = 0.1, signal, structured = true, maxTokens, operation = 'completion' } = {}) {
    const body = { model: this.model, temperature, messages };
    if (structured) body.response_format = { type: 'json_object' };
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) });
    if (!response.ok) throw (await mapAIResponseError(response)).error;
    const data = await response.json();
    const usage = this.#recordUsage(data?.usage, { model: data?.model, operation });
    if (structured && data?.choices?.[0]?.finish_reason === 'length') {
      const contentLength = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content.length : 0;
      throw Object.assign(new Error('DeepSeek 输出达到长度上限，结构化 JSON 被截断。'), { code: 'AI_RESPONSE_TRUNCATED', retryable: true, contentLength, maxTokens, usage });
    }
    try { return structured ? parseStructuredAIResponse(data) : parseTextAIResponse(data); }
    catch (error) { if (usage.requestCount) error.usage = usage; throw error; }
  }
  async #streamStructured(messages, { temperature = 0.1, signal, maxTokens, operation = 'translation', onProgress } = {}) {
    const body = { model: this.model, temperature, messages, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } };
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) });
    if (!response.ok) throw (await mapAIResponseError(response)).error;
    const data = await readDeepSeekEventStream(response, {
      onContent: (content) => {
        const partial = extractPartialTranslation(content);
        if (partial.found) onProgress?.({ translation: partial.value, complete: partial.complete });
      },
    });
    const usage = this.#recordUsage(data?.usage, { model: data?.model, operation });
    if (data?.choices?.[0]?.finish_reason === 'length') {
      const contentLength = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content.length : 0;
      throw Object.assign(new Error('DeepSeek 输出达到长度上限，结构化 JSON 被截断。'), { code: 'AI_RESPONSE_TRUNCATED', retryable: true, contentLength, maxTokens, usage });
    }
    try { return { parsed: parseStructuredAIResponse(data), usage, providerModel: data?.model || this.model }; }
    catch (error) { if (usage.requestCount) error.usage = usage; throw error; }
  }
  async translateSegment({ segment, targetLanguage, glossary, instructions, context, includeNotes = false, retryAttempt = 0, signal, onProgress }) {
    const maxTokens = translationMaxTokens(segment.text);
    const { parsed, usage, providerModel } = await this.#streamStructured(buildTranslationMessages({ segment, targetLanguage, glossary, instructions, context, includeNotes, retryAttempt }), { temperature: 0.1, signal, maxTokens, onProgress });
    if (parsed.id !== segment.id || typeof parsed.translation !== 'string') throw Object.assign(new Error(`DeepSeek 未返回分段 ${segment.id} 的有效译文。`), { code: 'AI_RESPONSE_INVALID', retryable: true, usage });
    return { translation: parsed.translation, notes: array(parsed.notes), decisionSummary: array(parsed.decisionSummary), uncertainties: array(parsed.uncertainties), usage, providerModel };
  }
  async parseRuleInstruction({ instruction, ruleSet, relatedRules = [], signal }) {
    const parsed = await this.#complete(buildRuleProposalMessages({ instruction, ruleSet, relatedRules }), { temperature: 0, signal, operation: 'rule-proposal' });
    return { operations: Array.isArray(parsed.operations) ? parsed.operations.slice(0, 100) : [] };
  }
  async translateText({ text, targetLanguage, signal }) {
    return this.#complete(buildLegacyTranslationMessages({ text, targetLanguage }), { temperature: 0.2, signal, structured: false, operation: 'legacy-translation' });
  }
  async getBalance({ signal } = {}) {
    const response = await this.fetchImpl(this.balanceEndpoint, { method: 'GET', signal, headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}` } });
    if (!response.ok) throw (await mapAIResponseError(response)).error;
    const data = await response.json();
    const balanceInfos = Array.isArray(data?.balance_infos) ? data.balance_infos.slice(0, 10).map((item) => ({
      currency: String(item?.currency || '').slice(0, 12),
      totalBalance: money(item?.total_balance),
      grantedBalance: money(item?.granted_balance),
      toppedUpBalance: money(item?.topped_up_balance),
    })).filter((item) => item.currency) : [];
    return { isAvailable: Boolean(data?.is_available), balanceInfos, updatedAt: new Date().toISOString() };
  }
  #recordUsage(value, details) {
    const usage = normalizeTokenUsage(value);
    if (usage.requestCount) this.onUsage?.(usage, { ...details, model: details.model || this.model });
    return usage;
  }
}

export function translationMaxTokens(text) {
  const characters = Array.from(String(text || '')).length;
  return Math.min(8192, Math.max(512, Math.ceil(characters * 1.6) + 256));
}

function array(value) { return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 50) : []; }
function money(value) { const text = String(value ?? '0'); return /^-?\d+(?:\.\d{1,12})?$/.test(text) ? text : '0'; }
