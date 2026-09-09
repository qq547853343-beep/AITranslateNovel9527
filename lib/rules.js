const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();

export function collectRules(ruleSetRepository, ruleSetIds = []) {
  const sets = [];
  for (const id of [...new Set(ruleSetIds.map(String))].slice(0, 20)) {
    const ruleSet = ruleSetRepository.getById(id);
    if (ruleSet) sets.push(ruleSet);
  }
  const rules = sets.flatMap((ruleSet) => ruleSet.rules.filter((rule) => rule.enabled).map((rule) => ({ ...rule, ruleSetId: ruleSet.id, ruleSetName: ruleSet.name, ruleSetVersion: ruleSet.version, effectivePriority: ruleSet.priority * 100000 + rule.priority })));
  return { sets, rules };
}

export function resolveRuleConflicts(rules) {
  const selected = new Map(); const conflicts = [];
  for (const rule of [...rules].sort((a, b) => b.effectivePriority - a.effectivePriority || b.source.length - a.source.length)) {
    const key = `${rule.type}:${normalize(rule.source)}`;
    if (!normalize(rule.source)) continue;
    const existing = selected.get(key);
    if (!existing) { selected.set(key, rule); continue; }
    if (normalize(existing.target) === normalize(rule.target)) continue;
    if (existing.effectivePriority === rule.effectivePriority) conflicts.push({ source: rule.source, type: rule.type, rules: [existing, rule] });
  }
  return { rules: [...selected.values()], conflicts };
}

export function matchRules(text, rules) {
  const normalizedText = normalize(text);
  return rules.filter((rule) => {
    if (rule.sendMode === 'always') return true;
    if (rule.sendMode === 'manual') return false;
    if (['style', 'background', 'format'].includes(rule.type) && rule.sendMode !== 'matched') return true;
    return [rule.source, ...(rule.aliases || [])].some((term) => term && normalizedText.includes(normalize(term)));
  }).sort((a, b) => b.source.length - a.source.length || b.effectivePriority - a.effectivePriority);
}

export function validateTranslation(source, translation, matchedRules) {
  const issues = [];
  for (const rule of matchedRules) {
    if (rule.source && source.includes(rule.source) && rule.target && !translation.includes(rule.target) && !['style','background','format'].includes(rule.type)) {
      issues.push({ type: 'missing-required-term', ruleId: rule.id, source: rule.source, expected: rule.target });
    }
    for (const forbidden of rule.forbidden || []) if (forbidden && translation.includes(forbidden)) issues.push({ type: 'forbidden-translation', ruleId: rule.id, source: rule.source, forbidden });
  }
  return issues;
}
