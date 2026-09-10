import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, normalizeDocumentBlocks } from '../lib/domain/document.js';

test('document model preserves text and image order using the existing block contract', () => {
  const assetId = '123e4567-e89b-12d3-a456-426614174000.png';
  const blocks = normalizeDocumentBlocks([
    { kind: 'text', tag: 'h1', text: '标题\r\n副标题' },
    { kind: 'image', assetId, alt: '插图', width: 800, height: 600 },
    { kind: 'text', tag: 'p', text: '正文' }
  ]);
  assert.deepEqual(blocks.map((block) => block.kind), ['text', 'image', 'text']);
  assert.equal(blocks[0].text, '标题\n副标题');
  assert.equal(blocks[1].assetId, assetId);
  assert.equal(createDocument({ title: ' 示例 ', sourceType: 'clipboard-html', blocks }).title, '示例');
});

test('document model retains existing limits and stable validation codes', () => {
  assert.throws(() => normalizeDocumentBlocks([]), (error) => error.code === 'DOCUMENT_BLOCK_COUNT_INVALID' && error.status === 400);
  assert.throws(() => normalizeDocumentBlocks([{ kind: 'video' }]), (error) => error.code === 'DOCUMENT_BLOCK_UNSUPPORTED');
  assert.throws(() => normalizeDocumentBlocks([{ kind: 'image', assetId: '../secret.png' }]), (error) => error.code === 'DOCUMENT_IMAGE_REFERENCE_INVALID');
  assert.throws(() => normalizeDocumentBlocks([{ kind: 'text', text: 'x'.repeat(200_001) }]), (error) => error.code === 'DOCUMENT_TEXT_TOO_LARGE' && error.status === 413);
});

test('document model accepts five thousand structural blocks but not more', () => {
  const blocks = Array.from({ length: 5_000 }, () => ({ kind: 'text', tag: 'p', text: 'x' }));
  assert.equal(normalizeDocumentBlocks(blocks).length, 5_000);
  assert.throws(() => normalizeDocumentBlocks([...blocks, { kind: 'text', tag: 'p', text: 'x' }]), (error) => error.code === 'DOCUMENT_BLOCK_COUNT_INVALID');
});
