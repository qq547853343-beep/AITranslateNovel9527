import { detectImageFormat } from './image-format.js';
import { createStoredZip } from './zip-writer.js';

const archiveLimit = 20 * 1024 * 1024;
const imageLimit = 8 * 1024 * 1024;

export async function buildWebContentPackage(selection, { fetchImpl = fetch, now = () => new Date(), extensionVersion = '0.2.0', onProgress = () => {} } = {}) {
  validateSelection(selection);
  const imageBlocks = selection.blocks.filter((block) => block.kind === 'image');
  const sources = [...new Set(imageBlocks.map((block) => block.sourceUrl))];
  if (sources.length > 497) throw new Error('选区图片过多，标准包最多允许 497 张图片。');
  const assets = new Map();
  for (let index = 0; index < sources.length; index += 1) {
    onProgress({ current: index + 1, total: sources.length, sourceUrl: sources[index] });
    const bytes = await downloadImage(sources[index], fetchImpl);
    const format = detectImageFormat(bytes);
    if (!format) throw new Error(`图片格式不受支持：${sources[index]}。仅支持 PNG、JPEG、GIF 和 WebP；SVG 不会原样导出。`);
    assets.set(sources[index], { path: `assets/image-${String(index + 1).padStart(3, '0')}.${format.extension}`, bytes, ...format });
  }
  const blocks = selection.blocks.map((block, index) => block.kind === 'text'
    ? { id: `text-${index}`, kind: 'text', tag: allowedTag(block.tag), text: String(block.text || '').replace(/\r\n/g, '\n') }
    : { id: `image-${index}`, kind: 'image', assetPath: assets.get(block.sourceUrl).path, alt: String(block.alt || '').slice(0, 200), width: dimension(block.width, 900), height: dimension(block.height, 600) });
  const createdAt = now().toISOString();
  const manifest = { format: 'AITranslateNovel9527.web-content', version: '1.0', createdAt, generator: { name: 'AITranslateNovel9527 Selection Exporter', version: extensionVersion } };
  const documentValue = { schemaVersion: 1, title: cleanTitle(selection.title), language: String(selection.language || '').slice(0, 40), sourceUrl: validHttpUrl(selection.sourceUrl), blocks, metadata: { capturedAt: createdAt, imageCount: sources.length } };
  const files = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'document.json', data: JSON.stringify(documentValue, null, 2) },
    { name: 'content.html', data: previewHtml(documentValue) },
    ...[...assets.values()].map((asset) => ({ name: asset.path, data: asset.bytes })),
  ];
  const zip = createStoredZip(files, { date: now() });
  if (zip.length > archiveLimit) throw new Error('生成的 ZIP 超过 20 MB，请缩小选区或减少图片。');
  return { zip, filename: `${safeFilename(documentValue.title)}_${createdAt.replace(/[:.]/g, '-')}.zip`, manifest, document: documentValue, assets: [...assets.values()].map(({ bytes, ...asset }) => asset) };
}

async function downloadImage(sourceUrl, fetchImpl) {
  let url; try { url = new URL(sourceUrl); } catch { throw new Error(`图片地址无效：${sourceUrl}`); }
  if (!['http:', 'https:', 'data:'].includes(url.protocol)) throw new Error(`图片协议不受支持：${url.protocol}`);
  const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-cache' });
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）：${url.href}`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > imageLimit) throw new Error(`图片超过 8 MB：${url.href}`);
  if (!response.body?.getReader) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.length > imageLimit) throw new Error(`图片超过 8 MB：${url.href}`);
    return value;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > imageLimit) { await reader.cancel(); throw new Error(`图片超过 8 MB：${url.href}`); } chunks.push(value); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

function validateSelection(selection) {
  if (!selection || !Array.isArray(selection.blocks) || !selection.blocks.length) throw new Error('选区中没有可导出的内容。');
  if (selection.blocks.length > 500) throw new Error('选区内容块超过 500 个，请缩小选区。');
  let characters = 0;
  for (const block of selection.blocks) { if (block.kind === 'text') characters += String(block.text || '').length; else if (block.kind !== 'image' || !block.sourceUrl) throw new Error('选区包含无效内容块。'); }
  if (characters > 200_000) throw new Error('选区文字超过 200,000 字符，请缩小选区。');
}
function allowedTag(value) { return ['p', 'h1', 'h2', 'h3', 'blockquote', 'li'].includes(value) ? value : 'p'; }
function dimension(value, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(1, Math.min(4000, Math.round(number))) : fallback; }
function cleanTitle(value) { return String(value || 'web-content').trim().slice(0, 100) || 'web-content'; }
function safeFilename(value) { return cleanTitle(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'web-content'; }
function validHttpUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href.slice(0, 4096) : ''; } catch { return ''; } }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function previewHtml(documentValue) { const body = documentValue.blocks.map((block) => block.kind === 'image' ? `<figure><img src="${escapeHtml(block.assetPath)}" alt="${escapeHtml(block.alt)}" width="${block.width}" height="${block.height}"></figure>` : `<${block.tag}>${escapeHtml(block.text).replace(/\n/g, '<br>')}</${block.tag}>`).join('\n'); return `<!doctype html><html lang="${escapeHtml(documentValue.language)}"><head><meta charset="utf-8"><title>${escapeHtml(documentValue.title)}</title></head><body>${body}</body></html>`; }
