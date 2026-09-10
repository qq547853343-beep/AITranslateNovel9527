export function extractSelectedContent() {
  const dimension = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.max(1, Math.min(4000, Math.round(number))) : fallback;
  };
  const collectSelectedImageMeasurements = (selectionValue) => {
    const result = new Map();
    for (const image of document.images || []) {
      let selected = false;
      for (let index = 0; index < selectionValue.rangeCount && !selected; index += 1) {
        try { selected = selectionValue.getRangeAt(index).intersectsNode(image); } catch {}
      }
      if (!selected) continue;
      const candidate = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original') || '';
      let sourceUrl; try { sourceUrl = new URL(candidate, document.baseURI).href; } catch { continue; }
      const rectangle = image.getBoundingClientRect();
      const values = result.get(sourceUrl) || [];
      values.push({ width: rectangle.width, height: rectangle.height });
      result.set(sourceUrl, values);
    }
    return result;
  };
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) throw new Error('请先在网页中选择要保存的文字或图片。');
  const imageMeasurements = collectSelectedImageMeasurements(selection);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < selection.rangeCount; index += 1) fragment.append(selection.getRangeAt(index).cloneContents());
  const blocks = []; let buffer = ''; let currentTag = 'p';
  const blockTags = { P: 'p', DIV: 'p', ARTICLE: 'p', SECTION: 'p', MAIN: 'p', H1: 'h1', H2: 'h2', H3: 'h3', BLOCKQUOTE: 'blockquote', LI: 'li', PRE: 'blockquote' };
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
  const cleanText = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  const semanticEmojiText = (node, candidate) => {
    const alt = String(node.getAttribute('alt') || '').trim();
    if (!alt || Array.from(alt).length > 16 || /[\r\n]/.test(alt)) return '';
    const classes = String(node.getAttribute('class') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const markedAsEmoji = classes.includes('emoji') || classes.includes('wp-smiley');
    let wordpressEmojiSource = false;
    try { wordpressEmojiSource = /^https?:\/\/s\.w\.org\/images\/core\/emoji\//i.test(new URL(candidate, document.baseURI).href); } catch {}
    return markedAsEmoji || wordpressEmojiSource ? alt : '';
  };
  const flush = () => { const text = cleanText(buffer); if (text) blocks.push({ id: `text-${blocks.length}`, kind: 'text', tag: currentTag, text }); buffer = ''; };
  const walk = (node, inheritedTag = 'p') => {
    if (node.nodeType === Node.TEXT_NODE) { if (currentTag !== inheritedTag && cleanText(buffer)) flush(); currentTag = inheritedTag; buffer += node.nodeValue || ''; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) { for (const child of node.childNodes || []) walk(child, inheritedTag); return; }
    if (ignored.has(node.tagName)) return;
    if (node.tagName === 'BR') { buffer += '\n'; return; }
    if (node.tagName === 'IMG') {
      const candidate = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original') || '';
      const emojiText = semanticEmojiText(node, candidate);
      if (emojiText) {
        try { imageMeasurements.get(new URL(candidate, document.baseURI).href)?.shift(); } catch {}
        buffer += emojiText;
        return;
      }
      flush();
      if (!candidate) return;
      let sourceUrl; try { sourceUrl = new URL(candidate, document.baseURI).href; } catch { return; }
      const measured = imageMeasurements.get(sourceUrl)?.shift();
      blocks.push({ id: `image-${blocks.length}`, kind: 'image', sourceUrl, alt: String(node.getAttribute('alt') || '').slice(0, 200), width: dimension(measured?.width || node.getAttribute('width') || node.naturalWidth, 900), height: dimension(measured?.height || node.getAttribute('height') || node.naturalHeight, 600) });
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
