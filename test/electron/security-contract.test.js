import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('../../public/manager.html', import.meta.url), 'utf8');

test('Electron window keeps isolation, sandboxing and exact fallback-page trust', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /source === trustedManagerFileUrl/);
  assert.doesNotMatch(main, /url\.startsWith\(['"]file:/);
  assert.match(manager, /connect-src 'none'/);
});

test('preload exposes only fixed launcher operations and no arbitrary command channel', () => {
  const channels = [...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(channels, [
    'launcher:check-update', 'launcher:get-logs', 'launcher:get-snapshot', 'launcher:open-service',
    'launcher:restart', 'launcher:scan-ports', 'launcher:set-service-port', 'launcher:start',
    'launcher:stop', 'launcher:update-settings',
  ]);
  assert.doesNotMatch(preload, /child_process|exec\(|spawn\(|eval\(/);
});
