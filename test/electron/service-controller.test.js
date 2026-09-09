import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LauncherSettingsStore } from '../../electron/launcher-settings.js';
import { ServiceController } from '../../electron/service-controller.js';

class MemoryLogger {
  constructor() { this.lines = []; }
  launcher(level, message) { this.lines.push(`${level}:${message}`); }
  writeServiceChunk(level, chunk) { this.lines.push(`${level}:${chunk}`); }
}

function createHarness({ initial = {}, failHealthPorts = [], delayedPid = false } = {}) {
  const values = new Map();
  const repository = { get: (key, fallback) => values.get(key) || fallback, set: (key, value) => (values.set(key, value), value) };
  const store = new LauncherSettingsStore(repository);
  if (Object.keys(initial).length) store.save({ ...store.read(), ...initial });
  const processes = new Map(); let nextPid = 4000; let active = null;
  const fail = new Set(failHealthPorts); const unknownPorts = new Set();

  function stop(item, code, signal = null) {
    if (!item?.alive) return;
    item.alive = false;
    if (active === item) active = null;
    item.child.exitCode = code;
    queueMicrotask(() => item.child.emit('exit', code, signal));
  }

  const runtime = {
    spawnService({ env }) {
      const child = new EventEmitter();
      const assignedPid = ++nextPid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = delayedPid ? undefined : assignedPid; child.exitCode = null;
      const item = { child, pid: assignedPid, port: Number(env.PORT), instanceId: env.LAUNCHER_INSTANCE_ID, token: env.LAUNCHER_CONTROL_TOKEN, alive: true };
      if (delayedPid) queueMicrotask(() => { child.pid = assignedPid; processes.set(assignedPid, item); active = item; child.emit('spawn'); });
      else { processes.set(assignedPid, item); active = item; }
      return child;
    },
    async isPortOccupied(port) { return unknownPorts.has(Number(port)) || Boolean(active?.alive && active.port === Number(port)); },
    async healthCheck(port, expected = {}) {
      const healthy = Boolean(active?.alive && active.port === Number(port) && !fail.has(Number(port)) && (!expected.pid || active.pid === Number(expected.pid)) && (!expected.instanceId || active.instanceId === expected.instanceId));
      return { healthy, health: healthy ? { status: 'ok', service: 'AITranslateNovel9527', pid: active.pid, instanceId: active.instanceId } : null };
    },
    async requestShutdown(port, token) {
      if (!active || active.port !== Number(port) || active.token !== token) throw new Error('invalid shutdown');
      stop(active, 0); return { accepted: true };
    },
    isProcessAlive(pid) { return Boolean(processes.get(Number(pid))?.alive); },
    terminateProcess(pid) { stop(processes.get(Number(pid)), null, 'SIGTERM'); },
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 2))),
    async requestJson() { return { jobs: [] }; }
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-controller-'));
  const controller = new ServiceController({ settingsStore: store, logger: new MemoryLogger(), dataDirectory: directory, serverEntry: path.join(directory, 'server.js'), executable: process.execPath, runtime, startupTimeout: 25, stopTimeout: 25, releaseTimeout: 25, restartDelays: [2, 2, 2], stableResetMs: 100000 });
  return {
    controller, store, runtime, directory, fail, unknownPorts,
    get active() { return active; },
    crash(code = 1) { if (active) stop(active, code); },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

async function waitUntil(predicate, timeout = 400) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  throw new Error('condition timeout');
}

test('service controller starts, reports three-part health, restarts and stops its recorded PID', async () => {
  const value = createHarness(); await value.controller.initialize();
  let snapshot = await value.controller.start();
  assert.equal(snapshot.normal, true); assert.ok(snapshot.pid); assert.equal(snapshot.servicePort, 6501);
  const firstPid = snapshot.pid;
  snapshot = await value.controller.restart();
  assert.equal(snapshot.normal, true); assert.notEqual(snapshot.pid, firstPid);
  snapshot = await value.controller.stop();
  assert.equal(snapshot.state, 'stopped'); assert.equal(snapshot.processExists, false);
  value.cleanup();
});

test('service controller waits for a delayed Windows spawn event before requiring the child PID', async () => {
  const value = createHarness({ delayedPid: true }); await value.controller.initialize();
  const snapshot = await value.controller.start();
  assert.equal(snapshot.normal, true); assert.ok(snapshot.pid > 0);
  await value.controller.stop(); value.cleanup();
});

test('service port switch saves only after health succeeds and rolls back after failure', async () => {
  const value = createHarness({ failHealthPorts: [6602] }); await value.controller.initialize(); await value.controller.start();
  let snapshot = await value.controller.switchPort(6601);
  assert.equal(snapshot.normal, true); assert.equal(snapshot.servicePort, 6601); assert.equal(snapshot.activePort, 6601);
  await assert.rejects(() => value.controller.switchPort(6602), (error) => error.code === 'PORT_SWITCH_FAILED' && error.rollbackSucceeded === true);
  snapshot = await value.controller.getSnapshot();
  assert.equal(snapshot.normal, true); assert.equal(snapshot.servicePort, 6601); assert.equal(snapshot.activePort, 6601);
  await value.controller.stop(); value.cleanup();
});

test('unknown occupied port is rejected without terminating that process', async () => {
  const value = createHarness(); value.unknownPorts.add(6701); await value.controller.initialize();
  await assert.rejects(() => value.controller.switchPort(6701), (error) => error.code === 'PORT_IN_USE');
  assert.equal(value.unknownPorts.has(6701), true);
  value.cleanup();
});

test('port switch keeps the saved port when the old port cannot be released', async () => {
  const value = createHarness(); await value.controller.initialize(); await value.controller.start();
  value.unknownPorts.add(6501);
  await assert.rejects(() => value.controller.switchPort(6702), (error) => error.code === 'PORT_RELEASE_TIMEOUT');
  assert.equal(value.store.read().servicePort, 6501);
  assert.equal(value.unknownPorts.has(6501), true);
  value.unknownPorts.delete(6501); value.cleanup();
});

test('concurrent lifecycle operations are rejected by the shared lock', async () => {
  const value = createHarness(); await value.controller.initialize();
  let releaseHealth; let blockOnce = true; const original = value.runtime.healthCheck;
  value.runtime.healthCheck = async (...args) => { if (blockOnce) { blockOnce = false; await new Promise((resolve) => { releaseHealth = resolve; }); } return original(...args); };
  const starting = value.controller.start();
  await waitUntil(() => Boolean(releaseHealth));
  await assert.rejects(() => value.controller.stop(), (error) => error.code === 'OPERATION_BUSY');
  releaseHealth(); await starting; value.runtime.healthCheck = original; await value.controller.stop(); value.cleanup();
});

test('unexpected exits auto-restart at most three consecutive times', async () => {
  const value = createHarness({ initial: { autoRestartService: true } }); await value.controller.initialize(); await value.controller.start();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pid = (await value.controller.getSnapshot()).pid; value.crash();
    await waitUntil(async () => { const snapshot = await value.controller.getSnapshot(); return snapshot.state === 'running' && snapshot.pid !== pid; });
  }
  value.crash();
  await waitUntil(async () => (await value.controller.getSnapshot()).state === 'failed');
  await new Promise((resolve) => setTimeout(resolve, 15));
  const snapshot = await value.controller.getSnapshot();
  assert.equal(snapshot.state, 'failed'); assert.equal(snapshot.restartAttempts, 3); assert.equal(snapshot.processExists, false);
  value.cleanup();
});

test('deterministic port occupation stops the automatic restart loop', async () => {
  const value = createHarness({ initial: { autoRestartService: true } }); await value.controller.initialize(); await value.controller.start();
  value.crash(); value.unknownPorts.add(6501);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshot = await value.controller.getSnapshot();
  assert.equal(snapshot.state, 'failed'); assert.equal(snapshot.restartAttempts, 1); assert.equal(snapshot.processExists, false);
  value.cleanup();
});

test('stale persisted PID record is removed without killing an unverified process', async () => {
  const value = createHarness();
  fs.writeFileSync(path.join(value.directory, 'launcher-service.json'), JSON.stringify({ pid: 999999, port: 6501, instanceId: 'old', controlToken: 'secret', startedAt: new Date().toISOString() }));
  const snapshot = await value.controller.initialize();
  assert.equal(snapshot.state, 'stopped'); assert.equal(fs.existsSync(path.join(value.directory, 'launcher-service.json')), false);
  value.cleanup();
});
