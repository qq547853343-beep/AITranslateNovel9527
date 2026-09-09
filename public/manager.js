const { createApp } = Vue;

createApp({
  data: () => ({
    view: 'overview', apiAvailable: Boolean(window.launcher), snapshot: { state: 'stopped', settings: { servicePort: 6501 } },
    servicePortDraft: 6501, busyLocal: false, errorMessage: '', notice: '', scanStart: 6500, scanEnd: 6501,
    scanResults: [], scanning: false, logs: [], logKind: 'all', logFilter: 'all', updateStatus: {}, pollTimer: null, unsubscribe: null
  }),
  computed: {
    busy() { return this.busyLocal || this.snapshot.busy; },
    viewTitle() { return ({ overview:'服务概览', logs:'运行日志', settings:'启动设置' })[this.view]; },
    stateLabel() { return ({ stopped:'服务已停止', starting:'正在启动', running:'服务正常', stopping:'正在停止', restarting:'正在重启', 'switching-port':'正在切换端口', failed:'服务异常', unknown:'状态未知' })[this.snapshot.state] || this.snapshot.state; },
    lastExitText() { const value = this.snapshot.lastExit; return value ? `${this.formatTime(value.at)} · ${value.code ?? value.signal ?? '未知'}` : '—'; },
    filteredLogs() { if (this.logFilter === 'all') return this.logs; const marker = this.logFilter === 'error' ? '[ERROR]' : '[WARN]'; return this.logs.filter((line) => line.includes(marker)); }
  },
  async mounted() {
    if (!this.apiAvailable) { this.errorMessage = '当前页面没有安全 preload API，无法执行启动器操作。'; return; }
    this.unsubscribe = window.launcher.onStatus((value) => this.applySnapshot(value));
    await this.refreshAll();
    this.pollTimer = setInterval(() => this.refreshSnapshot(true), 2000);
  },
  beforeUnmount() { clearInterval(this.pollTimer); this.unsubscribe?.(); },
  methods: {
    applySnapshot(value) { if (!value) return; this.snapshot = value; if (!this.busyLocal) this.servicePortDraft = value.servicePort || 6501; },
    async refreshSnapshot(silent = false) { try { this.applySnapshot(await window.launcher.getSnapshot()); } catch (error) { if (!silent) this.errorMessage = error.message; } },
    async refreshAll() { await Promise.all([this.refreshSnapshot(), this.refreshLogs()]); },
    async run(action, successMessage) {
      this.busyLocal = true; this.errorMessage = ''; this.notice = '';
      try { this.applySnapshot(await action()); if (successMessage) this.notice = successMessage; }
      catch (error) { this.errorMessage = error.message || String(error); }
      finally { this.busyLocal = false; await this.refreshSnapshot(true); }
    },
    operate(type) { const calls = { start: window.launcher.startService, stop: window.launcher.stopService, restart: window.launcher.restartService }; const labels = { start:'翻译服务已启动', stop:'翻译服务已停止', restart:'翻译服务已重启' }; return this.run(() => calls[type](), labels[type]); },
    async savePort() { const port = Number(this.servicePortDraft); await this.run(() => window.launcher.setServicePort(port), `翻译服务端口已安全切换为 ${port}`); },
    async changeSetting(key, value) { await this.run(() => window.launcher.updateSettings({ [key]: value }), '启动设置已保存'); },
    async scanPorts() { this.scanning = true; this.errorMessage = ''; try { const result = await window.launcher.scanPorts(Number(this.scanStart), Number(this.scanEnd || this.scanStart)); this.scanResults = result.ports; } catch (error) { this.errorMessage = error.message; } finally { this.scanning = false; } },
    async refreshLogs() { if (!this.apiAvailable) return; try { const result = await window.launcher.getLogs(this.logKind, 200); this.logs = result.lines || []; } catch (error) { this.errorMessage = error.message; } },
    async openService() { try { await window.launcher.openService(); } catch (error) { this.errorMessage = error.message; } },
    async checkUpdate() { try { this.updateStatus = await window.launcher.checkForUpdates(); this.notice = '自动更新占位接口响应正常'; } catch (error) { this.errorMessage = error.message; } },
    formatTime(value) { return value ? new Date(value).toLocaleString() : '—'; },
    portStateLabel(value) { return ({ free:'空闲', 'occupied-by-service':'本服务占用', 'occupied-by-unknown':'未知程序占用' })[value] || value; },
    logClass(line) { return line.includes('[ERROR]') ? 'error' : line.includes('[WARN]') ? 'warn' : ''; }
  }
}).mount('#launcher');
