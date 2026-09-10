const activePatterns = [
  /<!doctype\b/i, /<!entity\b/i, /<script\b/i, /<\?(?:xml-)?stylesheet\b/i, /<foreignObject\b/i, /<(?:animate|animateMotion|animateTransform|set)\b/i, /<(?:iframe|object|embed)\b/i,
  /\son[a-z0-9:_-]*\s*=/i, /\bjavascript\s*:/i, /@import\b/i, /@font-face\b/i,
  /(?:href|xlink:href)\s*=\s*["']\s*(?!#(?:[A-Za-z_][\w:.-]*)?["'])/i,
  /url\(\s*["']?(?!#[A-Za-z_][\w:.-]*["']?\s*\))/i,
];

export function validateSafeSvg(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('SVG 必须使用有效的 UTF-8 编码。'); }
  if (!text || text.includes('\0')) throw new Error('SVG 内容为空或包含非法字符。');
  let root = text.replace(/^\uFEFF/, '').trimStart();
  while (root.startsWith('<?xml') || root.startsWith('<!--')) {
    const xml = root.startsWith('<?xml'); const end = root.indexOf(xml ? '?>' : '-->');
    if (end < 0) break;
    root = root.slice(end + (xml ? 2 : 3)).trimStart();
  }
  if (activePatterns.some((pattern) => pattern.test(root))) throw new Error('SVG 包含脚本、事件、外部引用或其他主动内容，不能原样导出。');
  if (!/^<svg(?:\s|>)/i.test(root) || !(/<\/svg\s*>\s*$/i.test(root) || /^<svg\b[^>]*\/\s*>\s*$/is.test(root))) throw new Error('SVG 必须是独立且完整的 <svg> 文档。');
  if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(root)) throw new Error('SVG 根元素缺少标准命名空间。');
  return { text, extension: 'svg', mime: 'image/svg+xml' };
}
