import express from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDatabase } from './database.js';
import { RuleSetRepository, SecretRecordRepository, SettingsRepository, TranslationJobRepository } from './repositories.js';
import { AesGcmSecretStore, migrateLegacySecret, readLegacySecret } from './secret-store.js';
import { DeepSeekClient } from './deepseek-client.js';
import { TranslationService } from './translation-service.js';
import { estimateTextStats } from './text-processing.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const textTags = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'li']);
const assetPattern = /^[0-9a-f-]{36}\.(png|jpg)$/i;
const localScope = 'local-user';
const apiKeyName = 'deepseek-api-key';

export async function createApplication({ baseDirectory, dataDirectory: suppliedDataDirectory, databaseFile, fetchImpl = fetch, secretStore: suppliedSecretStore } = {}) {
  const app = express(); app.disable('x-powered-by');
  const dataDirectory = suppliedDataDirectory || path.join(baseDirectory, 'data');
  const assetDirectory = path.join(dataDirectory, 'assets');
  fs.mkdirSync(assetDirectory, { recursive: true });
  if (!suppliedSecretStore) restrictDataDirectory(dataDirectory);
  cleanupAssets(assetDirectory);
  const database = openDatabase(databaseFile || path.join(dataDirectory, 'app.db'));
  const repositories = {
    settings: new SettingsRepository(database),
    secrets: new SecretRecordRepository(database),
    ruleSets: new RuleSetRepository(database),
    jobs: new TranslationJobRepository(database)
  };
  repositories.jobs.purgeExpired();
  for (const job of repositories.jobs.listRecoverable()) {
    if (job.status === 'running') repositories.jobs.update(job.id, { status: 'pending', segments: job.segments.map((segment) => segment.status === 'translating' ? { ...segment, status: 'pending' } : segment) });
  }
  const masterKeyFile = path.join(dataDirectory, '.master-key');
  const secretStore = suppliedSecretStore || new AesGcmSecretStore(repositories.secrets, masterKeyFile);
  if (!suppliedSecretStore) {
    try { await migrateLegacySecret({ secretStore, scopeId: localScope, secretName: apiKeyName, secretFile: path.join(dataDirectory, 'secrets.json'), masterKeyFile: path.join(dataDirectory, '.master-key') }); }
    catch (error) { console.error(`[api-key] legacy migration failed: ${error.message}`); }
  }
  const legacySecretFile = path.join(dataDirectory, 'secrets.json');
  const readStoredApiKey = async () => { try { return await secretStore.read(localScope, apiKeyName); } catch (error) { console.error(`[api-key] stored secret is unreadable: ${error.message}`); return ''; } };
  const getApiKey = async () => (await readStoredApiKey()) || readLegacySecret(legacySecretFile, masterKeyFile) || process.env.DEEPSEEK_API_KEY || '';
  const translationService = new TranslationService({ jobRepository: repositories.jobs, ruleSetRepository: repositories.ruleSets, clientFactory: async () => {
    const apiKey = await getApiKey(); if (!apiKey) throw Object.assign(new Error('尚未配置 DeepSeek API Key，请先在连接设置中填写。'), { status: 500 });
    return new DeepSeekClient({ apiKey, fetchImpl });
  } });

  app.use(express.json({ limit: '12mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"); next();
  });
  app.use('/vendor/vue', express.static(path.join(baseDirectory, 'node_modules', 'vue', 'dist')));
  app.use(express.static(path.join(baseDirectory, 'public')));

  const keyAttempts = new Map();
  app.get('/api/settings/api-key/status', route(async (_req, res) => res.json({ configured: Boolean(await getApiKey()), storage: repositories.secrets.get(localScope, apiKeyName)?.provider || (fs.existsSync(legacySecretFile) ? 'legacy-aes-256-gcm' : process.env.DEEPSEEK_API_KEY ? 'environment' : 'none') })));
  app.post('/api/settings/api-key', requireLocalMutation, limitKeyUpdates(keyAttempts), route(async (req, res) => {
    const apiKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!/^sk-[A-Za-z0-9_-]{10,252}$/.test(apiKey)) throw Object.assign(new Error('API Key 格式无效。'), { status: 400 });
    await secretStore.save(localScope, apiKeyName, apiKey);
    res.json({ configured: true, message: 'API Key 已使用本地 AES-256-GCM 加密并保存到 SQLite。请勿同时泄露数据库和主密钥文件。' });
  }));
  app.delete('/api/settings/api-key', requireLocalMutation, limitKeyUpdates(keyAttempts), route(async (_req, res) => {
    await secretStore.delete(localScope, apiKeyName);
    if (fs.existsSync(legacySecretFile)) fs.unlinkSync(legacySecretFile);
    res.json({ configured: Boolean(process.env.DEEPSEEK_API_KEY), message: process.env.DEEPSEEK_API_KEY ? '已删除本地密钥，当前仍使用环境变量。' : 'API Key 已删除。' });
  }));
  app.get('/api/settings/ui', (_req, res) => res.json(repositories.settings.get('ui', { selectedRuleSetIds: [], validationMode: 'warning', notifications: false })));
  app.put('/api/settings/ui', requireLocalMutation, (req, res) => res.json(repositories.settings.set('ui', sanitizeUiSettings(req.body))));

  app.get('/api/rule-sets', (req, res) => res.json({ ruleSets: repositories.ruleSets.list({ includeDeleted: req.query.includeDeleted === 'true' }) }));
  app.post('/api/rule-sets', requireLocalMutation, route(async (req, res) => res.status(201).json(repositories.ruleSets.create(req.body))));
  app.get('/api/rule-sets/:id', route(async (req, res) => { const item = repositories.ruleSets.getById(req.params.id, { includeDeleted: req.query.includeDeleted === 'true' }); if (!item) throw Object.assign(new Error('规则集不存在。'), { status: 404 }); res.json(item); }));
  app.patch('/api/rule-sets/:id', requireLocalMutation, route(async (req, res) => res.json(repositories.ruleSets.update(req.params.id, req.body, req.body.expectedVersion))));
  app.post('/api/rule-sets/:id/copy', requireLocalMutation, route(async (req, res) => res.status(201).json(repositories.ruleSets.copy(req.params.id, req.body.name))));
  app.get('/api/rule-sets/:id/export', route(async (req, res) => res.json(repositories.ruleSets.export(req.params.id))));
  app.post('/api/rule-sets/import', requireLocalMutation, route(async (req, res) => res.status(201).json(repositories.ruleSets.import(req.body.ruleSet || req.body))));
  app.get('/api/rule-sets/:id/versions', route(async (req, res) => res.json({ versions: repositories.ruleSets.listVersions(req.params.id) })));
  app.post('/api/rule-sets/:id/versions/:version/restore', requireLocalMutation, route(async (req, res) => res.json(repositories.ruleSets.restoreVersion(req.params.id, req.params.version))));
  app.delete('/api/rule-sets/:id', requireLocalMutation, route(async (req, res) => res.json(repositories.ruleSets.softDelete(req.params.id))));
  app.post('/api/rule-sets/:id/restore', requireLocalMutation, route(async (req, res) => res.json(repositories.ruleSets.restore(req.params.id))));
  app.post('/api/rule-sets/:id/rules', requireLocalMutation, route(async (req, res) => res.status(201).json(repositories.ruleSets.applyOperations(req.params.id, [{ ...req.body, action: 'add' }]).applied[0])));
  app.patch('/api/rule-sets/:id/rules/:ruleId', requireLocalMutation, route(async (req, res) => res.json(repositories.ruleSets.applyOperations(req.params.id, [{ ...req.body, action: 'update', ruleId: req.params.ruleId }]).applied[0])));
  app.delete('/api/rule-sets/:id/rules/:ruleId', requireLocalMutation, route(async (req, res) => { repositories.ruleSets.applyOperations(req.params.id, [{ action: 'delete', ruleId: req.params.ruleId }]); res.json({ deleted: true }); }));
  app.post('/api/rules/parse', requireLocalMutation, route(async (req, res) => {
    const instruction = String(req.body.instruction || '').trim().slice(0, 10000); if (!instruction) throw Object.assign(new Error('请输入规则描述。'), { status: 400 });
    const ruleSet = repositories.ruleSets.getById(req.body.ruleSetId); if (!ruleSet) throw Object.assign(new Error('请先选择规则集。'), { status: 400 });
    const apiKey = await getApiKey(); if (!apiKey) throw Object.assign(new Error('尚未配置 DeepSeek API Key。'), { status: 500 });
    const relatedRules = ruleSet.rules.filter((rule) => [rule.source, ...(rule.aliases || [])].some((term) => term && instruction.includes(term))).slice(0, 50);
    res.json(await new DeepSeekClient({ apiKey, fetchImpl }).parseRuleInstruction({ instruction, ruleSet, relatedRules }));
  }));
  app.post('/api/rules/apply', requireLocalMutation, route(async (req, res) => {
    res.json(repositories.ruleSets.applyOperations(req.body.ruleSetId, req.body.operations));
  }));

  app.post('/api/translation-jobs', requireLocalMutation, route(async (req, res) => {
    const blocks = normalizeDocumentBlocks(req.body.blocks); const job = translationService.prepare({ title: safeDownloadName(req.body.title, 'translation'), blocks, targetLanguage: String(req.body.targetLanguage || '中文').slice(0, 40), ruleSetIds: req.body.ruleSetIds, temporaryRules: req.body.temporaryRules, validationMode: ['strict','warning','off'].includes(req.body.validationMode) ? req.body.validationMode : 'warning', includeNotes: Boolean(req.body.outputOptions?.notes || req.body.outputOptions?.decisionSummary) });
    void translationService.run(job.id); res.status(202).json(translationService.publicJob(job));
  }));
  app.get('/api/translation-jobs/recoverable', (_req, res) => res.json({ jobs: repositories.jobs.listRecoverable().map((job) => translationService.publicJob(job)) }));
  app.get('/api/translation-jobs/:id', route(async (req, res) => { const job = repositories.jobs.getById(req.params.id); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 }); res.json(translationService.publicJob(job)); }));
  app.post('/api/translation-jobs/:id/resume', requireLocalMutation, route(async (req, res) => { const job = repositories.jobs.getById(req.params.id); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 }); if (job.status === 'completed') return res.json(translationService.publicJob(job)); const updated = translationService.retry(job.id); res.json(translationService.publicJob(updated)); }));
  app.post('/api/translation-jobs/:id/cancel', requireLocalMutation, route(async (req, res) => { const job = translationService.cancel(req.params.id); if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 }); res.json(translationService.publicJob(job)); }));
  app.post('/api/translation-jobs/:id/retry', requireLocalMutation, route(async (req, res) => res.json(translationService.publicJob(translationService.retry(req.params.id, { all: Boolean(req.body.all) })))));
  app.delete('/api/translation-jobs/:id', requireLocalMutation, (req, res) => { translationService.cancel(req.params.id); res.json({ deleted: repositories.jobs.delete(req.params.id) }); });
  app.post('/api/text/estimate', route(async (req, res) => res.json(estimateTextStats(normalizeDocumentBlocks(req.body.blocks)))));

  app.post('/api/translate-document', route(async (req, res) => {
    const blocks = normalizeDocumentBlocks(req.body.blocks);
    const job = translationService.prepare({ title: req.body.title, blocks, targetLanguage: String(req.body.targetLanguage || '中文').slice(0, 40), ruleSetIds: req.body.ruleSetIds, temporaryRules: req.body.temporaryRules, validationMode: req.body.validationMode, includeNotes: Boolean(req.body.outputOptions?.notes) });
    await translationService.run(job.id); const completed = repositories.jobs.getById(job.id);
    if (completed.status !== 'completed') throw Object.assign(new Error(completed.segments.find((item) => item.error)?.error || '文档翻译失败。'), { status: 502 });
    res.json({ blocks: completed.resultBlocks, translatedTextBlocks: completed.resultBlocks.filter((block) => block.kind === 'text').length, meta: { ...completed.meta, resolvedRules: undefined, jobId: completed.id } });
  }));

  app.post('/api/assets', requireLocalMutation, imageUpload.single('image'), route(async (req, res) => {
    if (!req.file) throw Object.assign(new Error('请选择图片。'), { status: 400 }); const detected = detectImage(req.file.buffer);
    if (!detected) throw Object.assign(new Error('仅支持 PNG 和 JPEG；WebP 会在浏览器中自动转换为 PNG。'), { status: 415 });
    const assetId = `${randomUUID()}.${detected.extension}`; fs.writeFileSync(path.join(assetDirectory, assetId), req.file.buffer, { flag: 'wx', mode: 0o600 });
    res.status(201).json({ assetId, url: `/api/assets/${assetId}`, mime: detected.mime });
  }));
  app.get('/api/assets/:assetId', (req, res) => { const file = resolveAsset(assetDirectory, req.params.assetId); if (!file) return res.status(404).json({ error: '图片不存在或已过期。' }); res.setHeader('Cache-Control', 'private, max-age=86400'); res.type(path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'); res.sendFile(file); });
  app.delete('/api/assets/:assetId', requireLocalMutation, (req, res) => { const file = resolveAsset(assetDirectory, req.params.assetId); if (file) fs.unlinkSync(file); res.json({ deleted: Boolean(file) }); });

  app.post('/api/export/docx', route(async (req, res) => sendDocx(res, normalizeDocumentBlocks(req.body.blocks), req.body.title, assetDirectory)));
  app.post('/api/export/epub', route(async (req, res) => sendEpub(res, normalizeDocumentBlocks(req.body.blocks), req.body.title, req.body.languageCode, assetDirectory)));
  app.post('/api/export/bundle', route(async (req, res) => sendBundle(res, req.body)));

  app.get('/api/ports/check', route(async (req, res) => {
    const start = Number.parseInt(req.query.start, 10); const end = Number.parseInt(req.query.end ?? req.query.start, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end || end - start > 1000) throw Object.assign(new Error('端口范围必须在 1-65535 之间，且一次最多检测 1001 个端口。'), { status: 400 });
    const ports = []; for (let port = start; port <= end; port += 1) ports.push({ port, occupied: await isPortOccupied(port) });
    res.json({ start, end, ports, checkedAt: new Date().toISOString() });
  }));

  app.post('/api/translate', upload.single('file'), route(async (req, res) => {
    const source = req.body.text || (req.file ? req.file.buffer.toString('utf8') : ''); if (!source.trim()) throw Object.assign(new Error('请输入文字或选择文件。'), { status: 400 });
    const apiKey = await getApiKey(); if (!apiKey) throw Object.assign(new Error('尚未配置 DeepSeek API Key。'), { status: 500 });
    const response = await fetchImpl('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.2, messages: [{ role: 'system', content: `你是一名专业翻译。将用户提供的内容翻译成${req.body.targetLanguage || '中文'}。保留格式，只输出译文。` }, { role: 'user', content: source }] }) });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'DeepSeek API 请求失败。'), { status: response.status });
    res.json({ translation: data.choices?.[0]?.message?.content || '', filename: req.file?.originalname || 'translation.txt' });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` }));
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api/')) return next(error);
    console.error(`[api] ${req.method} ${req.path} failed: ${error.message}`);
    res.status(error.status || 500).json({ error: error.status === 413 ? '请求内容过大。' : error.message || '服务器处理请求时发生错误。', details: error.details });
  });
  app.get('*', (_req, res) => res.sendFile(path.join(baseDirectory, 'public', 'index.html')));
  return { app, database, repositories, secretStore, translationService };
}

function route(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function sanitizeUiSettings(input = {}) { return { selectedRuleSetIds: Array.isArray(input.selectedRuleSetIds) ? input.selectedRuleSetIds.map(String).slice(0,20) : [], validationMode: ['strict','warning','off'].includes(input.validationMode) ? input.validationMode : 'warning', notifications: Boolean(input.notifications) }; }
function requireLocalMutation(req, res, next) { const origin = req.get('origin'); if (!origin) return next(); try { const host = new URL(origin).hostname; if (['localhost','127.0.0.1','[::1]'].includes(host)) return next(); } catch {} res.status(403).json({ error: '仅允许本机页面修改数据。' }); }
function limitKeyUpdates(attempts) { return (req, res, next) => { const timestamp = Date.now(); const recent = (attempts.get(req.ip) || []).filter((time) => timestamp - time < 60000); if (recent.length >= 5) return res.status(429).json({ error: '操作过于频繁，请一分钟后再试。' }); recent.push(timestamp); attempts.set(req.ip, recent); next(); }; }
function cleanupAssets(directory) { for (const name of fs.readdirSync(directory)) try { const file = path.join(directory, name); if (Date.now() - fs.statSync(file).mtimeMs > 7 * 86400000) fs.unlinkSync(file); } catch {} }
function restrictDataDirectory(directory) { if (process.platform !== 'win32') return; const account = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME; if (!account) return; const result = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); if (result.status !== 0) console.warn('[security] 无法限制 data 目录访问权限，继续使用现有权限。'); }
function normalizeDocumentBlocks(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw Object.assign(new Error('文档必须包含 1 到 500 个内容块。'), { status: 400 }); let textLength = 0;
  const blocks = input.map((block, index) => { if (block?.kind === 'text') { const text = typeof block.text === 'string' ? block.text.replace(/\r\n/g, '\n') : ''; textLength += text.length; return { id: `text-${index}`, kind: 'text', tag: textTags.has(block.tag) ? block.tag : 'p', text }; } if (block?.kind === 'image') { const assetId = String(block.assetId || ''); if (!assetPattern.test(assetId)) throw Object.assign(new Error('文档包含无效的图片引用。'), { status: 400 }); return { id: `image-${index}`, kind: 'image', assetId, alt: String(block.alt || '').slice(0,200), width: Math.max(1, Math.min(4000, Number(block.width) || 900)), height: Math.max(1, Math.min(4000, Number(block.height) || 600)) }; } throw Object.assign(new Error('文档包含不支持的内容块。'), { status: 400 }); });
  if (textLength > 200000) throw Object.assign(new Error('文档文字不能超过 200,000 字符。'), { status: 413 }); return blocks;
}
function detectImage(buffer) { if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { extension: 'png', mime: 'image/png' }; if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' }; return null; }
function resolveAsset(directory, assetId) { if (!assetPattern.test(assetId)) return null; const file = path.join(directory, assetId); return fs.existsSync(file) ? file : null; }
function escapeXml(value = '') { return String(value).replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' })[character]); }
function safeDownloadName(value, fallback) { return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0,100) || fallback; }
function scaledImageSize(block) { const scale = Math.min(1, 600 / block.width, 760 / block.height); return { width: Math.max(1, Math.round(block.width * scale)), height: Math.max(1, Math.round(block.height * scale)) }; }
function textRuns(text) { return text.split('\n').map((line, index) => new TextRun({ text: line, break: index > 0 ? 1 : undefined })); }
async function sendDocx(res, blocks, titleValue, assets) { const headingMap = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }; const children = []; for (const block of blocks) { if (block.kind === 'text') { const options = { children: textRuns(block.text), spacing: { after: 140, line: 320 } }; if (headingMap[block.tag]) options.heading = headingMap[block.tag]; if (block.tag === 'li') options.bullet = { level: 0 }; children.push(new Paragraph(options)); } else { const file = resolveAsset(assets, block.assetId); if (!file) throw Object.assign(new Error(`图片 ${block.assetId} 不存在或已过期。`), { status: 400 }); children.push(new Paragraph({ children: [new ImageRun({ type: path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpg', data: fs.readFileSync(file), transformation: scaledImageSize(block) })] })); } } const title = safeDownloadName(titleValue, 'translation'); const buffer = await Packer.toBuffer(new Document({ creator: 'AIWordTranslateService9527', title, description: '由 AIWordTranslateService9527 ver0.1 生成', sections: [{ properties: {}, children }] })); res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.docx`)}`); res.send(buffer); }
async function sendEpub(res, blocks, titleValue, languageCode, assets) { const title = safeDownloadName(titleValue, 'translation'); const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(languageCode || '') ? languageCode : 'zh-CN'; const zip = new JSZip(); zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'); const manifests = []; const added = new Set(); let body = ''; for (const block of blocks) { if (block.kind === 'text') body += `<${block.tag === 'li' ? 'p' : block.tag}>${escapeXml(block.text).replace(/\n/g,'<br/>')}</${block.tag === 'li' ? 'p' : block.tag}>`; else { const file = resolveAsset(assets, block.assetId); if (!file) throw Object.assign(new Error(`图片 ${block.assetId} 不存在或已过期。`), { status: 400 }); if (!added.has(block.assetId)) { const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'; zip.file(`OEBPS/images/${block.assetId}`, fs.readFileSync(file)); manifests.push(`<item id="img-${manifests.length + 1}" href="images/${block.assetId}" media-type="${mime}"/>`); added.add(block.assetId); } body += `<figure><img src="images/${block.assetId}" alt="${escapeXml(block.alt)}"/></figure>`; } } const id = `urn:uuid:${randomUUID()}`; zip.file('OEBPS/content.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" href="styles.css"/></head><body>${body}</body></html>`); zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="content.xhtml">${escapeXml(title)}</a></li></ol></nav></body></html>`); zip.file('OEBPS/styles.css', 'body{font-family:serif;line-height:1.75;margin:5%}img{display:block;max-width:100%;height:auto;margin:1em auto}'); zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${id}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><dc:creator>AIWordTranslateService9527</dc:creator><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}</meta></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/>${manifests.join('')}</manifest><spine><itemref idref="content"/></spine></package>`); const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }); res.type('application/epub+zip'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.epub`)}`); res.send(buffer); }
async function sendBundle(res, input) { const zip = new JSZip(); const title = safeDownloadName(input.title, 'translation'); const sourceBlocks = normalizeDocumentBlocks(input.sourceBlocks); const translatedBlocks = normalizeDocumentBlocks(input.translatedBlocks); const source = sourceBlocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'); const translation = translatedBlocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'); const meta = input.meta || {}; const selected = input.selected || {}; if (selected.translation !== false) zip.file('translated.txt', translation); if (selected.source) zip.file('source.txt', source); if (selected.glossary) zip.file('glossary.tsv', ['原文术语\t规定译法\t分类\t来源规则集', ...(meta.appliedRules || []).map((r) => [r.source,r.target,r.category,r.ruleSetName].map(tsv).join('\t'))].join('\n')); if (selected.notes) zip.file('translation-notes.md', markdownList('翻译说明', meta.notes)); if (selected.analysis) zip.file('analysis-summary.md', `${markdownList('翻译决策摘要', meta.decisionSummary)}\n\n${markdownList('不确定项', meta.uncertainties)}`); if (selected.rules) zip.file('applied-rules.json', JSON.stringify(meta.appliedRules || [], null, 2)); if (selected.manifest) zip.file('manifest.json', JSON.stringify({ version: 'ver0.1', title, model: input.model || 'deepseek-chat', targetLanguage: input.targetLanguage, ruleSets: meta.ruleSets || [], sourceCharacters: source.length, translatedCharacters: translation.length, exportedAt: new Date().toISOString() }, null, 2)); const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); res.type('application/zip'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}_资料包.zip`)}`); res.send(buffer); }
function markdownList(title, values) { const items = Array.isArray(values) ? values : []; return `# ${title}\n\n${items.length ? items.map((item) => `- ${String(item)}`).join('\n') : '- 无'}`; }
function tsv(value) { return String(value || '').replace(/[\t\r\n]+/g, ' '); }
function checkPortOnHost(port, host) { return new Promise((resolve) => { const tester = net.createServer(); tester.once('error', (error) => resolve(error.code === 'EADDRINUSE')); tester.once('listening', () => tester.close(() => resolve(false))); tester.listen({ port, host }); }); }
async function isPortOccupied(port) { return (await checkPortOnHost(port, '127.0.0.1')) || (await checkPortOnHost(port, '::1')); }
