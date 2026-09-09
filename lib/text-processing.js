const placeholderPattern = /\{\{[^{}\n]{1,120}\}\}|\{[^{}\n]{1,120}\}|%(?:\d+\$)?[sdif]|<\/?[A-Za-z][^>\n]{0,200}>|\[[A-Z][A-Z0-9_-]*:\d+\]|https?:\/\/[^\s<>]+/g;

export function splitTextSmart(text, maximum = 5000) {
  const value = String(text || '').replace(/\r\n/g, '\n');
  if (value.length <= maximum) return [value];
  const parts = []; let rest = value;
  while (rest.length > maximum) {
    const window = rest.slice(0, maximum + 1);
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')];
    let cut = Math.max(...candidates);
    if (cut < maximum * 0.45) cut = maximum;
    else cut += window.slice(cut, cut + 2).startsWith('\n\n') ? 2 : 1;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}

export function segmentDocumentBlocks(blocks, maximum = 5000) {
  const segments = [];
  blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'text' || !block.text.trim()) return;
    splitTextSmart(block.text, maximum).forEach((text, partIndex) => segments.push({ id: `b${blockIndex}p${partIndex}`, blockIndex, partIndex, sourceText: text, translatedText: '', status: 'pending', retries: 0, issues: [] }));
  });
  return segments;
}

export function mergeTranslatedBlocks(sourceBlocks, segments) {
  const grouped = new Map();
  for (const segment of segments) {
    if (!grouped.has(segment.blockIndex)) grouped.set(segment.blockIndex, []);
    grouped.get(segment.blockIndex).push(segment);
  }
  return sourceBlocks.map((block, index) => block.kind === 'text' && grouped.has(index)
    ? { ...block, text: grouped.get(index).sort((a, b) => a.partIndex - b.partIndex).map((item) => item.translatedText || '').join('') }
    : block);
}

export function protectPlaceholders(text) {
  const values = [];
  const protectedText = String(text).replace(placeholderPattern, (match) => {
    const token = `⟦PH_${values.length}_${Math.random().toString(36).slice(2, 8)}⟧`;
    values.push({ token, value: match }); return token;
  });
  return { text: protectedText, values };
}

export function restorePlaceholders(text, values) {
  let restored = String(text || ''); const issues = [];
  for (const item of values) {
    if (!restored.includes(item.token)) issues.push({ type: 'missing-placeholder', expected: item.value });
    restored = restored.split(item.token).join(item.value);
  }
  return { text: restored, issues };
}

export function estimateTextStats(blocks, maximum = 5000) {
  const text = blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n');
  return { characters: text.length, words: (text.match(/[\p{L}\p{N}]+/gu) || []).length, segments: segmentDocumentBlocks(blocks, maximum).length };
}
