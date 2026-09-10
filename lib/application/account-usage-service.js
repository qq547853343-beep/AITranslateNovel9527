export class AccountUsageService {
  constructor({ providerFactory, sessionUsageTracker }) { this.providerFactory = providerFactory; this.sessionUsageTracker = sessionUsageTracker; }
  async getBalance({ signal } = {}) { const provider = await this.providerFactory(); return provider.getBalance({ signal }); }
  getSessionUsage() { return this.sessionUsageTracker.snapshot(); }
}
