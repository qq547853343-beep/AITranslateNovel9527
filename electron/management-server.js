import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function createManagementServer({ publicDirectory, vueFile, port = 7000, host = '127.0.0.1' }) {
  const routes = new Map([
    ['/', path.join(publicDirectory, 'manager.html')],
    ['/manager.html', path.join(publicDirectory, 'manager.html')],
    ['/manager.js', path.join(publicDirectory, 'manager.js')],
    ['/manager.css', path.join(publicDirectory, 'manager.css')],
    ['/vendor/vue.js', vueFile],
    ['/node_modules/vue/dist/vue.global.prod.js', vueFile]
  ]);
  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (request.method !== 'GET' || !routes.has(new URL(request.url, `http://${host}`).pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return;
    }
    const file = routes.get(new URL(request.url, `http://${host}`).pathname);
    try {
      const content = fs.readFileSync(file);
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); response.end(content);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Launcher asset unavailable');
    }
  });
  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
