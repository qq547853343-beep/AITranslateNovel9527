const activePatterns = [
  /<!doctype\b/i,
  /<!entity\b/i,
  /<script\b/i,
  /<\?(?:xml-)?stylesheet\b/i,
  /<foreignObject\b/i,
  /<(?:animate|animateMotion|animateTransform|set)\b/i,
  /<(?:iframe|object|embed)\b/i,
  /\son[a-z0-9:_-]*\s*=/i,
  /\bjavascript\s*:/i,
  /@import\b/i,
  /@font-face\b/i,
  /(?:href|xlink:href)\s*=\s*["']\s*(?!#(?:[A-Za-z_][\w:.-]*)?["'])/i,
  /url\(\s*["']?(?!#[A-Za-z_][\w:.-]*["']?\s*\))/i,
];

export function validateSafeSvg(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw svgError('SVG 必须使用有效的 UTF-8 编码。', 'WEB_PACKAGE_SVG_ENCODING_INVALID'); }
  if (!text || text.includes('\0')) throw svgError('SVG 内容为空或包含非法字符。', 'WEB_PACKAGE_SVG_INVALID');
  const root = stripLeadingMetadata(text);
  if (activePatterns.some((pattern) => pattern.test(root))) {
    throw svgError('SVG 包含脚本、事件、外部引用或其他主动内容，已拒绝导入。', 'WEB_PACKAGE_SVG_ACTIVE_CONTENT');
  }
  if (!/^<svg(?:\s|>)/i.test(root) || !(/<\/svg\s*>\s*$/i.test(root) || /^<svg\b[^>]*\/\s*>\s*$/is.test(root))) {
    throw svgError('SVG 必须是独立且完整的 <svg> 文档。', 'WEB_PACKAGE_SVG_INVALID');
  }
  if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(root)) {
    throw svgError('SVG 根元素缺少标准命名空间。', 'WEB_PACKAGE_SVG_NAMESPACE_INVALID');
  }
  return { text, extension: 'svg', mime: 'image/svg+xml' };
}

function stripLeadingMetadata(input) {
  let value = input.replace(/^\uFEFF/, '').trimStart();
  while (value.startsWith('<?xml') || value.startsWith('<!--')) {
    const end = value.startsWith('<?xml') ? value.indexOf('?>') : value.indexOf('-->');
    if (end < 0) break;
    value = value.slice(end + (value.startsWith('<?xml') ? 2 : 3)).trimStart();
  }
  return value;
}

function svgError(message, code) { return Object.assign(new Error(message), { name: 'SvgValidationError', code, status: 415 }); }
