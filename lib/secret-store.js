import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretStore {
  async save() { throw new Error('SecretStore.save must be implemented.'); }
  async read() { throw new Error('SecretStore.read must be implemented.'); }
  async delete() { throw new Error('SecretStore.delete must be implemented.'); }
  async rotate(scopeId, secretName) {
    const value = await this.read(scopeId, secretName);
    if (value) await this.save(scopeId, secretName, value);
    return Boolean(value);
  }
}

export class MemorySecretStore extends SecretStore {
  constructor() { super(); this.values = new Map(); }
  async save(scopeId, secretName, plaintext) { this.values.set(`${scopeId}:${secretName}`, String(plaintext)); }
  async read(scopeId, secretName) { return this.values.get(`${scopeId}:${secretName}`) || ''; }
  async delete(scopeId, secretName) { return this.values.delete(`${scopeId}:${secretName}`); }
}

export class AesGcmSecretStore extends SecretStore {
  constructor(repository, masterKeyFile) { super(); this.repository = repository; this.masterKeyFile = masterKeyFile; }
  getMasterKey({ create = false } = {}) {
    if (!fs.existsSync(this.masterKeyFile)) {
      if (!create) return null;
      fs.writeFileSync(this.masterKeyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    const key = fs.readFileSync(this.masterKeyFile);
    if (key.length !== 32) throw new Error('本地主密钥文件无效，应为 32 字节。');
    return key;
  }
  async save(scopeId, secretName, plaintext) {
    const value = String(plaintext || '');
    if (!value) throw new Error('不能保存空密钥。');
    const key = this.getMasterKey({ create: true });
    const iv = randomBytes(12);
    const aad = Buffer.from(`AIWordTranslateService9527:${scopeId}:${secretName}:v1`, 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.repository.save({
      scopeId,
      secretName,
      provider: 'local-aes-256-gcm',
      formatVersion: 1,
      ciphertext: ciphertext.toString('base64'),
      metadata: { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), aadVersion: 1 }
    });
  }
  async read(scopeId, secretName) {
    const record = this.repository.get(scopeId, secretName);
    if (!record) return '';
    if (record.provider !== 'local-aes-256-gcm') throw new Error(`本地 AES 密钥存储无法读取 ${record.provider} 密钥，请重新填写 API Key。`);
    const key = this.getMasterKey();
    if (!key) throw new Error('找不到本地主密钥文件，请重新填写 API Key。');
    const aad = Buffer.from(`AIWordTranslateService9527:${scopeId}:${secretName}:v1`, 'utf8');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.metadata.iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(record.metadata.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
  async delete(scopeId, secretName) { return this.repository.delete(scopeId, secretName); }
}

export class KmsSecretStore extends SecretStore {
  constructor(adapter, repository) { super(); this.adapter = adapter; this.repository = repository; }
  async save(scopeId, secretName, plaintext) {
    if (!this.adapter?.encrypt) throw new Error('尚未配置云端 KMS 适配器。');
    const encrypted = await this.adapter.encrypt(String(plaintext), { scopeId, secretName });
    this.repository.save({ scopeId, secretName, provider: 'cloud-kms', formatVersion: 2, ciphertext: encrypted.ciphertext, metadata: encrypted.metadata });
  }
  async read(scopeId, secretName) {
    const record = this.repository.get(scopeId, secretName); if (!record) return '';
    if (!this.adapter?.decrypt) throw new Error('尚未配置云端 KMS 适配器。');
    return this.adapter.decrypt(record.ciphertext, record.metadata, { scopeId, secretName });
  }
  async delete(scopeId, secretName) { return this.repository.delete(scopeId, secretName); }
}

export function readLegacySecret(secretFile, masterKeyFile) {
  if (!fs.existsSync(secretFile) || !fs.existsSync(masterKeyFile)) return '';
  const payload = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(masterKeyFile), Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from('deepseek-local-translator:v1'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export async function migrateLegacySecret({ secretStore, scopeId, secretName, secretFile, masterKeyFile }) {
  if (await secretStore.read(scopeId, secretName)) return { migrated: false, reason: 'already-present' };
  if (!fs.existsSync(secretFile) || !fs.existsSync(masterKeyFile)) return { migrated: false, reason: 'not-found' };
  const plaintext = readLegacySecret(secretFile, masterKeyFile);
  await secretStore.save(scopeId, secretName, plaintext);
  const verified = await secretStore.read(scopeId, secretName);
  if (verified !== plaintext) throw new Error('迁移后的 API Key 校验失败，旧密钥文件已保留。');
  fs.unlinkSync(secretFile);
  return { migrated: true };
}
