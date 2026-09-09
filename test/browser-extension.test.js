import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { detectImageFormat } from '../browser-extension/lib/image-format.js';
import { buildWebContentPackage } from '../browser-extension/lib/package-builder.js';
import { ImportWebPackage } from '../lib/application/import-web-package.js';
import { StagedAssetStore } from '../lib/infrastructure/staged-asset-store.js';
import { WebPackageReader } from '../lib/infrastructure/web-package-reader.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gif = Uint8Array.from(Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'binary'));
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

function response(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
}

test('extension declares a local Manifest V3 popup with no remotely hosted code', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'downloads', 'scripting']);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_security_policy, undefined);
});

test('extension image detector recognizes supported original formats', () => {
  assert.equal(detectImageFormat(gif).extension, 'gif');
  assert.equal(detectImageFormat(webp).extension, 'webp');
  assert.equal(detectImageFormat(Uint8Array.from([0x3c, 0x73, 0x76, 0x67])), null);
});

test('extension creates an importer-compatible ZIP and preserves downloaded image bytes', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/animation')) return response(gif);
    if (url.endsWith('/photo')) return response(webp);
    return new Response('', { status: 404 });
  };
  const selection = {
    title: '选区测试', language: 'zh-CN', sourceUrl: 'https://example.com/chapter',
    blocks: [
      { kind: 'text', tag: 'h1', text: '标题' },
      { kind: 'image', sourceUrl: 'https://cdn.example.com/animation', alt: '动图', width: 10, height: 20 },
      { kind: 'text', tag: 'p', text: '正文' },
      { kind: 'image', sourceUrl: 'https://cdn.example.com/photo', alt: '照片', width: 30, height: 40 },
      { kind: 'image', sourceUrl: 'https://cdn.example.com/photo', alt: '重复照片', width: 30, height: 40 },
    ],
  };
  const built = await buildWebContentPackage(selection, { fetchImpl, now: () => new Date('2026-09-10T01:02:03.000Z') });
  const zip = await JSZip.loadAsync(built.zip);
  assert.deepEqual(Object.keys(zip.files).sort(), ['assets/image-001.gif', 'assets/image-002.webp', 'content.html', 'document.json', 'manifest.json']);
  assert.deepEqual(built.document.blocks.map((block) => block.kind), ['text', 'image', 'text', 'image', 'image']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.credentials === 'omit'));
  assert.deepEqual(await zip.file('assets/image-001.gif').async('uint8array'), gif);
  assert.deepEqual(await zip.file('assets/image-002.webp').async('uint8array'), webp);
  assert.equal(JSON.parse(await zip.file('document.json').async('string')).blocks[3].assetPath, 'assets/image-002.webp');
});

test('extension rejects unsupported image bytes before returning a partial ZIP', async () => {
  const selection = { title: 'SVG', sourceUrl: 'https://example.com/', blocks: [{ kind: 'image', sourceUrl: 'https://example.com/vector.svg' }] };
  await assert.rejects(
    () => buildWebContentPackage(selection, { fetchImpl: async () => response(Uint8Array.from(Buffer.from('<svg/>'))) }),
    /图片格式不受支持/,
  );
});

test('extension output passes the real web-package importer without rewriting image bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-extension-import-'));
  try {
    const built = await buildWebContentPackage(
      { title: '端到端', sourceUrl: 'https://example.com/', blocks: [{ kind: 'image', sourceUrl: 'https://cdn.example.com/photo', width: 2, height: 3 }] },
      { fetchImpl: async () => response(webp), now: () => new Date('2026-09-10T01:02:03.000Z') },
    );
    const assetDirectory = path.join(directory, 'assets');
    const importer = new ImportWebPackage({
      reader: new WebPackageReader(),
      assetStore: new StagedAssetStore({ assetDirectory, temporaryDirectory: path.join(directory, 'tmp') }),
    });
    const imported = await importer.execute(Buffer.from(built.zip));
    assert.equal(imported.document.blocks[0].assetId.endsWith('.webp'), true);
    assert.deepEqual(fs.readFileSync(path.join(assetDirectory, imported.document.blocks[0].assetId)), Buffer.from(webp));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
