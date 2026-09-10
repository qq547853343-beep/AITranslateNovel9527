import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { normalizeDocumentBlocks } from '../domain/document.js';
import { imageMimeFromExtension } from './image-format.js';

const assetPattern = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/i;

export async function createDocxExport({ blocks, title: titleValue, assetDirectory }) {
  const headingMap = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 };
  const children = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      const options = { children: textRuns(block.text), spacing: { after: 140, line: 320 } };
      if (headingMap[block.tag]) options.heading = headingMap[block.tag];
      if (block.tag === 'li') options.bullet = { level: 0 };
      children.push(new Paragraph(options));
    } else {
      const file = requireAsset(assetDirectory, block.assetId);
      const extension = path.extname(file).slice(1).toLowerCase();
      if (extension === 'webp') throw Object.assign(new Error(`Word 导出暂不支持 WebP 图片 ${block.assetId}；请使用 EPUB，或在导入前转换为 PNG/JPEG。`), { code: 'DOCX_IMAGE_TYPE_UNSUPPORTED', status: 415 });
      children.push(new Paragraph({ children: [new ImageRun({ type: extension, data: fs.readFileSync(file), transformation: scaledImageSize(block) })] }));
    }
  }
  const title = safeName(titleValue, 'translation');
  const buffer = await Packer.toBuffer(new Document({ creator: 'AIWordTranslateService9527', title, description: '由 AIWordTranslateService9527 ver0.3 生成', sections: [{ properties: {}, children }] }));
  return { buffer, title, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' };
}

export async function createEpubExport({ blocks, title: titleValue, languageCode, assetDirectory }) {
  const title = safeName(titleValue, 'translation');
  const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(languageCode || '') ? languageCode : 'zh-CN';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifests = []; const added = new Set(); let body = '';
  for (const block of blocks) {
    if (block.kind === 'text') {
      const tag = block.tag === 'li' ? 'p' : block.tag;
      body += `<${tag}>${escapeXml(block.text).replace(/\n/g, '<br/>')}</${tag}>`;
    } else {
      const file = requireAsset(assetDirectory, block.assetId);
      if (!added.has(block.assetId)) {
        const mime = imageMimeFromExtension(path.extname(file).slice(1));
        zip.file(`OEBPS/images/${block.assetId}`, fs.readFileSync(file));
        manifests.push(`<item id="img-${manifests.length + 1}" href="images/${block.assetId}" media-type="${mime}"/>`);
        added.add(block.assetId);
      }
      body += `<figure><img src="images/${block.assetId}" alt="${escapeXml(block.alt)}"/></figure>`;
    }
  }
  const id = `urn:uuid:${randomUUID()}`;
  zip.file('OEBPS/content.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" href="styles.css"/></head><body>${body}</body></html>`);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="content.xhtml">${escapeXml(title)}</a></li></ol></nav></body></html>`);
  zip.file('OEBPS/styles.css', 'body{font-family:serif;line-height:1.75;margin:5%}img{display:block;max-width:100%;height:auto;margin:1em auto}');
  zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${id}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><dc:creator>AIWordTranslateService9527</dc:creator><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/>${manifests.join('')}</manifest><spine><itemref idref="content"/></spine></package>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, title, mime: 'application/epub+zip', extension: 'epub' };
}

export async function createBundleExport(input) {
  const zip = new JSZip();
  const title = safeName(input.title, 'translation');
  const sourceBlocks = normalizeDocumentBlocks(input.sourceBlocks);
  const translatedBlocks = normalizeDocumentBlocks(input.translatedBlocks);
  const source = sourceBlocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n\n');
  const translation = translatedBlocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n\n');
  const meta = input.meta || {}; const selected = input.selected || {};
  if (selected.translation !== false) zip.file('translated.txt', translation);
  if (selected.source) zip.file('source.txt', source);
  if (selected.glossary) zip.file('glossary.tsv', ['原文术语\t规定译法\t分类\t来源规则集', ...(meta.appliedRules || []).map((rule) => [rule.source, rule.target, rule.category, rule.ruleSetName].map(tsv).join('\t'))].join('\n'));
  if (selected.notes) zip.file('translation-notes.md', markdownList('翻译说明', meta.notes));
  if (selected.analysis) zip.file('analysis-summary.md', `${markdownList('翻译决策摘要', meta.decisionSummary)}\n\n${markdownList('不确定项', meta.uncertainties)}`);
  if (selected.rules) zip.file('applied-rules.json', JSON.stringify(meta.appliedRules || [], null, 2));
  if (selected.manifest) zip.file('manifest.json', JSON.stringify({ version: 'ver0.3', title, model: input.model || 'deepseek-chat', targetLanguage: input.targetLanguage, ruleSets: meta.ruleSets || [], sourceCharacters: source.length, translatedCharacters: translation.length, exportedAt: new Date().toISOString() }, null, 2));
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), title, mime: 'application/zip', extension: 'zip' };
}

function requireAsset(directory, assetId) {
  const file = assetPattern.test(String(assetId || '')) ? path.join(directory, assetId) : '';
  if (!file || !fs.existsSync(file)) throw Object.assign(new Error(`图片 ${assetId} 不存在或已过期。`), { status: 400 });
  return file;
}
function escapeXml(value = '') { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]); }
function safeName(value, fallback) { return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || fallback; }
function scaledImageSize(block) { const scale = Math.min(1, 600 / block.width, 760 / block.height); return { width: Math.max(1, Math.round(block.width * scale)), height: Math.max(1, Math.round(block.height * scale)) }; }
function textRuns(text) { return text.split('\n').map((line, index) => new TextRun({ text: line, break: index > 0 ? 1 : undefined })); }
function markdownList(title, values) { const items = Array.isArray(values) ? values : []; return `# ${title}\n\n${items.length ? items.map((item) => `- ${String(item)}`).join('\n') : '- 无'}`; }
function tsv(value) { return String(value || '').replace(/[\t\r\n]+/g, ' '); }
