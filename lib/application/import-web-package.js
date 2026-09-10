import { createDocument } from '../domain/document.js';
import { validateWebPackageDocument, validateWebPackageManifest, WebPackageValidationError } from '../domain/web-package.js';
import { detectRasterImage } from '../infrastructure/image-format.js';
import { validateSafeSvg } from '../infrastructure/svg-validator.js';

export class ImportWebPackage {
  constructor({ reader, assetStore }) { this.reader = reader; this.assetStore = assetStore; }

  async execute(buffer) {
    const archive = await this.reader.read(buffer);
    const manifest = validateWebPackageManifest(archive.manifest);
    const source = validateWebPackageDocument(archive.document);
    const imageBlocks = source.blocks.filter((block) => block.kind === 'image');
    const referencedPaths = [...new Set(imageBlocks.flatMap((block) => [block.assetPath, ...(block.previewAssetPath ? [block.previewAssetPath] : [])]))];
    for (const assetPath of referencedPaths) if (!archive.assets.has(assetPath)) throw new WebPackageValidationError(`ZIP 缺少 document.json 引用的资源：${assetPath}`, { code: 'WEB_PACKAGE_ASSET_MISSING', details: { assetPath } });
    const session = this.assetStore.begin();
    try {
      const imported = new Map();
      for (const block of imageBlocks) {
        const assetPath = block.assetPath;
        if (imported.has(assetPath)) continue;
        const bufferValue = archive.assets.get(assetPath);
        if (/\.svg$/i.test(assetPath)) {
          validateSafeSvg(bufferValue);
          const previewBuffer = archive.assets.get(block.previewAssetPath);
          const previewFormat = detectRasterImage(previewBuffer);
          if (previewFormat?.extension !== 'png') throw new WebPackageValidationError(`SVG 资源 ${assetPath} 的安全预览不是有效 PNG。`, { code: 'WEB_PACKAGE_SVG_PREVIEW_INVALID', status: 415, details: { assetPath, previewAssetPath: block.previewAssetPath } });
          const preview = session.stage(previewBuffer, previewFormat);
          const original = session.stageOriginalSvg(bufferValue);
          imported.set(assetPath, { ...preview, ...original, originalAssetPath: assetPath, previewAssetPath: block.previewAssetPath });
          continue;
        }
        const format = detectRasterImage(bufferValue);
        if (!format) throw new WebPackageValidationError(`资源 ${assetPath} 不是有效的 PNG、JPEG、GIF 或 WebP。`, { code: 'WEB_PACKAGE_ASSET_TYPE_INVALID', status: 415, details: { assetPath } });
        const sourceExtension = assetPath.split('.').at(-1).toLowerCase();
        const expected = sourceExtension === 'jpeg' ? 'jpg' : sourceExtension;
        if (format.extension !== expected) throw new WebPackageValidationError(`资源 ${assetPath} 的扩展名与实际格式不一致。`, { code: 'WEB_PACKAGE_ASSET_TYPE_MISMATCH', status: 415, details: { assetPath } });
        imported.set(assetPath, session.stage(bufferValue, format));
      }
      const blocks = source.blocks.map((block) => {
        if (block.kind === 'text') return block;
        const asset = imported.get(block.assetPath);
        return { id: block.id, kind: 'image', assetId: asset.assetId, ...(asset.originalAssetId ? { originalAssetId: asset.originalAssetId, originalFormat: 'svg' } : {}), alt: block.alt, width: block.width, height: block.height };
      });
      const document = createDocument({ title: source.title, sourceType: 'web-package', blocks, metadata: { ...source.metadata, language: source.language, sourceUrl: source.sourceUrl, packageCreatedAt: manifest.createdAt, packageGenerator: manifest.generator } });
      session.commit();
      return { manifest, document, assets: [...imported.entries()].map(([assetPath, asset]) => ({ assetPath, ...asset })), preview: { source: archive.previewSource, contentHtmlUsed: false } };
    } catch (error) {
      session.rollback();
      throw error;
    }
  }
}
