import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('all schemas and fixed contract examples are valid JSON', () => {
  const names = ['manifest', 'document-json', 'document', 'content-block', 'image-block', 'translation-job'];
  for (const name of names) {
    assert.equal(json(`schemas/${name}.schema.json`).$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(json(`test/fixtures/contracts/${name}.valid.json`));
  }
});

test('package asset paths remain separate from committed local asset ids', () => {
  const external = json('test/fixtures/contracts/document-json.valid.json');
  const internal = json('test/fixtures/contracts/document.valid.json');
  assert.equal(external.blocks.find((block) => block.kind === 'image').assetPath, 'assets/illustration.png');
  assert.match(internal.blocks.find((block) => block.kind === 'image').assetId, /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/);
});
