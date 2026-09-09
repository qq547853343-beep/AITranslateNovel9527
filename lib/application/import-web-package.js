import { createDocument } from '../domain/document.js';
import { validateWebPackageDocument, validateWebPackageManifest, WebPackageValidationError } from '../domain/web-package.js';
import { detectRasterImage } from '../infrastructure/image-format.js';

export class ImportWebPackage {
  constructor({ reader, assetStore }) { this.reader = reader; this.assetStore = assetStore; }

  async execute(buffer) {
    const archive = await this.reader.read(buffer);
    const manifest = validateWebPackageManifest(archive.manifest);
    const source = validateWebPackageDocument(archive.document);
    const referencedPaths = [...new Set(source.blocks.filter((block) => block.kind === 'image').map((block) => block.assetPath))];
    for (const assetPath of referencedPaths) if (!archive.assets.has(assetPath)) throw new WebPackageValidationError(`ZIP 缺少 document.json 引用的资源：${assetPath}`, { code: 'WEB_PACKAGE_ASSET_MISSING', details: { assetPath } });
    const session = this.assetStore.begin();
    try {
      const imported = new Map();
      for (const assetPath of referencedPaths) {
        const bufferValue = archive.assets.get(assetPath);
        const format = detectRasterImage(bufferValue);
        if (!format) throw new WebPackageValidationError(`资源 ${assetPath} 不是有效的 PNG、JPEG、GIF 或 WebP。`, { code: 'WEB_PACKAGE_ASSET_TYPE_INVALID', status: 415, details: { assetPath } });
        const sourceExtension = assetPath.split('.').at(-1).toLowerCase();
        const expected = sourceExtension === 'jpeg' ? 'jpg' : sourceExtension;
        if (format.extension !== expected) throw new WebPackageValidationError(`资源 ${assetPath} 的扩展名与实际格式不一致。`, { code: 'WEB_PACKAGE_ASSET_TYPE_MISMATCH', status: 415, details: { assetPath } });
        imported.set(assetPath, session.stage(bufferValue, format));
      }
      const blocks = source.blocks.map((block) => block.kind === 'text' ? block : { ...block, assetId: imported.get(block.assetPath).assetId, assetPath: undefined });
      const document = createDocument({ title: source.title, sourceType: 'web-package', blocks, metadata: { ...source.metadata, language: source.language, sourceUrl: source.sourceUrl, packageCreatedAt: manifest.createdAt, packageGenerator: manifest.generator } });
      session.commit();
      return { manifest, document, assets: [...imported.entries()].map(([assetPath, asset]) => ({ assetPath, ...asset })), preview: { source: archive.previewSource, contentHtmlUsed: false } };
    } catch (error) {
      session.rollback();
      throw error;
    }
  }
}
