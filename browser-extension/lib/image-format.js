export function detectImageFormat(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value)) return { extension: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { extension: 'gif', mime: 'image/gif' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  return null;
}
