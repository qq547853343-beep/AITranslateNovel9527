const allowedTextTags = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'li']);
const assetPathPattern = /^assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|svg)$/i;
const previewPathPattern = /^assets\/[A-Za-z0-9._-]+\.png$/i;
export const MAX_WEB_PACKAGE_BLOCKS = 5_000;

export const WEB_PACKAGE_FORMAT = 'AITranslateNovel9527.web-content';
export const WEB_PACKAGE_VERSION = '1.0';

export class WebPackageValidationError extends Error {
  constructor(message, { code = 'WEB_PACKAGE_INVALID', status = 400, details } = {}) {
    super(message);
    this.name = 'WebPackageValidationError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function validateWebPackageManifest(input) {
  if (!plainObject(input)) throw invalid('manifest.json 必须是 JSON 对象。', 'WEB_PACKAGE_MANIFEST_INVALID');
  assertOnlyKeys(input, ['format', 'version', 'createdAt', 'generator'], 'manifest.json');
  if (input.format !== WEB_PACKAGE_FORMAT) throw invalid('manifest.json 的格式名称不受支持。', 'WEB_PACKAGE_FORMAT_UNSUPPORTED');
  if (input.version !== WEB_PACKAGE_VERSION) throw invalid('manifest.json 的格式版本不受支持。', 'WEB_PACKAGE_VERSION_UNSUPPORTED');
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) throw invalid('manifest.json 的创建时间无效。', 'WEB_PACKAGE_CREATED_AT_INVALID');
  if (!plainObject(input.generator)) throw invalid('manifest.json 缺少生成工具信息。', 'WEB_PACKAGE_GENERATOR_INVALID');
  assertOnlyKeys(input.generator, ['name', 'version'], 'manifest.json.generator');
  const name = boundedString(input.generator.name, 1, 100);
  const version = boundedString(input.generator.version, 1, 40);
  if (!name || !version) throw invalid('manifest.json 的生成工具信息无效。', 'WEB_PACKAGE_GENERATOR_INVALID');
  return { format: input.format, version: input.version, createdAt: new Date(input.createdAt).toISOString(), generator: { name, version } };
}

export function validateWebPackageDocument(input) {
  if (!plainObject(input)) throw invalid('document.json 必须是 JSON 对象。', 'WEB_PACKAGE_DOCUMENT_INVALID');
  assertOnlyKeys(input, ['schemaVersion', 'title', 'language', 'sourceUrl', 'blocks', 'metadata'], 'document.json');
  if (input.schemaVersion !== 1) throw invalid('document.json 的 schemaVersion 必须为 1。', 'WEB_PACKAGE_DOCUMENT_VERSION_UNSUPPORTED');
  const title = boundedString(input.title, 1, 100);
  if (!title) throw invalid('document.json 的标题无效。', 'WEB_PACKAGE_DOCUMENT_TITLE_INVALID');
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > MAX_WEB_PACKAGE_BLOCKS) throw invalid(`document.json 必须包含 1 到 ${MAX_WEB_PACKAGE_BLOCKS.toLocaleString('en-US')} 个内容块。`, 'WEB_PACKAGE_BLOCK_COUNT_INVALID');
  const ids = new Set(); let textLength = 0;
  const blocks = input.blocks.map((block, index) => {
    if (!plainObject(block)) throw invalid('document.json 包含无效内容块。', 'WEB_PACKAGE_BLOCK_INVALID', { index });
    const id = boundedString(block.id, 1, 80);
    if (!id || ids.has(id)) throw invalid('document.json 的内容块 id 缺失或重复。', 'WEB_PACKAGE_BLOCK_ID_INVALID', { index });
    ids.add(id);
    if (block.kind === 'text') {
      assertOnlyKeys(block, ['id', 'kind', 'tag', 'text'], `document.json.blocks[${index}]`);
      if (!allowedTextTags.has(block.tag) || typeof block.text !== 'string') throw invalid('document.json 包含无效文本块。', 'WEB_PACKAGE_TEXT_BLOCK_INVALID', { index });
      textLength += block.text.length;
      if (textLength > 200_000) throw invalid('ZIP 文档文字不能超过 200,000 字符。', 'WEB_PACKAGE_TEXT_TOO_LARGE', undefined, 413);
      return { id, kind: 'text', tag: block.tag, text: block.text.replace(/\r\n/g, '\n') };
    }
    if (block.kind === 'image') {
      assertOnlyKeys(block, ['id', 'kind', 'assetPath', 'previewAssetPath', 'alt', 'width', 'height'], `document.json.blocks[${index}]`);
      if (typeof block.assetPath !== 'string' || !assetPathPattern.test(block.assetPath) || !isSafePackagePath(block.assetPath)) throw invalid('document.json 包含无效图片路径。', 'WEB_PACKAGE_IMAGE_PATH_INVALID', { index });
      const isSvg = /\.svg$/i.test(block.assetPath);
      if (isSvg && (typeof block.previewAssetPath !== 'string' || !previewPathPattern.test(block.previewAssetPath) || !isSafePackagePath(block.previewAssetPath) || block.previewAssetPath === block.assetPath)) {
        throw invalid('SVG 图片必须提供独立的 PNG 安全预览。', 'WEB_PACKAGE_SVG_PREVIEW_REQUIRED', { index });
      }
      if (!isSvg && block.previewAssetPath != null) throw invalid('栅格图片不得声明 SVG 专用预览路径。', 'WEB_PACKAGE_RASTER_PREVIEW_UNEXPECTED', { index });
      return { id, kind: 'image', assetPath: block.assetPath, ...(isSvg ? { previewAssetPath: block.previewAssetPath } : {}), alt: String(block.alt || '').slice(0, 200), width: boundedInteger(block.width, 900), height: boundedInteger(block.height, 600) };
    }
    throw invalid('document.json 包含不支持的内容块。', 'WEB_PACKAGE_BLOCK_UNSUPPORTED', { index });
  });
  const language = input.language == null ? '' : boundedString(input.language, 0, 40);
  if (input.language != null && language == null) throw invalid('document.json 的语言字段无效。', 'WEB_PACKAGE_LANGUAGE_INVALID');
  const sourceUrl = input.sourceUrl == null ? '' : String(input.sourceUrl);
  if (sourceUrl.length > 4096 || (sourceUrl && !isHttpUrl(sourceUrl))) throw invalid('document.json 的来源地址无效。', 'WEB_PACKAGE_SOURCE_URL_INVALID');
  if (input.metadata != null && !plainObject(input.metadata)) throw invalid('document.json 的 metadata 必须是对象。', 'WEB_PACKAGE_METADATA_INVALID');
  return { schemaVersion: 1, title, language, sourceUrl, blocks, metadata: input.metadata ? { ...input.metadata } : {} };
}

export function isSafePackagePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function assertOnlyKeys(value, allowed, location) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw invalid(`${location} 包含不支持的字段。`, 'WEB_PACKAGE_SCHEMA_ADDITIONAL_PROPERTY', { location, fields: extra });
}

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function boundedString(value, minimum, maximum) { if (typeof value !== 'string') return null; const result = value.trim(); return result.length >= minimum && result.length <= maximum ? result : null; }
function boundedInteger(value, fallback) { if (value == null) return fallback; return Number.isInteger(value) && value >= 1 && value <= 4000 ? value : fallback; }
function isHttpUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
function invalid(message, code, details, status = 400) { return new WebPackageValidationError(message, { code, details, status }); }
