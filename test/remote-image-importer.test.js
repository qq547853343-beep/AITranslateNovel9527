import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteImageImporter, isPublicIpAddress, validateRemoteImageUrl } from '../lib/remote-image-importer.js';

test('remote image importer rejects loopback, private and reserved addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.16.1.2', '192.168.1.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2001:db8::1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.throws(() => validateRemoteImageUrl('file:///c:/secret.txt'), (error) => error.code === 'REMOTE_IMAGE_PROTOCOL_UNSUPPORTED');
  assert.throws(() => validateRemoteImageUrl('http://localhost/image.png'), (error) => error.code === 'REMOTE_IMAGE_HOST_FORBIDDEN');
  const importer = new RemoteImageImporter({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(() => importer.fetch('http://example.com/image.png'), (error) => error.code === 'REMOTE_IMAGE_ADDRESS_FORBIDDEN');
});

test('remote image importer pins a validated address and revalidates redirects', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const calls = [];
  const importer = new RemoteImageImporter({
    resolveHost: async (hostname) => hostname === 'public.example' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    requestImage: async (url, address) => { calls.push({ url: url.href, address: address.address }); return { statusCode: 200, headers: {}, buffer: png }; }
  });
  assert.equal(await importer.fetch('https://public.example/image.png'), png);
  assert.deepEqual(calls, [{ url: 'https://public.example/image.png', address: '8.8.8.8' }]);

  const redirected = new RemoteImageImporter({
    resolveHost: async (hostname) => hostname === 'public.example' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    requestImage: async () => ({ statusCode: 302, headers: { location: 'http://private.example/image.png' }, buffer: Buffer.alloc(0) })
  });
  await assert.rejects(() => redirected.fetch('https://public.example/image.png'), (error) => error.code === 'REMOTE_IMAGE_ADDRESS_FORBIDDEN');
});
