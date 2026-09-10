import { mergeTokenUsage, summarizeTokenUsage } from '../domain/token-usage.js';

export class SessionUsageTracker {
  constructor({ startedAt = new Date().toISOString() } = {}) { this.startedAt = startedAt; this.updatedAt = null; this.usage = {}; this.model = 'deepseek-chat'; }
  record(usage, { model } = {}) {
    this.usage = mergeTokenUsage(this.usage, usage); this.model = model || this.model; this.updatedAt = new Date().toISOString();
    return this.snapshot();
  }
  snapshot() { return { startedAt: this.startedAt, updatedAt: this.updatedAt, usage: summarizeTokenUsage(this.usage, this.model) }; }
}
