const ruleTypes = new Set(['term', 'person', 'place', 'organization', 'skill', 'style', 'title', 'forbidden', 'format', 'background', 'temporary']);
const actions = new Set(['add', 'update', 'disable', 'delete']);
const sendModes = new Set(['matched', 'always', 'contextual', 'manual']);
const instructionTypes = new Set(['style', 'background', 'format']);

export function normalizeRuleOperations(input, existingRules = []) {
  const rulesById = new Map(existingRules.map((rule) => [String(rule.id), rule]));
  const values = Array.isArray(input) ? input.slice(0, 100) : [];
  return values.map((raw, index) => normalizeOperation(raw, index, rulesById));
}

export function prepareRuleOperations(input, existingRules = []) {
  const candidates = normalizeRuleOperations(input, existingRules);
  const invalid = candidates.filter((operation) => !operation.valid);
  if (invalid.length) {
    throw Object.assign(new Error(`有 ${invalid.length} 条候选规则不完整，请重新解析或修改规则描述。`), {
      code: 'RULE_OPERATION_INVALID',
      status: 400,
      details: invalid.map((operation) => ({ index: operation.index, action: operation.action, type: operation.type, source: operation.source, message: operation.validationError })),
    });
  }
  return candidates.map(({ valid: _valid, validationError: _error, index: _index, ...operation }) => operation);
}

function normalizeOperation(rawValue, index, rulesById) {
  const raw = plainObject(rawValue) ? rawValue : {};
  const action = clean(raw.action, 20);
  const ruleId = clean(raw.ruleId, 80);
  if (!actions.has(action)) return invalidCandidate({ action, index }, '候选操作类型无效。');

  const existing = ruleId ? rulesById.get(ruleId) : null;
  if (action !== 'add' && !ruleId) return invalidCandidate({ action, index }, '修改、停用或删除操作缺少规则 ID。');
  if (action !== 'add' && !existing) return invalidCandidate({ action, ruleId, index }, '目标规则不存在，可能已被修改或删除。');
  if (action === 'disable' || action === 'delete') {
    return validCandidate({ action, ruleId, type: existing.type, source: existing.source, target: existing.target, reason: clean(raw.reason, 500), index });
  }

  const isUpdate = action === 'update';
  const type = ruleTypes.has(clean(raw.type, 40)) ? clean(raw.type, 40) : isUpdate ? existing.type : '';
  if (!ruleTypes.has(type)) return invalidCandidate({ action, ruleId, type, index }, '规则类型无效或缺失。');
  const operation = {
    action,
    ...(ruleId ? { ruleId } : {}),
    type,
    source: meaningful(raw.source, isUpdate ? existing.source : '', 300),
    target: meaningful(raw.target, isUpdate ? existing.target : '', 300),
    aliases: meaningfulList(raw.aliases, isUpdate ? existing.aliases : []),
    forbidden: meaningfulList(raw.forbidden, isUpdate ? existing.forbidden : []),
    category: meaningful(raw.category, isUpdate ? existing.category : '', 80),
    sendMode: sendModes.has(raw.sendMode) ? raw.sendMode : isUpdate ? existing.sendMode : instructionTypes.has(type) ? 'always' : 'matched',
    note: meaningful(raw.note, isUpdate ? existing.note : '', 500),
    priority: Number.isFinite(Number(raw.priority)) ? Math.max(-10000, Math.min(10000, Number(raw.priority))) : isUpdate ? Number(existing.priority) || 0 : 0,
    reason: clean(raw.reason, 500),
    index,
  };

  if (instructionTypes.has(type)) {
    if (!operation.target) {
      operation.target = operation.source || operation.note || operation.reason;
      if (operation.target === operation.source) operation.source = '';
    }
    if (operation.sendMode === 'matched') operation.sendMode = 'always';
  }

  if (!operation.source && !instructionTypes.has(type)) return invalidCandidate(operation, '规则原文不能为空。');
  if (!operation.target && type === 'forbidden' && !operation.forbidden.length) return invalidCandidate(operation, '禁止译法规则必须填写目标译法或至少一个禁止译法。');
  if (!operation.target && !['background', 'format', 'forbidden'].includes(type)) return invalidCandidate(operation, '规则目标内容不能为空。');
  if (instructionTypes.has(type) && !operation.target) return invalidCandidate(operation, '通用规则内容不能为空。');
  return validCandidate(operation);
}

function validCandidate(operation) { return { ...operation, valid: true, validationError: '' }; }
function invalidCandidate(operation, validationError) { return { ...operation, valid: false, validationError }; }
function clean(value, maximum) { return String(value ?? '').trim().slice(0, maximum); }
function meaningful(value, fallback, maximum) { const result = clean(value, maximum); return result || clean(fallback, maximum); }
function meaningfulList(value, fallback) {
  const normalized = Array.isArray(value) ? [...new Set(value.map((item) => clean(item, 300)).filter(Boolean))].slice(0, 100) : [];
  return normalized.length ? normalized : Array.isArray(fallback) ? [...fallback] : [];
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
