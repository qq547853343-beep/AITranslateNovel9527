const textTags = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'li']);
const assetPattern = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/i;
const originalAssetPattern = /^[0-9a-f-]{36}\.svg$/i;
export const MAX_DOCUMENT_BLOCKS = 5_000;

export class DocumentValidationError extends Error {
  constructor(message, { code = 'DOCUMENT_INVALID', status = 400, details } = {}) {
    super(message);
    this.name = 'DocumentValidationError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function normalizeDocumentBlocks(input, { maximumBlocks = MAX_DOCUMENT_BLOCKS, maximumTextLength = 200_000 } = {}) {
  if (!Array.isArray(input) || !input.length || input.length > maximumBlocks) {
    throw new DocumentValidationError(`文档必须包含 1 到 ${maximumBlocks} 个内容块。`, { code: 'DOCUMENT_BLOCK_COUNT_INVALID' });
  }
  let textLength = 0;
  const blocks = input.map((block, index) => {
    if (block?.kind === 'text') {
      const text = typeof block.text === 'string' ? block.text.replace(/\r\n/g, '\n') : '';
      textLength += text.length;
      return { id: `text-${index}`, kind: 'text', tag: textTags.has(block.tag) ? block.tag : 'p', text };
    }
    if (block?.kind === 'image') {
      const assetId = String(block.assetId || '');
      if (!assetPattern.test(assetId)) {
        throw new DocumentValidationError('文档包含无效的图片引用。', { code: 'DOCUMENT_IMAGE_REFERENCE_INVALID', details: { index } });
      }
      const originalAssetId = block.originalAssetId == null ? '' : String(block.originalAssetId);
      if (originalAssetId && !originalAssetPattern.test(originalAssetId)) {
        throw new DocumentValidationError('文档包含无效的 SVG 原始资源引用。', { code: 'DOCUMENT_ORIGINAL_IMAGE_REFERENCE_INVALID', details: { index } });
      }
      return {
        id: `image-${index}`,
        kind: 'image',
        assetId,
        ...(originalAssetId ? { originalAssetId, originalFormat: 'svg' } : {}),
        alt: String(block.alt || '').slice(0, 200),
        width: Math.max(1, Math.min(4000, Number(block.width) || 900)),
        height: Math.max(1, Math.min(4000, Number(block.height) || 600))
      };
    }
    throw new DocumentValidationError('文档包含不支持的内容块。', { code: 'DOCUMENT_BLOCK_UNSUPPORTED', details: { index } });
  });
  if (textLength > maximumTextLength) {
    throw new DocumentValidationError(`文档文字不能超过 ${maximumTextLength.toLocaleString('en-US')} 字符。`, { code: 'DOCUMENT_TEXT_TOO_LARGE', status: 413 });
  }
  return blocks;
}

export function createDocument({ id = null, title = 'translation', sourceType = 'manual', blocks, metadata = {} } = {}) {
  return {
    schemaVersion: 1,
    id,
    title: String(title || 'translation').trim().slice(0, 100) || 'translation',
    sourceType: ['manual', 'text-file', 'clipboard-html', 'web-package'].includes(sourceType) ? sourceType : 'manual',
    blocks: normalizeDocumentBlocks(blocks),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {}
  };
}

export function isLocalAssetId(value) {
  return assetPattern.test(String(value || ''));
}
