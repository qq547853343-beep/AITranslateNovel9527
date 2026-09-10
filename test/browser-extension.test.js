import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { detectImageFormat } from '../browser-extension/lib/image-format.js';
import { buildWebContentPackage } from '../browser-extension/lib/package-builder.js';
import { extractSelectedContent } from '../browser-extension/lib/selection-extractor.js';
import { ImportWebPackage } from '../lib/application/import-web-package.js';
import { StagedAssetStore } from '../lib/infrastructure/staged-asset-store.js';
import { WebPackageReader } from '../lib/infrastructure/web-package-reader.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gif = Uint8Array.from(Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'binary'));
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const safeSvg = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path fill="#ffd93b" d="M0 0h36v36H0z"/></svg>'));
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

test('selection extractor remains self-contained after Chrome serializes the injected function', () => {
  const textNode = { nodeType: 3, nodeValue: '已选正文' };
  const range = { cloneContents: () => ({ childNodes: [textNode] }), intersectsNode: () => false };
  const context = {
    window: { getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => '已选正文' }) },
    document: {
      images: [], baseURI: 'https://example.com/', title: '测试网页', documentElement: { lang: 'zh-CN' },
      createDocumentFragment: () => ({ childNodes: [], append(value) { this.childNodes.push(...value.childNodes); } }),
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL, location: { href: 'https://example.com/chapter' }, Map, Set,
  };
  const result = vm.runInNewContext(`(${extractSelectedContent.toString()})()`, context);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].text, '已选正文');
});

test('selection extractor restores WordPress emoji images to inline alt text', async () => {
  const text = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, attributes = {}, childNodes = []) => ({
    nodeType: 1,
    tagName,
    childNodes,
    currentSrc: '',
    naturalWidth: 18,
    naturalHeight: 18,
    getAttribute(name) { return attributes[name] || ''; },
    getBoundingClientRect() { return { width: 18, height: 18 }; },
  });
  const emoji = element('IMG', { class: 'emoji', alt: '‼', src: 'https://s.w.org/images/core/emoji/17.0.2/svg/203c.svg' });
  const heart = element('IMG', { class: 'wp-smiley', alt: '♥', src: 'https://s.w.org/images/core/emoji/17.0.2/svg/2665.svg' });
  const illustration = element('IMG', { alt: '月亮插图', src: 'https://s.w.org/moon.svg', width: '36', height: '36' });
  const paragraph = element('P', {}, [text('あぎっ'), emoji, text('\nプリプリ'), heart, text('\n插图前'), illustration, text('插图后')]);
  const range = { cloneContents: () => ({ childNodes: [paragraph] }), intersectsNode: () => true };
  const images = [emoji, heart, illustration];
  const context = {
    window: { getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => 'fallback' }) },
    document: {
      images, baseURI: 'https://example.com/', title: 'Emoji 网页', documentElement: { lang: 'ja' },
      createDocumentFragment: () => ({ childNodes: [], append(value) { this.childNodes.push(...value.childNodes); } }),
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL, location: { href: 'https://example.com/chapter' }, Map, Set,
  };
  const result = vm.runInNewContext(`(${extractSelectedContent.toString()})()`, context);
  assert.equal(result.blocks.length, 3);
  assert.equal(result.blocks[0].kind, 'text');
  assert.equal(result.blocks[0].text, 'あぎっ‼\nプリプリ♥\n插图前');
  assert.equal(result.blocks[1].kind, 'image');
  assert.equal(result.blocks[1].sourceUrl, 'https://s.w.org/moon.svg');
  assert.equal(result.blocks[2].text, '插图后');
  const built = await buildWebContentPackage(result, {
    fetchImpl: async () => response(safeSvg),
    rasterizeSvg: async () => png,
    now: () => new Date('2026-09-10T01:02:03.000Z'),
  });
  assert.equal(built.assets.length, 1);
  assert.equal(built.document.blocks[0].text, 'あぎっ‼\nプリプリ♥\n插图前');
  assert.equal(Array.from(built.document.blocks, (block) => block.kind).join(','), 'text,image,text');
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

test('extension rejects malformed SVG before returning a partial ZIP', async () => {
  const selection = { title: 'SVG', sourceUrl: 'https://example.com/', blocks: [{ kind: 'image', sourceUrl: 'https://example.com/vector.svg' }] };
  await assert.rejects(
    () => buildWebContentPackage(selection, { fetchImpl: async () => response(Uint8Array.from(Buffer.from('<svg/>'))) }),
    /命名空间|完整/,
  );
});

test('extension preserves safe SVG bytes, generates a PNG preview, and records CSS dimensions', async () => {
  const selection = { title: 'SVG', sourceUrl: 'https://example.com/', blocks: [{ kind: 'image', sourceUrl: 'https://s.w.org/moon.svg', width: 18, height: 22 }] };
  let rasterized;
  const built = await buildWebContentPackage(selection, {
    fetchImpl: async () => response(safeSvg),
    rasterizeSvg: async (bytes, dimensions) => { rasterized = { bytes, dimensions }; return png; },
    now: () => new Date('2026-09-10T01:02:03.000Z'),
  });
  const zip = await JSZip.loadAsync(built.zip);
  const block = built.document.blocks[0];
  assert.equal(block.assetPath, 'assets/image-001.svg');
  assert.equal(block.previewAssetPath, 'assets/image-001.preview.png');
  assert.deepEqual({ width: block.width, height: block.height }, { width: 18, height: 22 });
  assert.deepEqual(rasterized.dimensions, { width: 18, height: 22, sourceUrl: 'https://s.w.org/moon.svg' });
  assert.deepEqual(await zip.file(block.assetPath).async('uint8array'), safeSvg);
  assert.deepEqual(await zip.file(block.previewAssetPath).async('uint8array'), png);
  assert.match(await zip.file('content.html').async('string'), /image-001\.preview\.png/);
});

test('extension rejects SVG active content instead of exporting it verbatim', async () => {
  const active = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  const selection = { title: 'SVG', sourceUrl: 'https://example.com/', blocks: [{ kind: 'image', sourceUrl: 'https://example.com/active.svg' }] };
  await assert.rejects(() => buildWebContentPackage(selection, { fetchImpl: async () => response(active), rasterizeSvg: async () => png }), /主动内容|脚本/);
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

test('extension accepts five thousand content blocks and rejects the next block', async () => {
  const blocks = Array.from({ length: 5_000 }, (_unused, index) => ({ kind: 'text', tag: 'p', text: `段${index}` }));
  const built = await buildWebContentPackage({ title: '大量内容块', sourceUrl: 'https://example.com/', blocks }, { now: () => new Date('2026-09-10T01:02:03.000Z') });
  assert.equal(built.document.blocks.length, 5_000);
  await assert.rejects(
    () => buildWebContentPackage({ title: '超限', sourceUrl: 'https://example.com/', blocks: [...blocks, { kind: 'text', tag: 'p', text: '额外' }] }),
    /5,000/,
  );
});

test('extension supports more than the previous 497-image ceiling', async () => {
  const blocks = Array.from({ length: 498 }, (_unused, index) => ({ kind: 'image', sourceUrl: `https://cdn.example.com/${index}.png`, width: 1, height: 1 }));
  const built = await buildWebContentPackage(
    { title: '图片容量', sourceUrl: 'https://example.com/', blocks },
    { fetchImpl: async () => response(png), now: () => new Date('2026-09-10T01:02:03.000Z') },
  );
  assert.equal(built.assets.length, 498);
  assert.ok(built.zip.length > 0);
  const tooMany = Array.from({ length: 2_001 }, (_unused, index) => ({ kind: 'image', sourceUrl: `https://cdn.example.com/too-many-${index}.png` }));
  await assert.rejects(
    () => buildWebContentPackage({ title: '图片超限', sourceUrl: 'https://example.com/', blocks: tooMany }),
    /2,000/,
  );
});
