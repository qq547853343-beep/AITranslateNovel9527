import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DEFAULT_WEB_PACKAGE_LIMITS, WebPackageReader } from '../lib/infrastructure/web-package-reader.js';
import { StagedAssetStore } from '../lib/infrastructure/staged-asset-store.js';
import { ImportWebPackage } from '../lib/application/import-web-package.js';
import { validateWebPackageDocument } from '../lib/domain/web-package.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const gif = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'binary');
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const safeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path fill="#ffd93b" d="M0 0h36v36H0z"/></svg>');
const manifest = { format: 'AITranslateNovel9527.web-content', version: '1.0', createdAt: '2026-09-09T00:00:00.000Z', generator: { name: 'fixed-test-generator', version: '1.0.0' } };

function documentWith(blocks) { return { schemaVersion: 1, title: '固定网页包样例', language: 'zh-CN', sourceUrl: 'https://example.com/chapter/1', blocks, metadata: { fixture: true } }; }
async function buildZip({ document = documentWith([{ id: 'p1', kind: 'text', tag: 'p', text: '正文' }]), html = '<p>兼容预览</p>', assets = {}, extra = {} } = {}) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('document.json', JSON.stringify(document));
  zip.file('content.html', html);
  for (const [name, value] of Object.entries(assets)) zip.file(name, value);
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-web-package-'));
  const assetDirectory = path.join(directory, 'assets');
  const originalAssetDirectory = path.join(directory, 'original-assets');
  const temporaryDirectory = path.join(directory, 'tmp');
  const importer = new ImportWebPackage({ reader: new WebPackageReader(), assetStore: new StagedAssetStore({ assetDirectory, originalAssetDirectory, temporaryDirectory }) });
  return { directory, assetDirectory, originalAssetDirectory, temporaryDirectory, importer };
}
function names(directory) { return fs.existsSync(directory) ? fs.readdirSync(directory) : []; }

test('standard web ZIP import uses document.json as canonical source and commits referenced images', async () => {
  const value = harness();
  try {
    const document = documentWith([
      { id: 'heading', kind: 'text', tag: 'h1', text: '规范标题' },
      { id: 'image', kind: 'image', assetPath: 'assets/illustration.png', alt: '插图', width: 800, height: 600 },
      { id: 'paragraph', kind: 'text', tag: 'p', text: '规范正文' },
    ]);
    const archive = await buildZip({ document, html: '<script>globalThis.compromised=true</script><h1>不可信标题</h1>', assets: { 'assets/illustration.png': png } });
    const result = await value.importer.execute(archive);
    assert.equal(result.document.sourceType, 'web-package');
    assert.deepEqual(result.document.blocks.map((block) => block.kind), ['text', 'image', 'text']);
    assert.equal(result.document.blocks[0].text, '规范标题');
    assert.equal(result.preview.contentHtmlUsed, false);
    assert.equal(result.assets.length, 1);
    assert.deepEqual(names(value.assetDirectory), [result.assets[0].assetId]);
    assert.deepEqual(names(value.temporaryDirectory), []);
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('web ZIP reader rejects path traversal and abnormal compression ratios', async () => {
  const reader = new WebPackageReader();
  const traversal = await buildZip({ extra: { '../escape.png': png } });
  await assert.rejects(() => reader.read(traversal), (error) => error.code === 'WEB_PACKAGE_PATH_UNSAFE');
  const compressed = await buildZip({ html: `<p>${'A'.repeat(100_000)}</p>` });
  await assert.rejects(() => reader.read(compressed), (error) => error.code === 'WEB_PACKAGE_COMPRESSION_RATIO_EXCEEDED');
});

test('web ZIP entry limits count directories as well as files', async () => {
  const archive = await buildZip({ assets: { 'assets/one.png': png } });
  const reader = new WebPackageReader({ limits: { fileCount: 4 } });
  await assert.rejects(() => reader.read(archive), (error) => error.code === 'WEB_PACKAGE_FILE_COUNT_EXCEEDED');
});

test('missing and invalid ZIP assets leave no formal or temporary files', async () => {
  const value = harness();
  try {
    const missingDocument = documentWith([{ id: 'image', kind: 'image', assetPath: 'assets/missing.png' }]);
    const missingArchive = await buildZip({ document: missingDocument });
    await assert.rejects(() => value.importer.execute(missingArchive), (error) => error.code === 'WEB_PACKAGE_ASSET_MISSING');
    const invalidDocument = documentWith([
      { id: 'good', kind: 'image', assetPath: 'assets/good.png' },
      { id: 'bad', kind: 'image', assetPath: 'assets/bad.png' },
    ]);
    const invalidArchive = await buildZip({ document: invalidDocument, assets: { 'assets/good.png': png, 'assets/bad.png': jpeg } });
    await assert.rejects(
      () => value.importer.execute(invalidArchive),
      (error) => error.code === 'WEB_PACKAGE_ASSET_TYPE_MISMATCH',
    );
    assert.deepEqual(names(value.assetDirectory), []);
    assert.deepEqual(names(value.temporaryDirectory), []);
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('web ZIP contract requires a PNG preview for SVG content', async () => {
  const archive = await buildZip({
    document: documentWith([{ id: 'svg', kind: 'image', assetPath: 'assets/active.svg' }]),
    assets: { 'assets/active.svg': '<svg onload="alert(1)"/>' },
  });
  const reader = new WebPackageReader();
  const parsed = await reader.read(archive);
  assert.throws(() => validateWebPackageDocument(parsed.document), (error) => error.code === 'WEB_PACKAGE_SVG_PREVIEW_REQUIRED');
});

test('web ZIP import preserves GIF and WebP bytes and original formats', async () => {
  const value = harness();
  try {
    const document = documentWith([
      { id: 'gif', kind: 'image', assetPath: 'assets/animation.gif', alt: 'GIF', width: 1, height: 1 },
      { id: 'webp', kind: 'image', assetPath: 'assets/photo.webp', alt: 'WebP', width: 1, height: 1 },
    ]);
    const archive = await buildZip({ document, assets: { 'assets/animation.gif': gif, 'assets/photo.webp': webp } });
    const result = await value.importer.execute(archive);
    assert.deepEqual(result.assets.map((asset) => path.extname(asset.assetId)).sort(), ['.gif', '.webp']);
    for (const asset of result.assets) {
      const bytes = fs.readFileSync(path.join(value.assetDirectory, asset.assetId));
      assert.deepEqual(bytes, asset.assetId.endsWith('.gif') ? gif : webp);
    }
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('web ZIP import quarantines exact SVG bytes and uses PNG as the renderable asset', async () => {
  const value = harness();
  try {
    const document = documentWith([{ id: 'moon', kind: 'image', assetPath: 'assets/moon.svg', previewAssetPath: 'assets/moon.preview.png', alt: '月亮', width: 36, height: 36 }]);
    const archive = await buildZip({ document, assets: { 'assets/moon.svg': safeSvg, 'assets/moon.preview.png': png } });
    const result = await value.importer.execute(archive);
    const block = result.document.blocks[0];
    assert.match(block.assetId, /\.png$/);
    assert.match(block.originalAssetId, /\.svg$/);
    assert.equal(block.width, 36);
    assert.equal(block.height, 36);
    assert.deepEqual(fs.readFileSync(path.join(value.assetDirectory, block.assetId)), png);
    assert.deepEqual(fs.readFileSync(path.join(value.originalAssetDirectory, block.originalAssetId)), safeSvg);
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('active SVG rejection rolls back both preview and original asset directories', async () => {
  const value = harness();
  try {
    const document = documentWith([{ id: 'active', kind: 'image', assetPath: 'assets/active.svg', previewAssetPath: 'assets/active.preview.png' }]);
    const archive = await buildZip({ document, assets: { 'assets/active.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'assets/active.preview.png': png } });
    await assert.rejects(() => value.importer.execute(archive), (error) => error.code === 'WEB_PACKAGE_SVG_ACTIVE_CONTENT');
    assert.deepEqual(names(value.assetDirectory), []);
    assert.deepEqual(names(value.originalAssetDirectory), []);
    assert.deepEqual(names(value.temporaryDirectory), []);
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('web ZIP reader accepts more than 500 files within the expanded bounded limit', async () => {
  const assets = Object.fromEntries(Array.from({ length: 501 }, (_unused, index) => [`assets/image-${index}.png`, png]));
  const archive = await buildZip({ assets });
  const result = await new WebPackageReader().read(archive);
  assert.equal(result.assets.size, 501);
});

test('web ZIP expanded limits remain explicit and bounded', () => {
  assert.deepEqual(
    { archiveBytes: DEFAULT_WEB_PACKAGE_LIMITS.archiveBytes, fileCount: DEFAULT_WEB_PACKAGE_LIMITS.fileCount, expandedBytes: DEFAULT_WEB_PACKAGE_LIMITS.expandedBytes },
    { archiveBytes: 200 * 1024 * 1024, fileCount: 4_004, expandedBytes: 500 * 1024 * 1024 },
  );
});
