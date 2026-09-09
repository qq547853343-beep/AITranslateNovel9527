import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncOperationLock } from './async-operation-lock.js';
import {
  checkServiceHealth,
  isPortOccupied,
  isProcessAlive,
  requestJson,
  requestServiceShutdown,
  terminateRecordedProcess,
  validatePort
} from './port-utils.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForChildPid(child, timeout = 5000) {
  const currentPid = Number(child?.pid);
  if (Number.isInteger(currentPid) && currentPid > 0) return currentPid;
  let timer;
  try {
    await Promise.race([
      once(child, 'spawn'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('等待子进程 spawn 事件超时。'), { code: 'CHILD_SPAWN_TIMEOUT' })), timeout);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  const spawnedPid = Number(child?.pid);
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) throw Object.assign(new Error('子进程已触发 spawn 事件，但没有有效 PID。'), { code: 'CHILD_PID_MISSING' });
  return spawnedPid;
}

export function createServiceRuntime() {
  return {
    spawnService({ executable, serverEntry, workDirectory, env }) {
      return spawn(executable, [serverEntry], {
        cwd: workDirectory,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    },
    isPortOccupied,
    healthCheck: checkServiceHealth,
    requestShutdown: requestServiceShutdown,
    isProcessAlive,
    terminateProcess: terminateRecordedProcess,
    delay,
    requestJson
  };
}

export class ServiceController extends EventEmitter {
  constructor({ settingsStore, logger, dataDirectory, serverEntry, executable = process.execPath, workDirectory = path.dirname(serverEntry), runtime = createServiceRuntime(), onSettingsChanged = async () => {}, startupTimeout = 15_000, stopTimeout = 10_000, releaseTimeout = 3000, restartDelays = [1000, 2500, 5000], stableResetMs = 60_000 }) {
    super();
    this.settingsStore = settingsStore;
    this.logger = logger;
    this.dataDirectory = dataDirectory;
    this.serverEntry = serverEntry;
    this.executable = executable;
    this.workDirectory = workDirectory;
    this.runtime = runtime;
    this.onSettingsChanged = onSettingsChanged;
    this.startupTimeout = startupTimeout;
    this.stopTimeout = stopTimeout;
    this.releaseTimeout = releaseTimeout;
    this.restartDelays = restartDelays;
    this.stableResetMs = stableResetMs;
    this.recordFile = path.join(dataDirectory, 'launcher-service.json');
    this.lock = new AsyncOperationLock();
    this.settings = settingsStore.read();
    this.state = 'stopped';
    this.record = null;
    this.child = null;
    this.expectedExit = false;
    this.lastError = '';
    this.lastExit = null;
    this.health = null;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.stableTimer = null;
    this.monitorTimer = null;
  }

  async initialize() {
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    this.settings = this.settingsStore.read();
    const saved = this.#readRecord();
    if (saved && this.runtime.isProcessAlive(saved.pid)) {
      const result = await this.runtime.healthCheck(saved.port, { pid: saved.pid, instanceId: saved.instanceId });
      if (result.healthy) {
        this.record = saved;
        this.health = result.health;
        this.state = 'running';
        this.logger.launcher('info', `已恢复启动器记录的翻译服务 PID ${saved.pid}，端口 ${saved.port}。`);
      } else {
        this.#deleteRecord();
        this.lastError = '发现失效的服务记录；未结束未知进程。';
        this.logger.launcher('warn', this.lastError, { pid: saved.pid, port: saved.port });
      }
    } else if (saved) {
      this.#deleteRecord();
      this.logger.launcher('info', '已清理失效的服务 PID 记录。', { pid: saved.pid });
    }
    await this.onSettingsChanged(this.settings);
    this.monitorTimer = setInterval(() => void this.#monitorRecoveredProcess(), 2000);
    this.monitorTimer.unref?.();
    this.#emitStatus();
    return this.getSnapshot();
  }

  async start() {
    return this.lock.run('启动服务', async () => {
      if (this.state === 'running' && this.record) return this.getSnapshot();
      this.restartAttempts = 0;
      await this.#startInternal(this.settings.servicePort, { automatic: false });
      return this.getSnapshot();
    });
  }

  async stop() {
    return this.lock.run('停止服务', async () => {
      clearTimeout(this.restartTimer);
      await this.#stopInternal();
      return this.getSnapshot();
    });
  }

  async restart() {
    return this.lock.run('重启服务', async () => {
      this.#setState('restarting');
      this.restartAttempts = 0;
      await this.#stopInternal({ finalState: 'restarting' });
      await this.#startInternal(this.settings.servicePort, { automatic: false });
      return this.getSnapshot();
    });
  }

  async switchPort(value) {
    return this.lock.run('切换服务端口', async () => this.#switchPortInternal(value));
  }

  async updateSettings(changes = {}) {
    return this.lock.run('保存启动器设置', async () => {
      const allowed = ['autoStartLauncher', 'autoStartService', 'startHidden', 'autoRestartService'];
      const next = { ...this.settings };
      for (const key of allowed) if (Object.hasOwn(changes, key)) next[key] = Boolean(changes[key]);
      this.settings = this.settingsStore.save(next);
      if (!this.settings.autoRestartService) { clearTimeout(this.restartTimer); this.restartAttempts = 0; }
      await this.onSettingsChanged(this.settings);
      this.logger.launcher('info', '启动器设置已保存。', { ...this.settings, updatedAt: undefined });
      this.#emitStatus();
      return this.getSnapshot({ refresh: false });
    });
  }

  async scanPorts(start, end = start) {
    const first = Number(start); const last = Number(end);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65535 || first > last || last - first > 1000) {
      throw Object.assign(new Error('端口范围必须在 1-65535 之间，且一次最多检测 1001 个端口。'), { code: 'INVALID_PORT_RANGE', status: 400 });
    }
    const ports = [];
    for (let port = first; port <= last; port += 1) {
      const occupied = await this.runtime.isPortOccupied(port);
      const owned = Boolean(occupied && this.record?.port === port && this.runtime.isProcessAlive(this.record.pid));
      ports.push({ port, occupied, status: occupied ? (owned ? 'occupied-by-service' : 'occupied-by-unknown') : 'free' });
    }
    this.logger.launcher('info', `已检测端口 ${first}-${last}。`);
    return { start: first, end: last, ports, checkedAt: new Date().toISOString() };
  }

  async getSnapshot({ refresh = true } = {}) {
    const servicePort = this.record?.port || this.settings.servicePort;
    let processExists = Boolean(this.record && this.runtime.isProcessAlive(this.record.pid));
    let portListening = false;
    let healthy = false;
    if (refresh) {
      portListening = await this.runtime.isPortOccupied(servicePort);
      if (processExists && portListening) {
        const result = await this.runtime.healthCheck(servicePort, { pid: this.record.pid, instanceId: this.record.instanceId });
        healthy = result.healthy;
        this.health = result.health;
      }
      const directChildExitPending = this.state === 'running' && !processExists && Boolean(this.child);
      if (this.state === 'running' && !directChildExitPending && (!processExists || !portListening || !healthy)) {
        this.state = 'failed';
        this.lastError = '服务进程、端口监听或健康检查至少有一项异常。';
      }
    } else {
      portListening = this.state === 'running';
      healthy = this.state === 'running' && Boolean(this.health);
    }
    return {
      state: this.state,
      normal: Boolean(processExists && portListening && healthy),
      busy: this.lock.locked,
      activeOperation: this.lock.activeOperation,
      managementPort: 7000,
      servicePort: this.settings.servicePort,
      activePort: this.record?.port || null,
      pid: this.record?.pid || null,
      processExists,
      portListening,
      healthy,
      startedAt: this.record?.startedAt || null,
      lastError: this.lastError,
      lastExit: this.lastExit,
      restartAttempts: this.restartAttempts,
      settings: this.settings,
      update: { status: 'placeholder', supported: false, message: '自动更新接口已预留；ver0.2 不会下载、安装、替换或回滚程序。' }
    };
  }

  async hasActiveTranslation() {
    if (!this.record || this.state !== 'running') return false;
    try {
      const result = await this.runtime.requestJson({ port: this.record.port, path: '/api/translation-jobs/recoverable', timeout: 1200 });
      return (result.jobs || []).some((job) => ['pending', 'running'].includes(job.status));
    } catch { return false; }
  }

  async shutdownForExit() {
    clearTimeout(this.restartTimer); clearTimeout(this.stableTimer); clearInterval(this.monitorTimer);
    if (!this.record) return;
    try { await this.lock.run('退出启动器', () => this.#stopInternal()); }
    catch (error) { this.logger.launcher('error', `退出时停止服务失败：${error.message}`); }
  }

  async #switchPortInternal(value) {
    const newPort = validatePort(value);
    const oldPort = this.settings.servicePort;
    if (newPort === oldPort) return this.getSnapshot();
    if (await this.runtime.isPortOccupied(newPort)) throw this.#portInUse(newPort);
    const wasRunning = Boolean(this.record && this.runtime.isProcessAlive(this.record.pid));
    this.#setState('switching-port');
    this.logger.launcher('info', `开始将翻译服务端口从 ${oldPort} 切换到 ${newPort}。`);
    if (!wasRunning) {
      this.settings = this.settingsStore.save({ ...this.settings, servicePort: newPort });
      await this.onSettingsChanged(this.settings);
      this.#setState('stopped');
      return this.getSnapshot();
    }
    await this.#stopInternal({ finalState: 'switching-port' });
    if (await this.runtime.isPortOccupied(oldPort)) {
      this.#setState('failed', `旧端口 ${oldPort} 未释放，未保存新配置。`);
      throw Object.assign(new Error(this.lastError), { code: 'OLD_PORT_NOT_RELEASED' });
    }
    try {
      if (await this.runtime.isPortOccupied(newPort)) throw this.#portInUse(newPort);
      await this.#startInternal(newPort, { automatic: false });
      this.settings = this.settingsStore.save({ ...this.settings, servicePort: newPort });
      await this.onSettingsChanged(this.settings);
      this.logger.launcher('info', `翻译服务端口已切换并保存为 ${newPort}。`);
      return this.getSnapshot();
    } catch (error) {
      this.logger.launcher('error', `新端口 ${newPort} 启动失败，准备回滚到 ${oldPort}：${error.message}`);
      try { if (this.record) await this.#stopInternal({ finalState: 'switching-port' }); } catch {}
      this.settings = { ...this.settings, servicePort: oldPort };
      let rollbackError = null;
      try { await this.#startInternal(oldPort, { automatic: false }); }
      catch (failure) { rollbackError = failure; }
      const message = rollbackError ? `${error.message}；回滚原端口也失败：${rollbackError.message}` : `${error.message}；已恢复原端口 ${oldPort}。`;
      this.#setState(rollbackError ? 'failed' : 'running', message);
      throw Object.assign(new Error(message), { code: 'PORT_SWITCH_FAILED', rollbackSucceeded: !rollbackError });
    }
  }

  async #startInternal(port, { automatic }) {
    validatePort(port);
    if (await this.runtime.isPortOccupied(port)) throw this.#portInUse(port);
    this.#setState(automatic ? 'restarting' : 'starting');
    this.lastError = '';
    const record = { pid: null, port, instanceId: randomUUID(), controlToken: randomUUID(), startedAt: new Date().toISOString() };
    let child;
    try {
      child = this.runtime.spawnService({
        executable: this.executable,
        serverEntry: this.serverEntry,
        workDirectory: this.workDirectory,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PORT: String(port),
          TRANSLATE_DATA_DIR: this.dataDirectory,
          LAUNCHER_INSTANCE_ID: record.instanceId,
          LAUNCHER_CONTROL_TOKEN: record.controlToken
        }
      });
    } catch (error) {
      this.#setState('failed', `无法创建翻译服务子进程：${error.message}`);
      throw error;
    }
    try {
      record.pid = await waitForChildPid(child);
    } catch (error) {
      this.#setState('failed', `未能取得翻译服务子进程 PID：${error.message}`);
      throw Object.assign(new Error(this.lastError), { code: error.code || 'CHILD_SPAWN_FAILED', cause: error });
    }
    this.child = child; this.record = record; this.expectedExit = false; this.#writeRecord(record);
    child.stdout?.on('data', (chunk) => this.logger.writeServiceChunk('info', chunk));
    child.stderr?.on('data', (chunk) => this.logger.writeServiceChunk('error', chunk));
    child.once('error', (error) => this.logger.launcher('error', `翻译服务子进程错误：${error.message}`));
    child.once('exit', (code, signal) => void this.#onChildExit(record, code, signal));
    this.logger.launcher('info', `已启动翻译服务子进程 PID ${record.pid}，等待端口 ${port} 和健康检查。`);
    const deadline = Date.now() + this.startupTimeout;
    let healthResult = null;
    while (Date.now() < deadline && this.runtime.isProcessAlive(record.pid)) {
      if (await this.runtime.isPortOccupied(port)) {
        healthResult = await this.runtime.healthCheck(port, { pid: record.pid, instanceId: record.instanceId });
        if (healthResult.healthy) break;
      }
      await this.runtime.delay(100);
    }
    if (!healthResult?.healthy) {
      const message = this.runtime.isProcessAlive(record.pid) ? `服务在端口 ${port} 的健康检查超时。` : '翻译服务在健康检查前退出。';
      this.lastError = message;
      await this.#terminateOwnedRecord(record);
      this.#setState('failed', message);
      throw Object.assign(new Error(message), { code: 'SERVICE_START_FAILED' });
    }
    this.health = healthResult.health;
    this.state = 'running';
    this.logger.launcher('info', `翻译服务健康检查成功，PID ${record.pid}，端口 ${port}。`);
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => { this.restartAttempts = 0; }, this.stableResetMs);
    this.stableTimer.unref?.();
    this.#emitStatus();
  }

  async #stopInternal({ finalState = 'stopped' } = {}) {
    const record = this.record;
    const childAtStop = this.child;
    if (!record) { this.#setState(finalState); return; }
    this.#setState(finalState === 'stopped' ? 'stopping' : finalState);
    this.expectedExit = true;
    this.logger.launcher('info', `准备停止翻译服务 PID ${record.pid}，端口 ${record.port}。`);
    const verified = await this.runtime.healthCheck(record.port, { pid: record.pid, instanceId: record.instanceId });
    if (verified.healthy) {
      try { await this.runtime.requestShutdown(record.port, record.controlToken); }
      catch (error) { this.logger.launcher('warn', `优雅关闭请求失败：${error.message}`); }
    }
    const released = await this.#waitUntil(async () => !this.runtime.isProcessAlive(record.pid) && !(await this.runtime.isPortOccupied(record.port)), this.stopTimeout);
    if (!released && this.runtime.isProcessAlive(record.pid)) {
      const stillOwned = await this.runtime.healthCheck(record.port, { pid: record.pid, instanceId: record.instanceId });
      const isDirectChild = this.child?.pid === record.pid;
      if (!stillOwned.healthy && !isDirectChild) {
        this.expectedExit = false;
        throw Object.assign(new Error('无法确认记录的 PID 仍属于本启动器，已拒绝强制结束。'), { code: 'OWNERSHIP_UNVERIFIED' });
      }
      this.logger.launcher('warn', `优雅关闭超时，只结束已记录并确认的 PID ${record.pid}。`);
      this.runtime.terminateProcess(record.pid);
    }
    const finalRelease = await this.#waitUntil(async () => !this.runtime.isProcessAlive(record.pid) && !(await this.runtime.isPortOccupied(record.port)), this.releaseTimeout);
    if (!finalRelease) {
      this.expectedExit = false;
      throw Object.assign(new Error(`服务退出后端口 ${record.port} 未按时释放。`), { code: 'PORT_RELEASE_TIMEOUT' });
    }
    if (childAtStop?.stdout && 'destroyed' in childAtStop.stdout) {
      await this.#waitUntil(() => childAtStop.stdout.destroyed && childAtStop.stderr.destroyed, 2000);
    }
    if (this.record?.instanceId === record.instanceId) this.record = null;
    this.child = null; this.health = null; this.#deleteRecord(); this.expectedExit = false;
    this.#setState(finalState);
    this.logger.launcher('info', `翻译服务已停止，端口 ${record.port} 已释放。`);
  }

  async #terminateOwnedRecord(record) {
    if (!record || !this.runtime.isProcessAlive(record.pid)) return;
    const verified = await this.runtime.healthCheck(record.port, { pid: record.pid, instanceId: record.instanceId });
    if (verified.healthy) {
      try { await this.runtime.requestShutdown(record.port, record.controlToken); } catch {}
      if (await this.#waitUntil(() => !this.runtime.isProcessAlive(record.pid), 1500)) return;
    }
    if (this.child?.pid === record.pid || verified.healthy) this.runtime.terminateProcess(record.pid);
  }

  async #onChildExit(record, code, signal) {
    const isCurrent = this.record?.instanceId === record.instanceId;
    if (!isCurrent) return;
    const wasExpected = this.expectedExit;
    const previousState = this.state;
    this.lastExit = { pid: record.pid, port: record.port, code, signal, at: new Date().toISOString() };
    this.record = null; this.child = null; this.health = null; this.#deleteRecord();
    this.logger.launcher(wasExpected ? 'info' : 'error', `翻译服务 PID ${record.pid} 已退出。`, this.lastExit);
    if (wasExpected || ['stopping', 'restarting', 'switching-port'].includes(previousState)) { this.#emitStatus(); return; }
    this.#setState('failed', `翻译服务异常退出（代码 ${code ?? '未知'}）。`);
    if (previousState === 'running' && this.settings.autoRestartService) this.#scheduleAutoRestart();
  }

  #scheduleAutoRestart() {
    if (this.restartAttempts >= 3) {
      this.#setState('failed', '翻译服务连续自动重启已达到 3 次，已停止重试。');
      return;
    }
    const attempt = ++this.restartAttempts;
    const wait = this.restartDelays[Math.min(attempt - 1, this.restartDelays.length - 1)];
    this.logger.launcher('warn', `翻译服务将在 ${wait}ms 后进行第 ${attempt}/3 次自动重启。`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      try { await this.lock.run('自动重启服务', () => this.#startInternal(this.settings.servicePort, { automatic: true })); }
      catch (error) {
        this.#setState('failed', `自动重启失败：${error.message}`);
        if (error.code !== 'PORT_IN_USE' && this.settings.autoRestartService) this.#scheduleAutoRestart();
      }
    }, wait);
    this.restartTimer.unref?.();
  }

  async #monitorRecoveredProcess() {
    if (this.lock.locked || this.state !== 'running' || !this.record || this.child) return;
    const record = this.record;
    if (this.runtime.isProcessAlive(record.pid)) return;
    this.record = null; this.health = null; this.#deleteRecord();
    this.lastExit = { pid: record.pid, port: record.port, code: null, signal: 'lost', at: new Date().toISOString() };
    this.#setState('failed', '已恢复的翻译服务进程异常退出。');
    this.logger.launcher('error', this.lastError, this.lastExit);
    if (this.settings.autoRestartService) this.#scheduleAutoRestart();
  }

  #portInUse(port) {
    return Object.assign(new Error(`端口 ${port} 已被未知程序占用；启动器不会结束该程序或自动改用其他端口。`), { code: 'PORT_IN_USE', status: 409 });
  }

  async #waitUntil(predicate, timeout) {
    const deadline = Date.now() + timeout;
    do {
      if (await predicate()) return true;
      await this.runtime.delay(100);
    } while (Date.now() < deadline);
    return false;
  }

  #setState(state, error = '') {
    this.state = state;
    if (error) this.lastError = error;
    this.#emitStatus();
  }

  #emitStatus() { this.emit('status', { state: this.state, busy: this.lock.locked, activeOperation: this.lock.activeOperation }); }

  #readRecord() {
    try {
      const value = JSON.parse(fs.readFileSync(this.recordFile, 'utf8'));
      if (!Number.isInteger(Number(value.pid)) || !Number.isInteger(Number(value.port)) || !value.instanceId || !value.controlToken) return null;
      return { ...value, pid: Number(value.pid), port: Number(value.port) };
    } catch { return null; }
  }

  #writeRecord(record) {
    const temporary = `${this.recordFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      if (fs.existsSync(this.recordFile)) fs.unlinkSync(this.recordFile);
      fs.renameSync(temporary, this.recordFile);
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
  }

  #deleteRecord() { try { if (fs.existsSync(this.recordFile)) fs.unlinkSync(this.recordFile); } catch {} }
}
