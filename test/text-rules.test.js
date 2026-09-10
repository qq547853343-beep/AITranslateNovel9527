import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRules, resolveRuleConflicts, validateTranslation } from '../lib/rules.js';
import { compressExpressiveRuns, findTranslationShapeIssue, protectPlaceholders, restorePlaceholders, segmentDocumentBlocks, splitTextSmart } from '../lib/text-processing.js';

test('smart segmentation keeps all source text', () => {
  const source = `${'第一句。'.repeat(30)}\n\n${'第二句！'.repeat(30)}`;
  const parts = splitTextSmart(source, 80);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), source);
  assert.equal(segmentDocumentBlocks([{ kind: 'text', text: source }], 80).length, parts.length);
});

test('placeholder protection restores exact values', () => {
  const source = '访问 https://example.com 并保留 {name} 和 [SE:001]。';
  const protectedValue = protectPlaceholders(source);
  assert.notEqual(protectedValue.text, source);
  assert.deepEqual(restorePlaceholders(protectedValue.text, protectedValue.values), { text: source, issues: [] });
});

test('expressive run compression handles real failed segments without changing ordinary text', () => {
  const samples = [
    'ドルドン「な、何だとおおおおおおおおおおおおおっっ',
    'うそっ・・・！？\nうわあああああああああああああああああああああああああああああああああああああああああああ',
    'アン「ぴぎいいいいいいいいいいげげげぐぐぐぎぎきいいいいいいいいい',
  ];
  for (const source of samples) {
    const normalized = compressExpressiveRuns(source);
    assert.notEqual(normalized.text, source);
    assert.ok(normalized.compressedRunCount > 0);
    assert.ok(normalized.hints.every((hint) => hint.originalCount >= 6 && hint.retainedCount === 3));
    assert.equal(findTranslationShapeIssue(normalized.text, '自然且有限的译文'), null);
  }
  assert.deepEqual(compressExpressiveRuns('普通文本啊啊啊！'), { text: '普通文本啊啊啊！', hints: [], compressedRunCount: 0 });
  assert.equal(findTranslationShapeIssue('短文本', '啊'.repeat(13)).type, 'excessive-character-run');
  assert.equal(findTranslationShapeIssue('短文本', '正常译文'), null);
});

test('rule matching, conflicts and validation are deterministic', () => {
  const base = { type: 'term', aliases: [], forbidden: [], sendMode: 'matched', enabled: true, effectivePriority: 10 };
  const rules = [{ ...base, id: '1', source: '聖女', target: '圣女' }, { ...base, id: '2', source: '王都', target: '王都', sendMode: 'always' }];
  assert.deepEqual(matchRules('聖女が来た', rules).map((item) => item.id), ['1', '2']);
  assert.equal(validateTranslation('聖女が来た', '少女来了', rules).length, 1);
  const conflict = resolveRuleConflicts([...rules, { ...base, id: '3', source: '聖女', target: '神女' }]);
  assert.equal(conflict.conflicts.length, 1);
});
