import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../lib/database.js';
import { SettingsRepository } from '../lib/repositories.js';
import { LAUNCHER_MANAGEMENT_PORT, LauncherSettingsStore } from './launcher-settings.js';
import { RotatingLogger } from './rotating-logger.js';
import { ServiceController } from './service-controller.js';
import { createManagementServer } from './management-server.js';
import { acquireGlobalInstanceLock } from './global-instance-lock.js';

const gotSingleInstanceLock = app.requestSingleInstanceLock();
const globalLockFile = path.join(app.getPath('temp'), 'AITranslateNovel9527-launcher.lock');
const globalInstanceLock = gotSingleInstanceLock ? acquireGlobalInstanceLock(globalLockFile) : null;
const ownsAllInstanceLocks = gotSingleInstanceLock && globalInstanceLock?.acquired;
if (!ownsAllInstanceLocks) app.quit();
process.once('exit', () => globalInstanceLock?.release());

let mainWindow = null;
let tray = null;
let controller = null;
let database = null;
let logger = null;
let management = null;
let managementError = '';
let quitting = false;
let quitPromise = null;
let trustedManagerFileUrl = '';

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

app.on('second-instance', () => showWindow());

if (ownsAllInstanceLocks) app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox('AITranslateNovel9527 启动失败', error.message || String(error));
  app.exit(1);
});

async function bootstrap() {
  const appRoot = app.getAppPath();
  const dataDirectory = app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(appRoot, 'data');
  const logsDirectory = path.join(dataDirectory, 'logs');
  logger = new RotatingLogger(logsDirectory);
  logger.launcher('info', 'Electron 启动器正在启动。', { version: app.getVersion(), packaged: app.isPackaged });
  database = openDatabase(path.join(dataDirectory, 'app.db'));
  const settingsStore = new LauncherSettingsStore(new SettingsRepository(database));
  controller = new ServiceController({
    settingsStore,
    logger,
    dataDirectory,
    serverEntry: path.join(appRoot, 'server.js'),
    workDirectory: app.isPackaged ? process.resourcesPath : appRoot,
    onSettingsChanged: applyLoginSettings
  });
  await controller.initialize();

  management = createManagementServer({
    publicDirectory: path.join(appRoot, 'public'),
    vueFile: path.join(appRoot, 'node_modules', 'vue', 'dist', 'vue.global.prod.js'),
    port: LAUNCHER_MANAGEMENT_PORT
  });
  try {
    await management.start();
    logger.launcher('info', `启动器管理页面正在监听 127.0.0.1:${LAUNCHER_MANAGEMENT_PORT}。`);
  } catch (error) {
    managementError = `固定管理端口 ${LAUNCHER_MANAGEMENT_PORT} 无法监听：${error.message}`;
    logger.launcher('error', managementError);
  }

  createWindow(appRoot);
  createTray();
  registerIpc();
  controller.on('status', async () => broadcastSnapshot());

  const hidden = process.argv.includes('--hidden') || (controller.settings.startHidden && !process.argv.includes('--show'));
  if (!hidden) showWindow();
  if (controller.settings.autoStartService && controller.state !== 'running') {
    try { await controller.start(); }
    catch (error) { logger.launcher('error', `自动启动翻译服务失败：${error.message}`); }
  }

  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit({ confirmActive: false });
  });
}

function createWindow(appRoot) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 560,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e1420',
    title: 'AITranslateNovel9527 启动器',
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  const managerFile = path.join(appRoot, 'public', 'manager.html');
  trustedManagerFileUrl = pathToFileURL(managerFile).href;
  if (managementError) mainWindow.loadFile(managerFile);
  else mainWindow.loadURL(`http://127.0.0.1:${LAUNCHER_MANAGEMENT_PORT}/`);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url === `http://127.0.0.1:${LAUNCHER_MANAGEMENT_PORT}/` || url === trustedManagerFileUrl;
    if (!allowed) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault(); mainWindow.hide();
  });
}

function trayImage() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#7188ff"/><text x="16" y="23" text-anchor="middle" font-family="Segoe UI" font-size="20" font-weight="700" fill="white">译</text></svg>';
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('AITranslateNovel9527 启动器');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开启动器', click: showWindow },
    { label: '打开翻译页面', click: () => void openService() },
    { type: 'separator' },
    { label: '启动服务', click: () => void runTrayAction(() => controller.start()) },
    { label: '停止服务', click: () => void runTrayAction(() => controller.stop()) },
    { label: '重启服务', click: () => void runTrayAction(() => controller.restart()) },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit({ confirmActive: true }) }
  ]));
  tray.on('double-click', showWindow);
}

async function runTrayAction(action) {
  try { await action(); }
  catch (error) { logger.launcher('error', error.message); showWindow(); }
}

async function requestQuit({ confirmActive }) {
  if (quitPromise) return quitPromise;
  quitPromise = (async () => {
    if (confirmActive && await controller.hasActiveTranslation()) {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '停止服务并退出'], defaultId: 0, cancelId: 0,
        title: '翻译任务仍在进行', message: '退出启动器会停止正在运行的翻译服务。', detail: '已完成分段仍会保存在本地，可在下次启动时恢复。'
      });
      if (answer.response === 0) { quitPromise = null; return; }
    }
    logger.launcher('info', 'Electron 启动器正在退出。');
    await controller.shutdownForExit();
    try { await management?.close(); } catch {}
    try { database?.close(); } catch {}
    quitting = true;
    app.quit();
  })();
  return quitPromise;
}

async function applyLoginSettings(settings) {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.autoStartLauncher),
    openAsHidden: Boolean(settings.startHidden),
    args: settings.startHidden ? ['--hidden'] : []
  });
}

function registerIpc() {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, payload) => {
    assertTrustedRenderer(event);
    return action(payload);
  });
  handle('launcher:get-snapshot', async () => ({ ...await controller.getSnapshot(), managementError }));
  handle('launcher:start', () => controller.start());
  handle('launcher:stop', () => controller.stop());
  handle('launcher:restart', () => controller.restart());
  handle('launcher:set-service-port', ({ port } = {}) => controller.switchPort(port));
  handle('launcher:update-settings', (changes = {}) => controller.updateSettings(changes));
  handle('launcher:scan-ports', ({ start, end } = {}) => controller.scanPorts(start, end));
  handle('launcher:get-logs', ({ kind, lines } = {}) => ({ lines: logger.readRecent(kind, lines), kind: kind || 'all' }));
  handle('launcher:open-service', openService);
  handle('launcher:check-update', () => ({ status: 'placeholder', supported: false, checkedAt: new Date().toISOString(), message: 'ver0.3 仅预留自动更新接口，不执行下载、安装、替换或回滚。' }));
}

function assertTrustedRenderer(event) {
  const source = event.senderFrame?.url || event.sender?.getURL?.() || '';
  const trustedOrigin = `http://127.0.0.1:${LAUNCHER_MANAGEMENT_PORT}`;
  const trustedHttp = source === `${trustedOrigin}/` || source === `${trustedOrigin}/manager.html`;
  const trustedFile = Boolean(trustedManagerFileUrl) && source === trustedManagerFileUrl;
  if (!trustedHttp && !trustedFile) throw new Error('已拒绝来自非启动器页面的 IPC 请求。');
}

async function openService() {
  const snapshot = await controller.getSnapshot();
  if (!snapshot.normal) throw new Error('翻译服务尚未通过进程、端口和健康检查。');
  await shell.openExternal(`http://127.0.0.1:${snapshot.activePort}/`);
  return true;
}

async function broadcastSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('launcher:status', { ...await controller.getSnapshot(), managementError }); } catch {}
}
