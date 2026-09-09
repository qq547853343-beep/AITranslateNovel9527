import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function importError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ipv4Number(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0;
}

function inIpv4Range(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

export function isPublicIpAddress(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const number = ipv4Number(value);
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, bits]) => inIpv4Range(number, base, bits));
  }
  if (family === 6) {
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIpAddress(mapped[1]);
    return !value.startsWith('::')
      && !/^f[cd]/.test(value)
      && !/^fe[89ab]/.test(value)
      && !value.startsWith('ff')
      && !value.startsWith('64:ff9b:')
      && !value.startsWith('2001:db8:');
  }
  return false;
}

export function validateRemoteImageUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw importError('远程图片地址无效。', 'REMOTE_IMAGE_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw importError('远程图片只允许使用 HTTP 或 HTTPS。', 'REMOTE_IMAGE_PROTOCOL_UNSUPPORTED');
  if (url.username || url.password) throw importError('远程图片地址不能包含用户名或密码。', 'REMOTE_IMAGE_CREDENTIALS_FORBIDDEN');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw importError('远程图片地址不能指向本机。', 'REMOTE_IMAGE_HOST_FORBIDDEN');
  return url;
}

function pinnedRequest(url, address, { timeout = 10_000, maxBytes = MAX_IMAGE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      headers: {
        Host: url.host,
        Accept: 'image/png,image/jpeg;q=0.9,image/gif;q=0.8,image/webp;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        'User-Agent': 'AITranslateNovel9527/0.2 remote-image-importer'
      }
    }, (response) => {
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        response.destroy();
        reject(importError('远程图片超过 8 MB 限制。', 'REMOTE_IMAGE_TOO_LARGE', 413));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(importError('远程图片超过 8 MB 限制。', 'REMOTE_IMAGE_TOO_LARGE', 413));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => resolve({ statusCode: response.statusCode || 0, headers: response.headers, buffer: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(importError('远程图片下载超时。', 'REMOTE_IMAGE_TIMEOUT', 504)));
    request.once('error', reject);
    request.end();
  });
}

export class RemoteImageImporter {
  constructor({ resolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }), requestImage = pinnedRequest, maxBytes = MAX_IMAGE_BYTES, maxRedirects = 3 } = {}) {
    this.resolveHost = resolveHost;
    this.requestImage = requestImage;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
  }

  async fetch(value) {
    return this.#fetch(validateRemoteImageUrl(value), 0);
  }

  async #fetch(url, redirectCount) {
    let addresses;
    try { addresses = await this.resolveHost(url.hostname.replace(/^\[|\]$/g, '')); }
    catch { throw importError('无法解析远程图片主机。', 'REMOTE_IMAGE_DNS_FAILED', 502); }
    const resolved = Array.isArray(addresses) ? addresses : [addresses];
    if (!resolved.length || resolved.some((item) => !isPublicIpAddress(item.address))) {
      throw importError('远程图片地址解析到了本机、私网或保留地址，已拒绝访问。', 'REMOTE_IMAGE_ADDRESS_FORBIDDEN', 403);
    }
    const response = await this.requestImage(url, resolved[0], { maxBytes: this.maxBytes });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (redirectCount >= this.maxRedirects) throw importError('远程图片重定向次数过多。', 'REMOTE_IMAGE_REDIRECT_LIMIT', 502);
      const location = response.headers?.location;
      if (!location) throw importError('远程图片返回了无效重定向。', 'REMOTE_IMAGE_REDIRECT_INVALID', 502);
      return this.#fetch(validateRemoteImageUrl(new URL(location, url).href), redirectCount + 1);
    }
    if (response.statusCode !== 200) throw importError(`远程图片服务器返回 HTTP ${response.statusCode}。`, 'REMOTE_IMAGE_HTTP_FAILED', 502);
    if (!Buffer.isBuffer(response.buffer) || !response.buffer.length) throw importError('远程图片内容为空。', 'REMOTE_IMAGE_EMPTY', 422);
    if (response.buffer.length > this.maxBytes) throw importError('远程图片超过 8 MB 限制。', 'REMOTE_IMAGE_TOO_LARGE', 413);
    return response.buffer;
  }
}
