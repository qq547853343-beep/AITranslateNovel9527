import { detectImageFormat } from './image-format.js';
import { createStoredZip } from './zip-writer.js';
import { validateSafeSvg } from './svg-validator.js';

const archiveLimit = 200 * 1024 * 1024;
const imageLimit = 20 * 1024 * 1024;
const blockLimit = 5_000;
const imageCountLimit = 2_000;

export async function buildWebContentPackage(selection, { fetchImpl = fetch, now = () => new Date(), extensionVersion = '0.2.0', onProgress = () => {}, rasterizeSvg = rasterizeSvgToPng } = {}) {
  validateSelection(selection);
  const imageBlocks = selection.blocks.filter((block) => block.kind === 'image');
  const sources = [...new Set(imageBlocks.map((block) => block.sourceUrl))];
  if (sources.length > imageCountLimit) throw new Error(`选区图片过多，标准包最多允许 ${imageCountLimit.toLocaleString('en-US')} 张图片。`);
  const assets = new Map();
  let downloadedBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    onProgress({ current: index + 1, total: sources.length, sourceUrl: sources[index] });
    const bytes = await downloadImage(sources[index], fetchImpl);
    downloadedBytes += bytes.length;
    if (downloadedBytes > archiveLimit - (10 * 1024 * 1024)) throw new Error('图片总大小过大，生成的 ZIP 将超过 200 MB。');
    let format = detectImageFormat(bytes);
    const sequence = String(index + 1).padStart(3, '0');
    if (!format && looksLikeSvg(bytes)) {
      format = validateSafeSvg(bytes);
      const occurrences = imageBlocks.filter((block) => block.sourceUrl === sources[index]);
      const width = Math.max(...occurrences.map((block) => dimension(block.width, 900)));
      const height = Math.max(...occurrences.map((block) => dimension(block.height, 600)));
      const previewBytes = await rasterizeSvg(bytes, { width, height, sourceUrl: sources[index] });
      const previewFormat = detectImageFormat(previewBytes);
      if (previewFormat?.extension !== 'png') throw new Error(`SVG 安全预览生成失败：${sources[index]}`);
      if (previewBytes.length > imageLimit) throw new Error(`SVG 的 PNG 预览超过 20 MB：${sources[index]}`);
      downloadedBytes += previewBytes.length;
      if (downloadedBytes > archiveLimit - (10 * 1024 * 1024)) throw new Error('图片总大小过大，生成的 ZIP 将超过 200 MB。');
      assets.set(sources[index], { path: `assets/image-${sequence}.svg`, previewPath: `assets/image-${sequence}.preview.png`, bytes, previewBytes, ...format });
      continue;
    }
    if (!format) throw new Error(`图片格式不受支持：${sources[index]}。仅支持 PNG、JPEG、GIF、WebP 和安全 SVG。`);
    assets.set(sources[index], { path: `assets/image-${sequence}.${format.extension}`, bytes, ...format });
  }
  const blocks = selection.blocks.map((block, index) => block.kind === 'text'
    ? { id: `text-${index}`, kind: 'text', tag: allowedTag(block.tag), text: String(block.text || '').replace(/\r\n/g, '\n') }
    : { id: `image-${index}`, kind: 'image', assetPath: assets.get(block.sourceUrl).path, ...(assets.get(block.sourceUrl).previewPath ? { previewAssetPath: assets.get(block.sourceUrl).previewPath } : {}), alt: String(block.alt || '').slice(0, 200), width: dimension(block.width, 900), height: dimension(block.height, 600) });
  const createdAt = now().toISOString();
  const manifest = { format: 'AITranslateNovel9527.web-content', version: '1.0', createdAt, generator: { name: 'AITranslateNovel9527 Selection Exporter', version: extensionVersion } };
  const documentValue = { schemaVersion: 1, title: cleanTitle(selection.title), language: String(selection.language || '').slice(0, 40), sourceUrl: validHttpUrl(selection.sourceUrl), blocks, metadata: { capturedAt: createdAt, imageCount: sources.length } };
  const files = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'document.json', data: JSON.stringify(documentValue, null, 2) },
    { name: 'content.html', data: previewHtml(documentValue) },
    ...[...assets.values()].flatMap((asset) => [{ name: asset.path, data: asset.bytes }, ...(asset.previewPath ? [{ name: asset.previewPath, data: asset.previewBytes }] : [])]),
  ];
  const zip = createStoredZip(files, { date: now() });
  if (zip.length > archiveLimit) throw new Error('生成的 ZIP 超过 200 MB，请缩小选区或减少图片。');
  return { zip, filename: `${safeFilename(documentValue.title)}_${createdAt.replace(/[:.]/g, '-')}.zip`, manifest, document: documentValue, assets: [...assets.values()].map(({ bytes, previewBytes, ...asset }) => asset) };
}

async function downloadImage(sourceUrl, fetchImpl) {
  let url; try { url = new URL(sourceUrl); } catch { throw new Error(`图片地址无效：${sourceUrl}`); }
  if (!['http:', 'https:', 'data:'].includes(url.protocol)) throw new Error(`图片协议不受支持：${url.protocol}`);
  const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-cache' });
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）：${url.href}`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > imageLimit) throw new Error(`图片超过 20 MB：${url.href}`);
  if (!response.body?.getReader) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.length > imageLimit) throw new Error(`图片超过 20 MB：${url.href}`);
    return value;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > imageLimit) { await reader.cancel(); throw new Error(`图片超过 20 MB：${url.href}`); } chunks.push(value); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

function validateSelection(selection) {
  if (!selection || !Array.isArray(selection.blocks) || !selection.blocks.length) throw new Error('选区中没有可导出的内容。');
  if (selection.blocks.length > blockLimit) throw new Error(`选区内容块超过 ${blockLimit.toLocaleString('en-US')} 个，请缩小选区。`);
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
function previewHtml(documentValue) { const body = documentValue.blocks.map((block) => block.kind === 'image' ? `<figure><img src="${escapeHtml(block.previewAssetPath || block.assetPath)}" alt="${escapeHtml(block.alt)}" width="${block.width}" height="${block.height}"></figure>` : `<${block.tag}>${escapeHtml(block.text).replace(/\n/g, '<br>')}</${block.tag}>`).join('\n'); return `<!doctype html><html lang="${escapeHtml(documentValue.language)}"><head><meta charset="utf-8"><title>${escapeHtml(documentValue.title)}</title></head><body>${body}</body></html>`; }

function looksLikeSvg(bytes) {
  try { return /^(?:\uFEFF|\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)*<svg\b/i.test(new TextDecoder().decode(bytes.subarray(0, 4096))); } catch { return false; }
}

async function rasterizeSvgToPng(bytes, { width, height }) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('当前环境无法生成 SVG 安全预览。');
  const blob = new Blob([bytes], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('SVG 无法作为图片解码。')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = dimension(width || image.naturalWidth, 900);
    canvas.height = dimension(height || image.naturalHeight, 600);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 SVG 预览画布。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const output = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('SVG 预览编码失败。')), 'image/png'));
    return new Uint8Array(await output.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}
