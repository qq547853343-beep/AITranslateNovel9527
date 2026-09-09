export class TranslationProvider {
  async translateSegment() { throw new Error('TranslationProvider.translateSegment must be implemented.'); }
  async translateText() { throw new Error('TranslationProvider.translateText must be implemented.'); }
}

export class RuleProposalProvider {
  async parseRuleInstruction() { throw new Error('RuleProposalProvider.parseRuleInstruction must be implemented.'); }
}
