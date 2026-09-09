import { randomUUID } from 'node:crypto';
import { withTransaction } from './database.js';
import { resolveRuleConflicts } from './rules.js';

const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const now = () => new Date().toISOString();
const strings = (value) => Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 100) : [];
const sendMode = (value) => ['matched', 'always', 'contextual', 'manual'].includes(value) ? value : 'matched';

export class SettingsRepository {
  constructor(database) { this.database = database; }
  get(key, fallback = null) {
    const row = this.database.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }
  set(key, value) {
    this.database.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now());
    return value;
  }
}

export class SecretRecordRepository {
  constructor(database) { this.database = database; }
  get(scopeId, secretName) {
    const row = this.database.prepare('SELECT * FROM secret_records WHERE scope_id=? AND secret_name=?').get(scopeId, secretName);
    return row ? { scopeId: row.scope_id, secretName: row.secret_name, provider: row.provider, formatVersion: row.format_version, ciphertext: row.ciphertext, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  save(record) {
    const timestamp = now();
    this.database.prepare(`INSERT INTO secret_records(scope_id,secret_name,provider,format_version,ciphertext,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,secret_name) DO UPDATE SET provider=excluded.provider,
      format_version=excluded.format_version,ciphertext=excluded.ciphertext,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .run(record.scopeId, record.secretName, record.provider, record.formatVersion, record.ciphertext, JSON.stringify(record.metadata || {}), timestamp, timestamp);
    return this.get(record.scopeId, record.secretName);
  }
  delete(scopeId, secretName) {
    return Number(this.database.prepare('DELETE FROM secret_records WHERE scope_id=? AND secret_name=?').run(scopeId, secretName).changes) > 0;
  }
}

function cleanName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 100) throw Object.assign(new Error('规则集名称必须为 1 到 100 个字符。'), { status: 400 });
  return value;
}

function hydrateRule(row) {
  return { id: row.id, ruleSetId: row.rule_set_id, type: row.type, source: row.source, target: row.target, aliases: parseJson(row.aliases_json, []), forbidden: parseJson(row.forbidden_json, []), category: row.category, sendMode: row.send_mode, enabled: Boolean(row.enabled), priority: row.priority, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class RuleSetRepository {
  constructor(database) { this.database = database; }
  list({ includeDeleted = false } = {}) {
    const rows = this.database.prepare(`SELECT * FROM rule_sets ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY deleted_at IS NOT NULL,priority DESC,updated_at DESC`).all();
    return rows.map((row) => this.#hydrate(row, false));
  }
  getById(id, { includeDeleted = false } = {}) {
    const row = this.database.prepare(`SELECT * FROM rule_sets WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id);
    return row ? this.#hydrate(row, true) : null;
  }
  create(input = {}, options = {}) {
    const name = cleanName(input.name);
    if (this.database.prepare('SELECT 1 FROM rule_sets WHERE name=? AND deleted_at IS NULL').get(name)) throw Object.assign(new Error('已存在同名规则集。'), { status: 409 });
    const id = randomUUID(); const timestamp = now();
    this.database.prepare('INSERT INTO rule_sets(id,name,description,version,priority,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,NULL)')
      .run(id, name, String(input.description || '').trim().slice(0, 500), 1, Math.max(-10000, Math.min(10000, Number(input.priority) || 0)), timestamp, timestamp);
    if (!options.skipSnapshot) this.#snapshot(id);
    return this.getById(id);
  }
  update(id, changes = {}, expectedVersion) {
    const current = this.getById(id);
    if (!current) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    if (expectedVersion != null && Number(expectedVersion) !== current.version) throw Object.assign(new Error('规则集已被修改，请刷新后重试。'), { status: 409 });
    const nextName = changes.name == null ? current.name : cleanName(changes.name);
    if (this.database.prepare('SELECT 1 FROM rule_sets WHERE name=? AND id<>? AND deleted_at IS NULL').get(nextName, id)) throw Object.assign(new Error('已存在同名规则集。'), { status: 409 });
    const timestamp = now();
    this.database.prepare('UPDATE rule_sets SET name=?,description=?,priority=?,version=version+1,updated_at=? WHERE id=?')
      .run(nextName, changes.description == null ? current.description : String(changes.description).trim().slice(0, 500), changes.priority == null ? current.priority : Math.max(-10000, Math.min(10000, Number(changes.priority) || 0)), timestamp, id);
    this.#snapshot(id); return this.getById(id);
  }
  copy(id, name) {
    const source = this.getById(id);
    if (!source) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    return withTransaction(this.database, () => {
      const target = this.create({ name: name || `${source.name} 副本`, description: source.description, priority: source.priority }, { skipSnapshot: true });
      for (const rule of source.rules) this.#insertRule(target.id, rule);
      this.#snapshot(target.id); return this.getById(target.id);
    });
  }
  import(input = {}) {
    const rules = Array.isArray(input.rules) ? input.rules : [];
    if (rules.length > 2000) throw Object.assign(new Error('单个规则集最多导入 2,000 条规则。'), { status: 400 });
    return withTransaction(this.database, () => {
      const item = this.create({ name: input.name, description: input.description, priority: input.priority }, { skipSnapshot: true });
      for (const rule of rules) this.#insertRule(item.id, rule);
      this.#snapshot(item.id);
      return this.getById(item.id);
    });
  }
  export(id) {
    const item = this.getById(id);
    if (!item) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    return { schemaVersion: 1, exportedAt: now(), ruleSet: { name: item.name, description: item.description, priority: item.priority, rules: item.rules.map(({ id: _id, ruleSetId: _ruleSetId, createdAt: _createdAt, updatedAt: _updatedAt, ...rule }) => rule) } };
  }
  listVersions(id) {
    if (!this.getById(id, { includeDeleted: true })) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    return this.database.prepare('SELECT version,snapshot_json,created_at FROM rule_set_versions WHERE rule_set_id=? ORDER BY version DESC').all(id).map((row) => {
      const snapshot = parseJson(row.snapshot_json, {});
      return { version: Number(row.version), createdAt: row.created_at, name: snapshot.name || '', ruleCount: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0 };
    });
  }
  restoreVersion(id, version) {
    const current = this.getById(id);
    if (!current) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    const row = this.database.prepare('SELECT snapshot_json FROM rule_set_versions WHERE rule_set_id=? AND version=?').get(id, Number(version));
    if (!row) throw Object.assign(new Error('规则集历史版本不存在。'), { status: 404 });
    const snapshot = parseJson(row.snapshot_json, null);
    if (!snapshot || !Array.isArray(snapshot.rules)) throw Object.assign(new Error('规则集历史版本数据无效。'), { status: 500 });
    return withTransaction(this.database, () => {
      this.database.prepare('DELETE FROM rules WHERE rule_set_id=?').run(id);
      this.database.prepare('UPDATE rule_sets SET description=?,priority=?,version=?,updated_at=? WHERE id=?').run(String(snapshot.description || '').slice(0, 500), Math.max(-10000, Math.min(10000, Number(snapshot.priority) || 0)), current.version + 1, now(), id);
      for (const rule of snapshot.rules.slice(0, 2000)) this.#insertRule(id, rule, { preserveId: true });
      this.#snapshot(id);
      return this.getById(id);
    });
  }
  softDelete(id) {
    if (!this.getById(id)) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    const timestamp = now(); this.database.prepare('UPDATE rule_sets SET deleted_at=?,updated_at=? WHERE id=?').run(timestamp, timestamp, id);
    return this.getById(id, { includeDeleted: true });
  }
  restore(id) {
    const item = this.getById(id, { includeDeleted: true });
    if (!item) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    if (this.database.prepare('SELECT 1 FROM rule_sets WHERE name=? AND id<>? AND deleted_at IS NULL').get(item.name, id)) throw Object.assign(new Error('已有同名规则集，请先重命名当前规则集或回收站中的规则集。'), { status: 409 });
    this.database.prepare('UPDATE rule_sets SET deleted_at=NULL,updated_at=? WHERE id=?').run(now(), id);
    return this.getById(id);
  }
  addRule(ruleSetId, input = {}) {
    if (!this.getById(ruleSetId)) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    return withTransaction(this.database, () => { const rule = this.#insertRule(ruleSetId, input); this.#bump(ruleSetId); return rule; });
  }
  updateRule(ruleSetId, ruleId, changes = {}) {
    return withTransaction(this.database, () => { const rule = this.#updateRule(ruleSetId, ruleId, changes); this.#bump(ruleSetId); return rule; });
  }
  deleteRule(ruleSetId, ruleId) {
    return withTransaction(this.database, () => { this.#deleteRule(ruleSetId, ruleId); this.#bump(ruleSetId); return true; });
  }
  applyOperations(ruleSetId, operations = []) {
    const ruleSet = this.getById(ruleSetId);
    if (!ruleSet) throw Object.assign(new Error('规则集不存在。'), { status: 404 });
    const values = Array.isArray(operations) ? operations.slice(0, 100) : [];
    if (!values.length) return { applied: [], ruleSet };
    return withTransaction(this.database, () => {
      const applied = [];
      for (const operation of values) {
        if (operation.action === 'add') applied.push(this.#insertRule(ruleSetId, operation));
        else if (operation.action === 'update' && operation.ruleId) applied.push(this.#updateRule(ruleSetId, operation.ruleId, operation));
        else if (operation.action === 'disable' && operation.ruleId) applied.push(this.#updateRule(ruleSetId, operation.ruleId, { enabled: false }));
        else if (operation.action === 'delete' && operation.ruleId) { this.#deleteRule(ruleSetId, operation.ruleId); applied.push({ ruleId: operation.ruleId, deleted: true }); }
        else throw Object.assign(new Error('候选规则操作无效，未保存任何修改。'), { status: 400 });
      }
      const candidateRules = this.getById(ruleSetId).rules.map((rule) => ({ ...rule, effectivePriority: ruleSet.priority * 100000 + rule.priority }));
      const { conflicts } = resolveRuleConflicts(candidateRules);
      if (conflicts.length) throw Object.assign(new Error('候选规则存在同优先级冲突，未保存任何修改。'), { status: 409, details: conflicts });
      this.#bump(ruleSetId);
      return { applied, ruleSet: this.getById(ruleSetId) };
    });
  }
  #updateRule(ruleSetId, ruleId, changes = {}) {
    const row = this.database.prepare('SELECT * FROM rules WHERE id=? AND rule_set_id=?').get(ruleId, ruleSetId);
    if (!row) throw Object.assign(new Error('规则不存在。'), { status: 404 });
    const next = { ...hydrateRule(row), ...changes };
    this.#validateRule(next);
    this.database.prepare(`UPDATE rules SET type=?,source=?,target=?,aliases_json=?,forbidden_json=?,category=?,send_mode=?,enabled=?,priority=?,note=?,updated_at=? WHERE id=? AND rule_set_id=?`)
      .run(next.type, String(next.source || '').trim().slice(0, 300), String(next.target || '').trim().slice(0, 300), JSON.stringify(strings(next.aliases)), JSON.stringify(strings(next.forbidden)), String(next.category || '').slice(0, 80), sendMode(next.sendMode), next.enabled === false ? 0 : 1, Number(next.priority) || 0, String(next.note || '').slice(0, 500), now(), ruleId, ruleSetId);
    return hydrateRule(this.database.prepare('SELECT * FROM rules WHERE id=?').get(ruleId));
  }
  #deleteRule(ruleSetId, ruleId) {
    if (!Number(this.database.prepare('DELETE FROM rules WHERE id=? AND rule_set_id=?').run(ruleId, ruleSetId).changes)) throw Object.assign(new Error('规则不存在。'), { status: 404 });
  }
  #insertRule(ruleSetId, input, { preserveId = false } = {}) {
    const rule = { id: preserveId && /^[0-9a-f-]{36}$/i.test(input.id || '') ? input.id : randomUUID(), type: String(input.type || 'term'), source: String(input.source || '').trim().slice(0, 300), target: String(input.target || '').trim().slice(0, 300), aliases: strings(input.aliases), forbidden: strings(input.forbidden), category: String(input.category || '').slice(0, 80), sendMode: sendMode(input.sendMode), enabled: input.enabled !== false, priority: Math.max(-10000, Math.min(10000, Number(input.priority) || 0)), note: String(input.note || '').slice(0, 500) };
    this.#validateRule(rule); const timestamp = now();
    this.database.prepare(`INSERT INTO rules(id,rule_set_id,type,source,target,aliases_json,forbidden_json,category,send_mode,enabled,priority,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rule.id, ruleSetId, rule.type, rule.source, rule.target, JSON.stringify(rule.aliases), JSON.stringify(rule.forbidden), rule.category, rule.sendMode, rule.enabled ? 1 : 0, rule.priority, rule.note, timestamp, timestamp);
    return hydrateRule(this.database.prepare('SELECT * FROM rules WHERE id=?').get(rule.id));
  }
  #validateRule(rule) {
    const allowed = ['term','person','place','organization','skill','style','title','forbidden','format','background','temporary'];
    if (!allowed.includes(rule.type)) throw Object.assign(new Error('规则类型无效。'), { status: 400 });
    if (!rule.source && !['style','background','format'].includes(rule.type)) throw Object.assign(new Error('规则原文不能为空。'), { status: 400 });
    if (!rule.target && !['background','format'].includes(rule.type)) throw Object.assign(new Error('规则目标内容不能为空。'), { status: 400 });
  }
  #hydrate(row, includeRules) {
    const item = { id: row.id, name: row.name, description: row.description, version: row.version, priority: row.priority, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, ruleCount: Number(this.database.prepare('SELECT COUNT(*) count FROM rules WHERE rule_set_id=?').get(row.id).count) };
    if (includeRules) item.rules = this.database.prepare('SELECT * FROM rules WHERE rule_set_id=? ORDER BY priority DESC,created_at').all(row.id).map(hydrateRule);
    return item;
  }
  #bump(id) { this.database.prepare('UPDATE rule_sets SET version=version+1,updated_at=? WHERE id=?').run(now(), id); this.#snapshot(id); }
  #snapshot(id) {
    const item = this.getById(id, { includeDeleted: true }); if (!item) return;
    this.database.prepare('INSERT OR REPLACE INTO rule_set_versions(id,rule_set_id,version,snapshot_json,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), id, item.version, JSON.stringify(item), now());
  }
}

export class TranslationJobRepository {
  constructor(database) { this.database = database; }
  create(input) {
    const timestamp = now(); const id = input.id || randomUUID(); const segments = input.segments || [];
    this.database.prepare(`INSERT INTO translation_jobs(id,title,target_language,model,rule_set_ids_json,validation_mode,status,source_blocks_json,segments_json,result_blocks_json,meta_json,total_segments,completed_segments,current_segment,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.title || 'translation', input.targetLanguage || '中文', input.model || 'deepseek-chat', JSON.stringify(input.ruleSetIds || []), input.validationMode || 'warning', input.status || 'pending', JSON.stringify(input.sourceBlocks || []), JSON.stringify(segments), JSON.stringify(input.resultBlocks || []), JSON.stringify(input.meta || {}), segments.length, 0, 0, timestamp, timestamp, input.expiresAt || new Date(Date.now() + 7 * 86400000).toISOString());
    return this.getById(id);
  }
  getById(id) { const row = this.database.prepare('SELECT * FROM translation_jobs WHERE id=?').get(id); return row ? hydrateJob(row) : null; }
  update(id, changes = {}) {
    const current = this.getById(id); if (!current) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });
    const next = { ...current, ...changes }; const completed = next.segments.filter((item) => item.status === 'completed').length;
    this.database.prepare('UPDATE translation_jobs SET status=?,segments_json=?,result_blocks_json=?,meta_json=?,completed_segments=?,current_segment=?,updated_at=? WHERE id=?')
      .run(next.status, JSON.stringify(next.segments), JSON.stringify(next.resultBlocks || []), JSON.stringify(next.meta || {}), completed, Number(next.currentSegment) || 0, now(), id);
    return this.getById(id);
  }
  listRecoverable() { return this.database.prepare(`SELECT * FROM translation_jobs WHERE expires_at>? AND status IN ('pending','running','failed','cancelled') ORDER BY updated_at DESC LIMIT 10`).all(now()).map(hydrateJob); }
  delete(id) { return Number(this.database.prepare('DELETE FROM translation_jobs WHERE id=?').run(id).changes) > 0; }
  purgeExpired() { return Number(this.database.prepare('DELETE FROM translation_jobs WHERE expires_at<=?').run(now()).changes); }
}

function hydrateJob(row) {
  return { id: row.id, title: row.title, targetLanguage: row.target_language, model: row.model, ruleSetIds: parseJson(row.rule_set_ids_json, []), validationMode: row.validation_mode, status: row.status, sourceBlocks: parseJson(row.source_blocks_json, []), segments: parseJson(row.segments_json, []), resultBlocks: parseJson(row.result_blocks_json, []), meta: parseJson(row.meta_json, {}), totalSegments: row.total_segments, completedSegments: row.completed_segments, currentSegment: row.current_segment, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
}
