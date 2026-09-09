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
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body); const user = JSON.parse(request.messages.at(-1).content);
    const content = user.segment
      ? { id: user.segment.id, translation: user.segment.text.replaceAll('聖女', '圣女'), notes: [], decisionSummary: [], uncertainties: [] }
      : { operations: [{ action: 'add', type: 'term', source: '王都', target: '王都', aliases: [], forbidden: [], category: '地名', sendMode: 'matched' }] };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  const runtime = await createApplication({ baseDirectory: directory, databaseFile: ':memory:', fetchImpl: fakeFetch, secretStore: new MemorySecretStore() });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => { const response = await fetch(origin + url, { ...options, headers: { Origin: origin, 'Content-Type': 'application/json', ...(options.headers || {}) } }); return { response, body: await response.json() }; };
  try {
    let result = await request('/api/settings/api-key', { method: 'POST', body: JSON.stringify({ apiKey: 'sk-test-key-1234567890' }) });
    assert.equal(result.response.status, 200);
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
    result = await request('/api/translate-document', { method: 'POST', body: JSON.stringify({ title: '兼容接口', targetLanguage: '中文', ruleSetIds: [ruleSetId], blocks: [{ kind: 'text', tag: 'p', text: '聖女。' }] }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.blocks[0].text, '圣女。');
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
