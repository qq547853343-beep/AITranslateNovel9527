import { TranslationProvider } from './application/ports.js';
import { buildLegacyTranslationMessages, buildRuleProposalMessages, buildTranslationMessages } from './ai/prompt-builder.js';
import { mapAIResponseError } from './ai/error-mapper.js';
import { parseStructuredAIResponse, parseTextAIResponse } from './ai/response-parser.js';

export class DeepSeekClient extends TranslationProvider {
  constructor({ apiKey, fetchImpl = fetch, model = 'deepseek-chat', endpoint = 'https://api.deepseek.com/chat/completions' }) {
    super(); this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.model = model; this.endpoint = endpoint;
  }
  async #complete(messages, { temperature = 0.1, signal, structured = true, maxTokens } = {}) {
    const body = { model: this.model, temperature, messages };
    if (structured) body.response_format = { type: 'json_object' };
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) });
    if (!response.ok) throw (await mapAIResponseError(response)).error;
    const data = await response.json();
    if (structured && data?.choices?.[0]?.finish_reason === 'length') {
      const contentLength = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content.length : 0;
      throw Object.assign(new Error('DeepSeek 输出达到长度上限，结构化 JSON 被截断。'), { code: 'AI_RESPONSE_TRUNCATED', retryable: true, contentLength, maxTokens });
    }
    return structured ? parseStructuredAIResponse(data) : parseTextAIResponse(data);
  }
  async translateSegment({ segment, targetLanguage, glossary, instructions, context, includeNotes = false, retryAttempt = 0, signal }) {
    const maxTokens = translationMaxTokens(segment.text);
    const parsed = await this.#complete(buildTranslationMessages({ segment, targetLanguage, glossary, instructions, context, includeNotes, retryAttempt }), { temperature: 0.1, signal, maxTokens });
    if (parsed.id !== segment.id || typeof parsed.translation !== 'string') throw new Error(`DeepSeek 未返回分段 ${segment.id} 的有效译文。`);
    return { translation: parsed.translation, notes: array(parsed.notes), decisionSummary: array(parsed.decisionSummary), uncertainties: array(parsed.uncertainties) };
  }
  async parseRuleInstruction({ instruction, ruleSet, relatedRules = [], signal }) {
    const parsed = await this.#complete(buildRuleProposalMessages({ instruction, ruleSet, relatedRules }), { temperature: 0, signal });
    return { operations: Array.isArray(parsed.operations) ? parsed.operations.slice(0, 100) : [] };
  }
  async translateText({ text, targetLanguage, signal }) {
    return this.#complete(buildLegacyTranslationMessages({ text, targetLanguage }), { temperature: 0.2, signal, structured: false });
  }
}

export function translationMaxTokens(text) {
  const characters = Array.from(String(text || '')).length;
  return Math.min(8192, Math.max(512, Math.ceil(characters * 1.6) + 256));
}

function array(value) { return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 50) : []; }
