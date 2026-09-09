import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { AsyncOperationLock } from '../../electron/async-operation-lock.js';
import { LauncherSettingsStore } from '../../electron/launcher-settings.js';
import { createManagementServer } from '../../electron/management-server.js';
import { acquireGlobalInstanceLock } from '../../electron/global-instance-lock.js';
import { isPortOccupied, validatePort, waitForPort } from '../../electron/port-utils.js';
import { redactSecrets, RotatingLogger } from '../../electron/rotating-logger.js';
import { openDatabase } from '../../lib/database.js';
import { SettingsRepository } from '../../lib/repositories.js';

test('launcher settings use SettingsRepository-compatible storage and fixed management port', () => {
  const values = new Map();
  const repository = { get: (key, fallback) => values.get(key) || fallback, set: (key, value) => (values.set(key, value), value) };
  const store = new LauncherSettingsStore(repository);
  assert.equal(store.read().servicePort, 6501);
  assert.equal(store.read().launcherPort, 7000);
  const saved = store.save({ ...store.read(), servicePort: 6601, autoRestartService: true });
  assert.equal(saved.servicePort, 6601);
  assert.equal(saved.autoRestartService, true);
  assert.equal(store.read().launcherPort, 7000);
  assert.throws(() => validatePort(7000), /管理端口/);
  assert.throws(() => validatePort(70000), /1 到 65535/);
});

test('launcher settings persist through the existing SQLite SettingsRepository', () => {
  const database = openDatabase(':memory:');
  const first = new LauncherSettingsStore(new SettingsRepository(database));
  first.save({ ...first.read(), servicePort: 6610, autoStartLauncher: false, startHidden: false });
  const restored = new LauncherSettingsStore(new SettingsRepository(database)).read();
  assert.equal(restored.servicePort, 6610);
  assert.equal(restored.autoStartLauncher, false);
  assert.equal(restored.startHidden, false);
  database.close();
});

test('unified async operation lock rejects concurrent operations', async () => {
  const lock = new AsyncOperationLock();
  let release;
  const first = lock.run('启动服务', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => lock.run('停止服务', async () => {}), (error) => error.code === 'OPERATION_BUSY' && error.status === 409);
  release(); await first;
  assert.equal(lock.locked, false);
});

test('global launcher lock rejects a live second terminal and recovers a stale lock', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-global-lock-'));
  const lockFile = path.join(directory, 'launcher.lock');
  const live = new Set([101]);
  const first = acquireGlobalInstanceLock(lockFile, { pid: 101, isProcessAlive: (pid) => live.has(pid) });
  const second = acquireGlobalInstanceLock(lockFile, { pid: 102, isProcessAlive: (pid) => live.has(pid) });
  assert.equal(first.acquired, true); assert.equal(second.acquired, false); assert.equal(second.existingPid, 101);
  live.delete(101);
  const recovered = acquireGlobalInstanceLock(lockFile, { pid: 103, isProcessAlive: (pid) => live.has(pid) });
  assert.equal(recovered.acquired, true);
  first.release();
  assert.equal(fs.existsSync(lockFile), true);
  recovered.release();
  assert.equal(fs.existsSync(lockFile), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('port detection works while no translation service exists and release waiting times out safely', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal(await isPortOccupied(port), true);
  assert.equal(await waitForPort(port, false, { timeout: 30, interval: 5 }), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await waitForPort(port, false, { timeout: 200, interval: 5 }), true);
});

test('rotating logs redact secrets, retain bounded history and expose recent lines', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-log-'));
  const logger = new RotatingLogger(directory, { maxBytes: 120, maxHistory: 5, retentionDays: 7 });
  for (let index = 0; index < 18; index += 1) logger.launcher('info', `line ${index} Authorization: Bearer sk-super-secret-${index}`);
  logger.service('error', '{"apiKey":"sk-private-value-123456"}');
  const names = fs.readdirSync(directory).filter((name) => name.startsWith('launcher.log'));
  assert.ok(names.length <= 6, 'current file plus at most five history files');
  const lines = logger.readRecent('all', 200);
  assert.equal(lines.some((line) => line.includes('sk-super-secret') || line.includes('sk-private-value')), false);
  assert.match(redactSecrets('Authorization: Bearer abc123'), /\[REDACTED\]/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('fixed management server binds loopback and serves only whitelisted assets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-web-'));
  fs.writeFileSync(path.join(directory, 'manager.html'), '<!doctype html><title>manager</title>');
  fs.writeFileSync(path.join(directory, 'manager.js'), 'void 0');
  fs.writeFileSync(path.join(directory, 'manager.css'), 'body{}');
  const vueFile = path.join(directory, 'vue.js'); fs.writeFileSync(vueFile, 'void 0');
  const management = createManagementServer({ publicDirectory: directory, vueFile, port: 0 });
  const address = await management.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/server.js`)).status, 404);
  await management.close(); fs.rmSync(directory, { recursive: true, force: true });
});
