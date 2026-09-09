import JSZip from 'jszip';
import { isSafePackagePath, WebPackageValidationError } from '../domain/web-package.js';

export const DEFAULT_WEB_PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 20 * 1024 * 1024,
  fileCount: 500,
  expandedBytes: 50 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  compressionRatio: 100,
});

export class WebPackageReader {
  constructor({ limits = {} } = {}) { this.limits = { ...DEFAULT_WEB_PACKAGE_LIMITS, ...limits }; }

  async read(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw problem('请选择有效的 ZIP 文件。', 'WEB_PACKAGE_ARCHIVE_REQUIRED');
    if (buffer.length > this.limits.archiveBytes) throw problem('ZIP 文件不能超过 20 MB。', 'WEB_PACKAGE_ARCHIVE_TOO_LARGE', 413);
    let zip;
    try { zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: true }); }
    catch (error) { throw problem(`ZIP 文件无法读取：${error.message}`, 'WEB_PACKAGE_ARCHIVE_INVALID'); }
    const entries = Object.values(zip.files);
    if (entries.length > this.limits.fileCount) throw problem('ZIP 文件数量超过安全限制。', 'WEB_PACKAGE_FILE_COUNT_EXCEEDED', 413);
    for (const entry of entries.filter((item) => item.dir)) if (entry.name !== 'assets/') throw problem('ZIP 包含不安全或不支持的目录。', 'WEB_PACKAGE_PATH_UNSAFE');
    const files = entries.filter((entry) => !entry.dir);
    let expandedBytes = 0;
    for (const entry of files) {
      const originalName = entry.unsafeOriginalName || entry.name;
      if (!isSafePackagePath(originalName) || originalName !== entry.name) throw problem('ZIP 包含不安全的文件路径。', 'WEB_PACKAGE_PATH_UNSAFE');
      if (!isAllowedEntry(entry.name)) throw problem(`ZIP 包含不支持的文件：${entry.name}`, 'WEB_PACKAGE_FILE_UNSUPPORTED');
      const uncompressed = Number(entry._data?.uncompressedSize || 0);
      const compressed = Number(entry._data?.compressedSize || 0);
      const entryLimit = entry.name.endsWith('.json') ? this.limits.jsonBytes : entry.name === 'content.html' ? this.limits.htmlBytes : this.limits.entryBytes;
      if (!Number.isSafeInteger(uncompressed) || uncompressed < 0 || uncompressed > entryLimit) throw problem(`ZIP 文件 ${entry.name} 超过大小限制。`, 'WEB_PACKAGE_ENTRY_TOO_LARGE', 413);
      if (uncompressed > 0 && uncompressed / Math.max(1, compressed) > this.limits.compressionRatio) throw problem(`ZIP 文件 ${entry.name} 的压缩比异常。`, 'WEB_PACKAGE_COMPRESSION_RATIO_EXCEEDED', 413);
      expandedBytes += uncompressed;
      if (expandedBytes > this.limits.expandedBytes) throw problem('ZIP 解压后总大小超过安全限制。', 'WEB_PACKAGE_EXPANDED_TOO_LARGE', 413);
    }
    for (const name of ['manifest.json', 'document.json', 'content.html']) if (!zip.file(name)) throw problem(`ZIP 缺少 ${name}。`, 'WEB_PACKAGE_REQUIRED_FILE_MISSING', 400, { name });
    const manifest = await readJson(zip.file('manifest.json'), 'manifest.json');
    const document = await readJson(zip.file('document.json'), 'document.json');
    await zip.file('content.html').async('string');
    const assets = new Map();
    for (const entry of files) if (entry.name.startsWith('assets/')) assets.set(entry.name, await entry.async('nodebuffer'));
    return { manifest, document, assets, previewSource: 'document.json' };
  }
}

async function readJson(entry, name) {
  try { return JSON.parse(await entry.async('string')); }
  catch (error) { throw problem(`${name} 不是有效 JSON：${error.message}`, 'WEB_PACKAGE_JSON_INVALID', 400, { name }); }
}
function isAllowedEntry(name) { return ['manifest.json', 'document.json', 'content.html'].includes(name) || /^assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)$/i.test(name); }
function problem(message, code, status = 400, details) { return new WebPackageValidationError(message, { code, status, details }); }
