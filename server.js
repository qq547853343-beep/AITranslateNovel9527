import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  next();
});
app.use('/vendor/vue', express.static(path.join(__dirname, 'node_modules', 'vue', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

const keyAttempts = new Map();
const secretDirectory = path.join(__dirname, 'data');
const masterKeyFile = path.join(secretDirectory, '.master-key');
const secretFile = path.join(secretDirectory, 'secrets.json');
const assetDirectory = path.join(secretDirectory, 'assets');
fs.mkdirSync(assetDirectory, { recursive: true });
for (const name of fs.readdirSync(assetDirectory)) {
  try { const file = path.join(assetDirectory, name); if (Date.now() - fs.statSync(file).mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.unlinkSync(file); } catch { }
}

function restrictAccess(target) {
  const account = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!account) throw new Error('无法确认当前 Windows 用户。');
  const result = spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `${account}:F`, 'SYSTEM:F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw new Error('无法限制密钥文件访问权限。');
}

function loadMasterKey() {
  fs.mkdirSync(secretDirectory, { recursive: true });
  if (!fs.existsSync(masterKeyFile)) {
    fs.writeFileSync(masterKeyFile, randomBytes(32), { mode: 0o600 });
    restrictAccess(masterKeyFile);
  }
  const key = fs.readFileSync(masterKeyFile);
  if (key.length !== 32) throw new Error('本地主密钥格式无效。');
  return key;
}

function persistApiKey(apiKey) {
  const key = loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('deepseek-local-translator:v1'));
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const payload = { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  const temporaryFile = `${secretFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, secretFile);
  restrictAccess(secretFile);
}

function readPersistedApiKey() {
  if (!fs.existsSync(secretFile) || !fs.existsSync(masterKeyFile)) return '';
  const payload = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(masterKeyFile), Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from('deepseek-local-translator:v1'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

let runtimeApiKey = '';
try { runtimeApiKey = readPersistedApiKey(); } catch (error) { console.error(`[api-key] local key load failed: ${error.message}`); }

function getApiKey() {
  return runtimeApiKey || process.env.DEEPSEEK_API_KEY || '';
}

const textTags = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'li']);
const assetPattern = /^[0-9a-f-]{36}\.(png|jpg)$/i;

function escapeXml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function normalizeDocumentBlocks(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) throw Object.assign(new Error('文档必须包含 1 到 500 个内容块。'), { status: 400 });
  let textLength = 0;
  const blocks = input.map((block, index) => {
    if (block?.kind === 'text') {
      const text = typeof block.text === 'string' ? block.text.replace(/\r\n/g, '\n') : '';
      textLength += text.length;
      return { id: `text-${index}`, kind: 'text', tag: textTags.has(block.tag) ? block.tag : 'p', text };
    }
    if (block?.kind === 'image') {
      const assetId = typeof block.assetId === 'string' ? block.assetId : '';
      if (!assetPattern.test(assetId)) throw Object.assign(new Error('文档包含无效的图片引用。'), { status: 400 });
      return { id: `image-${index}`, kind: 'image', assetId, alt: String(block.alt || '').slice(0, 200), width: Math.max(1, Math.min(4000, Number(block.width) || 900)), height: Math.max(1, Math.min(4000, Number(block.height) || 600)) };
    }
    throw Object.assign(new Error('文档包含不支持的内容块。'), { status: 400 });
  });
  if (textLength > 200000) throw Object.assign(new Error('文档文字不能超过 200,000 字符。'), { status: 413 });
  return blocks;
}

function resolveAsset(assetId) {
  if (!assetPattern.test(assetId)) return null;
  const file = path.join(assetDirectory, assetId);
  return fs.existsSync(file) ? file : null;
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: 'png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  return null;
}

function splitText(text, maximum = 6000) {
  const parts = [];
  let rest = text;
  while (rest.length > maximum) {
    const window = rest.slice(0, maximum);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('. '));
    if (cut < maximum * 0.45) cut = maximum;
    else cut += 1;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest || parts.length === 0) parts.push(rest);
  return parts;
}

async function translateDocumentBlocks(blocks, targetLanguage, apiKey) {
  const units = [];
  blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'text' || !block.text.trim()) return;
    splitText(block.text).forEach((text, partIndex) => units.push({ id: `b${blockIndex}p${partIndex}`, blockIndex, partIndex, text }));
  });
  if (units.length === 0) throw Object.assign(new Error('文档中没有可翻译的文字。'), { status: 400 });
  const translated = new Map();
  for (let cursor = 0; cursor < units.length;) {
    const batch = []; let characters = 0;
    while (cursor < units.length && batch.length < 40 && characters + units[cursor].text.length <= 16000) { batch.push(units[cursor]); characters += units[cursor].text.length; cursor += 1; }
    if (batch.length === 0) { batch.push(units[cursor]); cursor += 1; }
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: `你是专业翻译。把输入 JSON 中每个 segments 项的 text 翻译成${targetLanguage}。必须保留 id，保持数组数量和顺序，只输出 JSON：{"translations":[{"id":"原id","text":"译文"}]}。保留段内换行，不要解释；图片不会发送给你。` },
        { role: 'user', content: JSON.stringify({ segments: batch.map(({ id, text }) => ({ id, text })) }) }
      ] })
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'DeepSeek API 请求失败。'), { status: response.status });
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('DeepSeek 返回的结构化翻译格式无效，请重试。'); }
    for (const item of parsed.translations || []) if (typeof item.id === 'string' && typeof item.text === 'string') translated.set(item.id, item.text);
    for (const item of batch) if (!translated.has(item.id)) throw new Error(`DeepSeek 未返回段落 ${item.id} 的译文。`);
  }
  const grouped = new Map();
  for (const unit of units) {
    if (!grouped.has(unit.blockIndex)) grouped.set(unit.blockIndex, []);
    grouped.get(unit.blockIndex).push({ partIndex: unit.partIndex, text: translated.get(unit.id) });
  }
  return blocks.map((block, index) => block.kind === 'text' && grouped.has(index)
    ? { ...block, text: grouped.get(index).sort((a, b) => a.partIndex - b.partIndex).map((item) => item.text).join('') }
    : block);
}

function scaledImageSize(block) {
  const scale = Math.min(1, 600 / block.width, 760 / block.height);
  return { width: Math.max(1, Math.round(block.width * scale)), height: Math.max(1, Math.round(block.height * scale)) };
}

function textRuns(text) {
  return text.split('\n').map((line, index) => new TextRun({ text: line, break: index > 0 ? 1 : undefined }));
}

function safeDownloadName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100);
  return cleaned || fallback;
}

function requireLocalMutation(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return res.status(403).json({ error: '仅允许本机页面修改安全配置。' });
    } catch { return res.status(403).json({ error: '请求来源无效。' }); }
  }
  next();
}

function limitKeyUpdates(req, res, next) {
  const now = Date.now();
  const recent = (keyAttempts.get(req.ip) || []).filter((time) => now - time < 60000);
  if (recent.length >= 5) return res.status(429).json({ error: '操作过于频繁，请一分钟后再试。' });
  recent.push(now); keyAttempts.set(req.ip, recent); next();
}

app.get('/api/settings/api-key/status', (_req, res) => {
  res.json({ configured: Boolean(getApiKey()), storage: fs.existsSync(secretFile) ? 'local-encrypted' : process.env.DEEPSEEK_API_KEY ? 'environment' : 'none' });
});

app.post('/api/settings/api-key', requireLocalMutation, limitKeyUpdates, (req, res) => {
  try {
    const apiKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!/^sk-[A-Za-z0-9_-]{10,252}$/.test(apiKey)) return res.status(400).json({ error: 'API Key 格式无效。' });
    persistApiKey(apiKey);
    runtimeApiKey = apiKey;
    res.json({ configured: true, message: 'API Key 已加密保存在本地，服务重启后仍然有效。' });
  } catch (error) {
    console.error(`[api-key] update failed: ${error.message}`);
    res.status(500).json({ error: 'API Key 设置失败。' });
  }
});

app.delete('/api/settings/api-key', requireLocalMutation, limitKeyUpdates, (_req, res) => {
  try {
    runtimeApiKey = '';
    if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
    if (fs.existsSync(masterKeyFile)) fs.unlinkSync(masterKeyFile);
    res.json({ configured: Boolean(process.env.DEEPSEEK_API_KEY), message: process.env.DEEPSEEK_API_KEY ? '已删除页面保存的密钥，当前仍使用环境变量。' : 'API Key 已删除。' });
  } catch (error) {
    console.error(`[api-key] clear failed: ${error.message}`);
    res.status(500).json({ error: 'API Key 清除失败。' });
  }
});

function checkPortOnHost(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen({ port, host });
  });
}

async function isPortOccupied(port) {
  return (await checkPortOnHost(port, '127.0.0.1')) || (await checkPortOnHost(port, '::1'));
}

app.get('/api/ports/check', async (req, res) => {
  const start = Number.parseInt(req.query.start, 10);
  const end = Number.parseInt(req.query.end ?? req.query.start, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end || end - start > 1000) {
    return res.status(400).json({ error: '端口范围必须在 1-65535 之间，且一次最多检测 1001 个端口。' });
  }
  const ports = [];
  for (let port = start; port <= end; port += 1) ports.push({ port, occupied: await isPortOccupied(port) });
  res.json({ start, end, ports, checkedAt: new Date().toISOString() });
});

app.post('/api/assets', requireLocalMutation, imageUpload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择图片。' });
    const detected = detectImage(req.file.buffer);
    if (!detected) return res.status(415).json({ error: '仅支持 PNG 和 JPEG；WebP 会在浏览器中自动转换为 PNG。' });
    const assetId = `${randomUUID()}.${detected.extension}`;
    fs.writeFileSync(path.join(assetDirectory, assetId), req.file.buffer, { flag: 'wx', mode: 0o600 });
    res.status(201).json({ assetId, url: `/api/assets/${assetId}`, mime: detected.mime });
  } catch (error) { res.status(500).json({ error: error.message || '图片保存失败。' }); }
});

app.get('/api/assets/:assetId', (req, res) => {
  const file = resolveAsset(req.params.assetId);
  if (!file) return res.status(404).json({ error: '图片不存在或已过期。' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
  res.sendFile(file);
});

app.delete('/api/assets/:assetId', requireLocalMutation, (req, res) => {
  const file = resolveAsset(req.params.assetId);
  if (file) fs.unlinkSync(file);
  res.json({ deleted: Boolean(file) });
});

app.post('/api/translate-document', async (req, res) => {
  try {
    const blocks = normalizeDocumentBlocks(req.body.blocks);
    const targetLanguage = String(req.body.targetLanguage || '中文').slice(0, 40);
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ error: '尚未配置 DeepSeek API Key，请先在页面的安全设置中填写。' });
    const translatedBlocks = await translateDocumentBlocks(blocks, targetLanguage, apiKey);
    res.json({ blocks: translatedBlocks, translatedTextBlocks: translatedBlocks.filter((block) => block.kind === 'text').length });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || '文档翻译失败。' }); }
});

app.post('/api/export/docx', async (req, res) => {
  try {
    const blocks = normalizeDocumentBlocks(req.body.blocks);
    const headingMap = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 };
    const children = [];
    for (const block of blocks) {
      if (block.kind === 'text') {
        const options = { children: textRuns(block.text), spacing: { after: 140, line: 320 } };
        if (headingMap[block.tag]) options.heading = headingMap[block.tag];
        if (block.tag === 'li') options.bullet = { level: 0 };
        children.push(new Paragraph(options));
      } else {
        const file = resolveAsset(block.assetId);
        if (!file) throw Object.assign(new Error(`图片 ${block.assetId} 不存在或已过期。`), { status: 400 });
        const extension = path.extname(file).toLowerCase();
        children.push(new Paragraph({ children: [new ImageRun({ type: extension === '.png' ? 'png' : 'jpg', data: fs.readFileSync(file), transformation: scaledImageSize(block) })], spacing: { before: 100, after: 180 } }));
      }
    }
    const document = new Document({ creator: 'AIWordTranslateService9527', title: String(req.body.title || '翻译结果'), description: '由 AIWordTranslateService9527 ver0.0.1 生成', sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(document);
    const filename = `${safeDownloadName(req.body.title, 'translation')}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Word 文件生成失败。' }); }
});

app.post('/api/export/epub', async (req, res) => {
  try {
    const blocks = normalizeDocumentBlocks(req.body.blocks);
    const title = safeDownloadName(req.body.title, 'translation');
    const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(req.body.languageCode || '') ? req.body.languageCode : 'zh-CN';
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const imageManifest = []; const addedImages = new Set(); let body = '';
    for (const block of blocks) {
      if (block.kind === 'text') {
        const tag = block.tag === 'li' ? 'p' : block.tag;
        body += `<${tag}>${escapeXml(block.text).replace(/\n/g, '<br/>')}</${tag}>`;
      } else {
        const file = resolveAsset(block.assetId);
        if (!file) throw Object.assign(new Error(`图片 ${block.assetId} 不存在或已过期。`), { status: 400 });
        if (!addedImages.has(block.assetId)) {
          const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          zip.file(`OEBPS/images/${block.assetId}`, fs.readFileSync(file));
          imageManifest.push(`<item id="img-${imageManifest.length + 1}" href="images/${block.assetId}" media-type="${mime}"/>`); addedImages.add(block.assetId);
        }
        body += `<figure><img src="images/${block.assetId}" alt="${escapeXml(block.alt)}"/></figure>`;
      }
    }
    const content = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body>${body}</body></html>`;
    const navigation = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="content.xhtml">${escapeXml(title)}</a></li></ol></nav></body></html>`;
    const identifier = `urn:uuid:${randomUUID()}`; const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const packageDocument = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${language}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${identifier}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><dc:creator>AIWordTranslateService9527</dc:creator><meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/>${imageManifest.join('')}</manifest><spine><itemref idref="content"/></spine></package>`;
    zip.file('OEBPS/content.xhtml', content); zip.file('OEBPS/nav.xhtml', navigation); zip.file('OEBPS/package.opf', packageDocument);
    zip.file('OEBPS/styles.css', 'body{font-family:serif;line-height:1.75;margin:5%;}img{display:block;max-width:100%;height:auto;margin:1em auto;}figure{margin:1em 0;}blockquote{margin-left:1.5em;color:#555;}');
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.epub`)}`);
    res.send(buffer);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'EPUB 文件生成失败。' }); }
});

app.post('/api/translate', upload.single('file'), async (req, res) => {
  try {
    const source = req.body.text || (req.file ? req.file.buffer.toString('utf8') : '');
    const targetLanguage = req.body.targetLanguage || '中文';
    if (!source.trim()) return res.status(400).json({ error: '请输入文字或选择文件。' });
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ error: '尚未配置 DeepSeek API Key，请先在页面的安全设置中填写。' });
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.2, messages: [
        { role: 'system', content: `你是一名专业翻译。将用户提供的内容翻译成${targetLanguage}。保留原文的段落、标题、列表和换行格式，只输出翻译结果，不要附加解释。` },
        { role: 'user', content: source }
      ] })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'DeepSeek API 请求失败。' });
    res.json({ translation: data.choices?.[0]?.message?.content || '', filename: req.file?.originalname || 'translation.txt' });
  } catch (e) { res.status(500).json({ error: e.message || '服务器错误。' }); }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` });
});

app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(error);
  console.error(`[api] ${req.method} ${req.path} failed: ${error.message}`);
  res.status(error.status || 500).json({ error: error.status === 413 ? '请求内容过大。' : '服务器处理请求时发生错误。' });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = Number(process.env.PORT || 6501);
app.listen(port, '127.0.0.1', () => console.log(`AIWordTranslateService9527 ver0.0.1 running at http://localhost:${port}`));
