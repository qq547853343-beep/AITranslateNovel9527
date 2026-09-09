export function extractSelectedContent() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) throw new Error('请先在网页中选择要保存的文字或图片。');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < selection.rangeCount; index += 1) fragment.append(selection.getRangeAt(index).cloneContents());
  const blocks = []; let buffer = ''; let currentTag = 'p';
  const blockTags = { P: 'p', DIV: 'p', ARTICLE: 'p', SECTION: 'p', MAIN: 'p', H1: 'h1', H2: 'h2', H3: 'h3', BLOCKQUOTE: 'blockquote', LI: 'li', PRE: 'blockquote' };
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
  const cleanText = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  const flush = () => { const text = cleanText(buffer); if (text) blocks.push({ id: `text-${blocks.length}`, kind: 'text', tag: currentTag, text }); buffer = ''; };
  const walk = (node, inheritedTag = 'p') => {
    if (node.nodeType === Node.TEXT_NODE) { if (currentTag !== inheritedTag && cleanText(buffer)) flush(); currentTag = inheritedTag; buffer += node.nodeValue || ''; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) { for (const child of node.childNodes || []) walk(child, inheritedTag); return; }
    if (ignored.has(node.tagName)) return;
    if (node.tagName === 'BR') { buffer += '\n'; return; }
    if (node.tagName === 'IMG') {
      flush();
      const candidate = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original') || '';
      if (!candidate) return;
      let sourceUrl; try { sourceUrl = new URL(candidate, document.baseURI).href; } catch { return; }
      blocks.push({ id: `image-${blocks.length}`, kind: 'image', sourceUrl, alt: String(node.getAttribute('alt') || '').slice(0, 200), width: Math.max(1, Math.min(4000, Number(node.getAttribute('width')) || node.naturalWidth || 900)), height: Math.max(1, Math.min(4000, Number(node.getAttribute('height')) || node.naturalHeight || 600)) });
      return;
    }
    const nextTag = blockTags[node.tagName] || inheritedTag;
    const isBlock = Boolean(blockTags[node.tagName]);
    if (isBlock && cleanText(buffer)) flush();
    for (const child of node.childNodes) walk(child, nextTag);
    if (isBlock) flush();
  };
  for (const child of fragment.childNodes) walk(child);
  flush();
  if (!blocks.length) { const text = cleanText(selection.toString()); if (text) blocks.push({ id: 'text-0', kind: 'text', tag: 'p', text }); }
  if (!blocks.length) throw new Error('选区中没有可保存的文字或图片。');
  const selectedHeading = blocks.find((block) => block.kind === 'text' && /^h[1-3]$/.test(block.tag))?.text;
  return { title: String(selectedHeading || document.title || 'web-content').trim().slice(0, 100), language: String(document.documentElement.lang || '').slice(0, 40), sourceUrl: location.href, blocks };
}
