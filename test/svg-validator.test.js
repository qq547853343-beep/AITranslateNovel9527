import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSafeSvg } from '../lib/infrastructure/svg-validator.js';

const encode = (value) => Buffer.from(value, 'utf8');
const safe = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0h1v1H0z"/><use href="#g"/></svg>';

test('safe SVG validation accepts local fragment references without changing bytes', () => {
  const bytes = encode(safe);
  const result = validateSafeSvg(bytes);
  assert.equal(result.extension, 'svg');
  assert.equal(result.mime, 'image/svg+xml');
  assert.equal(result.text, safe);
  assert.deepEqual(bytes, encode(safe));
});

test('safe SVG validation rejects active or externally referenced content', () => {
  const values = [
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:url(https://example.com/a)}</style></svg>',
  ];
  for (const value of values) assert.throws(() => validateSafeSvg(encode(value)), (error) => error.code === 'WEB_PACKAGE_SVG_ACTIVE_CONTENT');
});
