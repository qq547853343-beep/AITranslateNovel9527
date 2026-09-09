const encoder = new TextEncoder();
let crcTable;

export function createStoredZip(files, { date = new Date() } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 500) throw new Error('ZIP 文件数量必须在 1 到 500 之间。');
  const localParts = []; const centralParts = []; let offset = 0;
  const { time, day } = dosTime(date);
  for (const file of files) {
    const name = encoder.encode(String(file.name || ''));
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ''));
    if (!name.length || name.length > 65535 || data.length > 0xffffffff) throw new Error('ZIP 条目名称或大小无效。');
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length); const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true); localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true); localView.setUint16(12, day, true); localView.setUint32(14, crc, true); localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true); localView.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length); const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true); centralView.setUint16(14, day, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, data.length, true); centralView.setUint32(24, data.length, true); centralView.setUint16(28, name.length, true); centralView.setUint32(42, offset, true); central.set(name, 46);
    localParts.push(local, data); centralParts.push(central); offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22); const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  return concatenate([...localParts, ...centralParts, end]);
}

function crc32(bytes) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_unused, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function concatenate(parts) { const size = parts.reduce((sum, part) => sum + part.length, 0); const result = new Uint8Array(size); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function dosTime(value) { const date = value instanceof Date && !Number.isNaN(value.valueOf()) ? value : new Date(); return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() }; }
