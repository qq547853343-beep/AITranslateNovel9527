import net from 'node:net';
import http from 'node:http';

export function validatePort(value, { managementPort = 7000 } = {}) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('端口必须是 1 到 65535 之间的整数。'), { code: 'INVALID_PORT', status: 400 });
  }
  if (port === managementPort) {
    throw Object.assign(new Error(`翻译服务端口不能与启动器管理端口 ${managementPort} 相同。`), { code: 'PORT_CONFLICT', status: 400 });
  }
  return port;
}

export function isPortOccupied(port, { host = '127.0.0.1', timeout = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function waitForPort(port, occupied, { timeout = 10_000, interval = 100, probe = isPortOccupied } = {}) {
  const deadline = Date.now() + timeout;
  do {
    if (await probe(port) === occupied) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  return false;
}

export function requestJson({ port, path = '/api/health', method = 'GET', headers = {}, timeout = 1200 }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body || {});
        else reject(Object.assign(new Error(body?.error || `HTTP ${response.statusCode}`), { status: response.statusCode }));
      });
    });
    request.once('timeout', () => request.destroy(new Error('请求超时。')));
    request.once('error', reject);
    request.end();
  });
}

export async function checkServiceHealth(port, expected = {}) {
  try {
    const health = await requestJson({ port });
    const healthy = health?.status === 'ok'
      && health?.service === 'AITranslateNovel9527'
      && (!expected.instanceId || health.instanceId === expected.instanceId)
      && (!expected.pid || Number(health.pid) === Number(expected.pid));
    return { healthy, health };
  } catch (error) {
    return { healthy: false, health: null, error: error.message };
  }
}

export async function requestServiceShutdown(port, token) {
  return requestJson({
    port,
    path: '/api/launcher/shutdown',
    method: 'POST',
    headers: { 'x-launcher-control-token': token, 'content-length': '0' },
    timeout: 1500
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

export function terminateRecordedProcess(pid) {
  process.kill(Number(pid), 'SIGTERM');
}
