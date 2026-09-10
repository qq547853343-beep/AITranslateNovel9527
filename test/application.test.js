import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import JSZip from 'jszip';
import { createApplication } from '../lib/application.js';
import { MemorySecretStore } from '../lib/secret-store.js';

test('HTTP API supports rules and recoverable translation jobs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translateword-test-'));
  const fakeFetch = async (url, options) => {
    if (url.endsWith('/user/balance')) return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.88', granted_balance: '0.00', topped_up_balance: '8.88' }] }) };
    const request = JSON.parse(options.body); const userContent = request.messages.at(-1).content;
    let user; try { user = JSON.parse(userContent); } catch { user = null; }
    const content = !user ? `兼容译文：${userContent}` : user.segment
      ? { id: user.segment.id, translation: user.segment.text.replaceAll('聖女', '圣女'), notes: [], decisionSummary: [], uncertainties: [] }
      : { operations: [{ action: 'add', type: 'term', source: '王都', target: '王都', aliases: [], forbidden: [], category: '地名', sendMode: 'matched' }] };
    return { ok: true, status: 200, json: async () => ({ model: 'deepseek-chat', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
  };
  const runtime = await createApplication({ baseDirectory: directory, databaseFile: ':memory:', fetchImpl: fakeFetch, secretStore: new MemorySecretStore() });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => { const response = await fetch(origin + url, { ...options, headers: { Origin: origin, 'Content-Type': 'application/json', ...(options.headers || {}) } }); return { response, body: await response.json() }; };
  try {
    let result = await request('/api/settings/api-key', { method: 'POST', body: JSON.stringify({ apiKey: 'sk-test-key-1234567890' }) });
    assert.equal(result.response.status, 200);
    result = await request('/api/deepseek/balance'); assert.equal(result.response.status, 200); assert.equal(result.body.balanceInfos[0].totalBalance, '8.88'); assert.equal(JSON.stringify(result.body).includes('sk-test'), false);
    result = await request('/api/rule-sets', { method: 'POST', body: JSON.stringify({ name: '集成测试规则' }) });
    assert.equal(result.response.status, 201); const ruleSetId = result.body.id;
    result = await request(`/api/rule-sets/${ruleSetId}/rules`, { method: 'POST', body: JSON.stringify({ source: '聖女', target: '圣女' }) });
    assert.equal(result.response.status, 201);
    result = await request('/api/rules/parse', { method: 'POST', body: JSON.stringify({ ruleSetId, instruction: '把王都固定翻译为王都' }) });
    assert.equal(result.response.status, 200); const candidateOperations = result.body.operations;
    result = await request(`/api/rule-sets/${ruleSetId}`);
    assert.equal(result.body.rules.length, 1, 'AI 解析候选规则时不应直接修改规则集');
    result = await request('/api/rules/apply', { method: 'POST', body: JSON.stringify({ ruleSetId, operations: candidateOperations }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ruleSet.rules.length, 2, '用户确认后才保存候选规则');
    result = await request('/api/translation-jobs', { method: 'POST', body: JSON.stringify({ title: '测试', targetLanguage: '中文', ruleSetIds: [ruleSetId], blocks: [{ kind: 'text', tag: 'p', text: '聖女来了。' }] }) });
    assert.equal(result.response.status, 202); const jobId = result.body.id;
    for (let count = 0; count < 20; count += 1) {
      result = await request(`/api/translation-jobs/${jobId}`);
      if (result.body.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.resultBlocks[0].text, '圣女来了。');
    const eventController = new AbortController();
    const eventResponse = await fetch(`${origin}/api/translation-jobs/${jobId}/events`, { signal: eventController.signal });
    assert.equal(eventResponse.status, 200); assert.match(eventResponse.headers.get('content-type'), /^text\/event-stream/);
    const eventChunk = await eventResponse.body.getReader().read(); assert.match(new TextDecoder().decode(eventChunk.value), /event: job/); eventController.abort();
    result = await request('/api/translate-document', { method: 'POST', body: JSON.stringify({ title: '兼容接口', targetLanguage: '中文', ruleSetIds: [ruleSetId], blocks: [{ kind: 'text', tag: 'p', text: '聖女。' }] }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.blocks[0].text, '圣女。');
    result = await request('/api/translate', { method: 'POST', body: JSON.stringify({ text: '旧接口原文', targetLanguage: '中文' }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.translation, '兼容译文：旧接口原文');
    assert.equal(result.body.filename, 'translation.txt');
    result = await request('/api/usage/session'); assert.equal(result.response.status, 200); assert.ok(result.body.usage.totalTokens >= 45); assert.ok(result.body.usage.requestCount >= 3);
    const bundleResponse = await fetch(`${origin}/api/export/bundle`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '测试', sourceBlocks: [{ kind: 'text', tag: 'p', text: '原文' }], translatedBlocks: [{ kind: 'text', tag: 'p', text: '译文' }], targetLanguage: '中文', meta: { appliedRules: [{ source: '聖女', target: '圣女' }] }, selected: { translation: true, source: true, glossary: true, manifest: true } }) });
    assert.equal(bundleResponse.status, 200);
    const zip = await JSZip.loadAsync(await bundleResponse.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files).sort(), ['glossary.tsv', 'manifest.json', 'source.txt', 'translated.txt']);
    assert.equal(await zip.file('translated.txt').async('string'), '译文');
  } finally {
    await new Promise((resolve) => server.close(resolve)); runtime.database.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('health endpoint identifies the managed process and launcher shutdown requires its private token', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-health-'));
  let shutdownRequested = false;
  const runtime = await createApplication({
    baseDirectory: directory,
    databaseFile: ':memory:',
    secretStore: new MemorySecretStore(),
    launcherControl: { instanceId: 'launcher-instance-test', token: 'private-control-token', requestShutdown: () => { shutdownRequested = true; } }
  });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${origin}/api/health`);
    const health = await response.json();
    assert.equal(health.status, 'ok'); assert.equal(health.service, 'AITranslateNovel9527'); assert.equal(health.instanceId, 'launcher-instance-test'); assert.equal(health.pid, process.pid);
    response = await fetch(`${origin}/api/launcher/shutdown`, { method: 'POST', headers: { 'x-launcher-control-token': 'wrong-token' } });
    assert.equal(response.status, 403); assert.equal(shutdownRequested, false);
    response = await fetch(`${origin}/api/launcher/shutdown`, { method: 'POST', headers: { 'x-launcher-control-token': 'private-control-token' } });
    assert.equal(response.status, 202); assert.equal(shutdownRequested, true);
  } finally {
    await new Promise((resolve) => server.close(resolve)); runtime.database.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SVG originals are download-only while PNG previews remain renderable assets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-svg-api-'));
  const runtime = await createApplication({ baseDirectory: directory, databaseFile: ':memory:', secretStore: new MemorySecretStore() });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  try {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'AITranslateNovel9527.web-content', version: '1.0', createdAt: '2026-09-10T00:00:00.000Z', generator: { name: 'test', version: '1' } }));
    zip.file('document.json', JSON.stringify({ schemaVersion: 1, title: 'SVG', blocks: [{ id: 'image', kind: 'image', assetPath: 'assets/source.svg', previewAssetPath: 'assets/source.preview.png', width: 24, height: 24 }] }));
    zip.file('content.html', '<img src="assets/source.preview.png">');
    zip.file('assets/source.svg', svg);
    zip.file('assets/source.preview.png', png);
    const body = new FormData();
    body.append('package', new Blob([await zip.generateAsync({ type: 'uint8array' })], { type: 'application/zip' }), 'svg.zip');
    let response = await fetch(`${origin}/api/import/web-package`, { method: 'POST', headers: { Origin: origin }, body });
    assert.equal(response.status, 201);
    const imported = await response.json();
    const block = imported.document.blocks[0];
    response = await fetch(`${origin}/api/original-assets/${block.originalAssetId}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.match(response.headers.get('content-type'), /^application\/octet-stream/);
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), svg);
    response = await fetch(`${origin}/api/assets/${block.assetId}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
  } finally {
    await new Promise((resolve) => server.close(resolve)); runtime.database.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('remote clipboard images are committed as local assets after validation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-remote-image-'));
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x01]);
  const runtime = await createApplication({
    baseDirectory: directory,
    databaseFile: ':memory:',
    secretStore: new MemorySecretStore(),
    remoteImageImporter: { fetch: async (url) => url.endsWith('.png') ? png : Buffer.from('not-an-image') }
  });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/assets/import-remote`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [{ id: 'one', url: 'https://example.com/one.png' }, { id: 'two', url: 'https://example.com/two.svg' }] })
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.assets.length, 1); assert.equal(result.assets[0].requestId, 'one');
    assert.equal(result.warnings.length, 1); assert.equal(result.warnings[0].code, 'REMOTE_IMAGE_TYPE_UNSUPPORTED');
    const asset = await fetch(`${origin}${result.assets[0].url}`);
    assert.equal(asset.status, 200);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  } finally {
    await new Promise((resolve) => server.close(resolve)); runtime.database.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('standard web ZIP upload returns a canonical document and stable validation errors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-web-package-api-'));
  const runtime = await createApplication({ baseDirectory: directory, databaseFile: ':memory:', secretStore: new MemorySecretStore() });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const packageBuffer = async (document) => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'AITranslateNovel9527.web-content', version: '1.0', createdAt: '2026-09-09T00:00:00.000Z', generator: { name: 'api-test', version: '1' } }));
    zip.file('document.json', JSON.stringify(document));
    zip.file('content.html', '<script>alert(1)</script><p>不可信预览</p>');
    zip.file('assets/picture.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  try {
    const validDocument = { schemaVersion: 1, title: '网页章节', blocks: [{ id: 'text', kind: 'text', tag: 'p', text: '规范正文' }, { id: 'image', kind: 'image', assetPath: 'assets/picture.png', alt: '图片' }] };
    const form = new FormData(); form.append('package', new Blob([await packageBuffer(validDocument)], { type: 'application/zip' }), 'web-content.zip');
    let response = await fetch(`${origin}/api/import/web-package`, { method: 'POST', headers: { Origin: origin }, body: form });
    assert.equal(response.status, 201);
    const imported = await response.json();
    assert.equal(imported.document.title, '网页章节');
    assert.equal(imported.document.blocks[0].text, '规范正文');
    assert.equal(imported.preview.contentHtmlUsed, false);
    assert.match(imported.document.blocks[1].assetId, /^[0-9a-f-]{36}\.png$/);

    const invalidDocument = { ...validDocument, blocks: [{ id: 'missing', kind: 'image', assetPath: 'assets/missing.png' }] };
    const invalidForm = new FormData(); invalidForm.append('package', new Blob([await packageBuffer(invalidDocument)], { type: 'application/zip' }), 'invalid.zip');
    response = await fetch(`${origin}/api/import/web-package`, { method: 'POST', headers: { Origin: origin }, body: invalidForm });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'WEB_PACKAGE_ASSET_MISSING');
  } finally {
    await new Promise((resolve) => server.close(resolve)); runtime.database.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
