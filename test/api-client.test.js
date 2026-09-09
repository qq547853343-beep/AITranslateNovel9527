import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadClient(fetchImpl) {
  const context = { window: { fetch: fetchImpl }, FormData, Error };
  vm.runInNewContext(fs.readFileSync(new URL('../public/api-client.js', import.meta.url), 'utf8'), context);
  return context.window.TranslationApi;
}

test('browser API client preserves stable server error metadata', async () => {
  const client = loadClient(async () => ({ ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ code: 'WEB_PACKAGE_INVALID', error: '包无效', details: { field: 'manifest' } }) }));
  await assert.rejects(() => client.request('/api/import/web-package'), (error) => error.code === 'WEB_PACKAGE_INVALID' && error.status === 400 && error.details.field === 'manifest');
});

test('browser API client creates JSON requests without exposing Node capabilities', () => {
  const client = loadClient(async () => { throw new Error('unused'); });
  assert.deepEqual(JSON.parse(JSON.stringify(client.json('POST', { value: 1 }))), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":1}' });
  assert.equal(Object.isFrozen(client), true);
});
