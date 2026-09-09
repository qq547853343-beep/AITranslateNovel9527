import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(directory, '..', 'public', 'clipboard-reader.js'), 'utf8');

function loadReader() {
  const context = vm.createContext({ Error, Object });
  vm.runInContext(source, context);
  return context.ClipboardContentReader;
}

function clipboardItem(values) {
  return {
    types: Object.keys(values),
    async getType(type) {
      if (!(type in values)) throw new Error(`missing ${type}`);
      return values[type];
    }
  };
}

const textBlob = (value) => ({ text: async () => value });

test('clipboard reader prefers HTML while retaining plain text and images', async () => {
  const image = { size: 12 };
  const clipboard = { read: async () => [clipboardItem({
    'text/plain': textBlob('plain fallback'),
    'text/html': textBlob('<h1>网页标题</h1><p>正文</p>'),
    'image/png': image
  })] };
  const result = await loadReader().readClipboardContent(clipboard);
  assert.equal(result.html, '<h1>网页标题</h1><p>正文</p>');
  assert.equal(result.text, 'plain fallback');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].type, 'image/png');
  assert.equal(result.images[0].blob, image);
});

test('clipboard reader supports plain text fallback and stable errors', async () => {
  const reader = loadReader();
  const result = await reader.readClipboardContent({ read: async () => [clipboardItem({ 'text/plain': textBlob('只有文字') })] });
  assert.equal(result.html, '');
  assert.equal(result.text, '只有文字');
  await assert.rejects(() => reader.readClipboardContent(null), (error) => error.code === 'CLIPBOARD_READ_UNSUPPORTED');
  await assert.rejects(() => reader.readClipboardContent({ read: async () => { throw new Error('denied'); } }), (error) => error.code === 'CLIPBOARD_READ_DENIED');
  await assert.rejects(() => reader.readClipboardContent({ read: async () => [] }), (error) => error.code === 'CLIPBOARD_CONTENT_EMPTY');
});
