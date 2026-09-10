const pricingPerMillionUsd = Object.freeze({
  flash: Object.freeze({ cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 }),
  pro: Object.freeze({ cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 }),
});

export function normalizeTokenUsage(input = {}) {
  const promptTokens = count(input.promptTokens ?? input.prompt_tokens);
  const completionTokens = count(input.completionTokens ?? input.completion_tokens);
  const totalTokens = count(input.totalTokens ?? input.total_tokens) || promptTokens + completionTokens;
  const promptCacheHitTokens = count(input.promptCacheHitTokens ?? input.prompt_cache_hit_tokens);
  const suppliedMiss = input.promptCacheMissTokens ?? input.prompt_cache_miss_tokens;
  const promptCacheMissTokens = suppliedMiss == null ? Math.max(0, promptTokens - promptCacheHitTokens) : count(suppliedMiss);
  const requestCount = count(input.requestCount) || (totalTokens || promptTokens || completionTokens ? 1 : 0);
  return { promptTokens, completionTokens, totalTokens, promptCacheHitTokens, promptCacheMissTokens, requestCount };
}

export function mergeTokenUsage(current = {}, addition = {}) {
  const left = normalizeTokenUsage(current); const right = normalizeTokenUsage(addition);
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    promptCacheHitTokens: left.promptCacheHitTokens + right.promptCacheHitTokens,
    promptCacheMissTokens: left.promptCacheMissTokens + right.promptCacheMissTokens,
    requestCount: left.requestCount + right.requestCount,
  };
}

export function summarizeTokenUsage(usage = {}, model = 'deepseek-chat') {
  const normalized = normalizeTokenUsage(usage);
  const pricingModel = /(?:v4-)?pro/i.test(String(model)) ? 'pro' : 'flash';
  const rates = pricingPerMillionUsd[pricingModel];
  const estimatedCostUsd = (
    normalized.promptCacheHitTokens * rates.cacheHitInput
    + normalized.promptCacheMissTokens * rates.cacheMissInput
    + normalized.completionTokens * rates.output
  ) / 1_000_000;
  return { ...normalized, estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)), pricingModel, pricingVersion: '2026-09-10' };
}

function count(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
