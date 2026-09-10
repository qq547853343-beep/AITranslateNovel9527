import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/database.js';
import { RuleSetRepository } from '../lib/repositories.js';
import { RuleProposalService } from '../lib/application/rule-proposal-service.js';

function harness(operations) {
  const database = openDatabase(':memory:');
  const repository = new RuleSetRepository(database);
  const ruleSet = repository.create({ name: '候选规则测试' });
  const existing = repository.addRule(ruleSet.id, { type: 'term', source: '聖女', target: '圣女', note: '旧备注' });
  const service = new RuleProposalService({
    ruleSetRepository: repository,
    providerFactory: async () => ({ parseRuleInstruction: async () => ({ operations }) }),
  });
  return { database, repository, ruleSetId: ruleSet.id, existing, service };
}

test('rule proposals normalize style content and allow forbidden-only rules', async () => {
  const value = harness([
    { action: 'add', type: 'style', source: '使用简洁克制的文风', target: '', sendMode: 'matched' },
    { action: 'add', type: 'forbidden', source: '彼岸花', target: '', forbidden: ['曼珠沙华'] },
  ]);
  try {
    const proposal = await value.service.propose({ ruleSetId: value.ruleSetId, instruction: '设置风格和禁止译法' });
    assert.deepEqual(proposal.operations.map(({ type, source, target, sendMode, valid }) => ({ type, source, target, sendMode, valid })), [
      { type: 'style', source: '', target: '使用简洁克制的文风', sendMode: 'always', valid: true },
      { type: 'forbidden', source: '彼岸花', target: '', sendMode: 'matched', valid: true },
    ]);
    const result = value.service.apply({ ruleSetId: value.ruleSetId, operations: proposal.operations });
    assert.equal(result.applied.length, 2);
  } finally { value.database.close(); }
});

test('rule proposals preserve required fields omitted by an AI update', async () => {
  const value = harness([{ action: 'update', ruleId: '', type: 'term', source: '', target: '', note: '新备注' }]);
  try {
    value.service.providerFactory = async () => ({ parseRuleInstruction: async () => ({ operations: [{ action: 'update', ruleId: value.existing.id, type: 'term', source: '', target: '', note: '新备注' }] }) });
    const proposal = await value.service.propose({ ruleSetId: value.ruleSetId, instruction: '更新备注' });
    assert.equal(proposal.operations[0].source, '聖女');
    assert.equal(proposal.operations[0].target, '圣女');
    value.service.apply({ ruleSetId: value.ruleSetId, operations: proposal.operations });
    const updated = value.repository.getById(value.ruleSetId).rules.find((rule) => rule.id === value.existing.id);
    assert.equal(updated.target, '圣女');
    assert.equal(updated.note, '新备注');
  } finally { value.database.close(); }
});

test('invalid parsed rules are identified before save and rejected atomically', async () => {
  const value = harness([{ action: 'add', type: 'term', source: '王都', target: '' }]);
  try {
    const proposal = await value.service.propose({ ruleSetId: value.ruleSetId, instruction: '王都相关规则' });
    assert.equal(proposal.operations[0].valid, false);
    assert.equal(proposal.operations[0].validationError, '规则目标内容不能为空。');
    assert.throws(
      () => value.service.apply({ ruleSetId: value.ruleSetId, operations: proposal.operations }),
      (error) => error.code === 'RULE_OPERATION_INVALID' && error.details[0].message === '规则目标内容不能为空。',
    );
    assert.equal(value.repository.getById(value.ruleSetId).rules.length, 1);
  } finally { value.database.close(); }
});

test('rule candidate UI marks invalid proposals and disables confirmation', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /:class="\{invalid:op\.valid===false\}"/);
  assert.match(html, /:disabled="!canApplyParsedRules"/);
  assert.match(script, /invalidPendingOperations\(\)/);
  assert.match(script, /if \(!this\.canApplyParsedRules\)/);
});
