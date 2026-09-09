import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/database.js';
import { SecretRecordRepository } from '../lib/repositories.js';
import { AesGcmSecretStore } from '../lib/secret-store.js';

test('portable AES-GCM store encrypts SQLite secret with an independent master key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-secret-'));
  const keyFile = path.join(directory, '.master-key');
  const database = openDatabase(':memory:'); const repository = new SecretRecordRepository(database); const store = new AesGcmSecretStore(repository, keyFile);
  const plaintext = 'sk-private-test-value-12345';
  await store.save('test-user', 'api-key', plaintext);
  const record = repository.get('test-user', 'api-key');
  assert.equal(record.provider, 'local-aes-256-gcm');
  assert.equal(fs.readFileSync(keyFile).length, 32);
  assert.equal(record.ciphertext.includes(plaintext), false);
  assert.equal(await store.read('test-user', 'api-key'), plaintext);
  await store.delete('test-user', 'api-key');
  assert.equal(await store.read('test-user', 'api-key'), '');
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('AES-GCM ciphertext cannot be read without its matching master key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-secret-'));
  const database = openDatabase(':memory:'); const repository = new SecretRecordRepository(database);
  const first = new AesGcmSecretStore(repository, path.join(directory, 'first.key'));
  const second = new AesGcmSecretStore(repository, path.join(directory, 'second.key'));
  await first.save('local-user', 'api-key', 'sk-secret-1234567890');
  await second.save('another-user', 'api-key', 'sk-other-1234567890');
  assert.rejects(() => new AesGcmSecretStore(repository, path.join(directory, 'second.key')).read('local-user', 'api-key'));
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
