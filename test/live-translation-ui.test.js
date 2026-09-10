import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('translation UI exposes streaming, bounded scrolling, navigation and failed-segment controls', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  assert.match(app, /new EventSource\(`\/api\/translation-jobs\/\$\{encodeURIComponent\(this\.jobId\)\}\/events`\)/);
  assert.match(html, /ref="translationOutput"/); assert.match(html, /回到顶部/); assert.match(html, /回到当前/); assert.match(html, /retryFailedSegment\(segment\)/);
  assert.match(css, /\.rich-output\.translation-scroll\{[^}]*resize:vertical[^}]*overflow:auto/);
  assert.match(html, /outputMaxHeight\+'px'/); assert.match(html, /DeepSeek 余额/); assert.match(html, /当前任务/); assert.match(html, /本次服务会话/);
  assert.doesNotMatch(html, /v-model="apiKey"[^>]*value=/);
});

test('balance refresh remains independent from translation status and uses a fixed local API', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /this\.api\('\/api\/deepseek\/balance'\)/);
  assert.match(app, /setInterval\(\(\) => this\.refreshBalance\(\), 60000\)/);
  assert.match(app, /catch \(error\) \{ this\.balanceError =/);
  assert.doesNotMatch(app, /fetch\(['"]https:\/\/api\.deepseek\.com\/user\/balance/);
});
