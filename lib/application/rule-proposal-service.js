import { normalizeRuleOperations, prepareRuleOperations } from '../domain/rule-operations.js';

export class RuleProposalService {
  constructor({ ruleSetRepository, providerFactory }) { this.ruleSets = ruleSetRepository; this.providerFactory = providerFactory; }

  async propose({ ruleSetId, instruction: input }) {
    const instruction = String(input || '').trim().slice(0, 10000);
    if (!instruction) throw Object.assign(new Error('请输入规则描述。'), { status: 400 });
    const ruleSet = this.ruleSets.getById(ruleSetId);
    if (!ruleSet) throw Object.assign(new Error('请先选择规则集。'), { status: 400 });
    const relatedRules = ruleSet.rules.filter((rule) => [rule.source, ...(rule.aliases || [])].some((term) => term && instruction.includes(term))).slice(0, 50);
    const provider = await this.providerFactory();
    const proposal = await provider.parseRuleInstruction({ instruction, ruleSet, relatedRules });
    return { ...proposal, operations: normalizeRuleOperations(proposal.operations, ruleSet.rules) };
  }

  apply({ ruleSetId, operations }) {
    const ruleSet = this.ruleSets.getById(ruleSetId);
    if (!ruleSet) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    return this.ruleSets.applyOperations(ruleSetId, prepareRuleOperations(operations, ruleSet.rules));
  }
}
