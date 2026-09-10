const placeholderPattern = /\{\{[^{}\n]{1,120}\}\}|\{[^{}\n]{1,120}\}|%(?:\d+\$)?[sdif]|<\/?[A-Za-z][^>\n]{0,200}>|\[[A-Z][A-Z0-9_-]*:\d+\]|https?:\/\/[^\s<>]+/g;
const expressiveCharacterPattern = /^[\p{L}\p{M}!?！？…〜～~ー]$/u;

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
    splitTextSmart(block.text, maximum).forEach((text, partIndex) => segments.push({ id: `b${blockIndex}p${partIndex}`, blockIndex, partIndex, sourceText: text, translatedText: '', status: 'pending', retries: 0, attempts: 0, requestId: null, startedAt: null, finishedAt: null, lastError: '', issues: [] }));
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

export function compressExpressiveRuns(text, { minimumRun = 6, retainedCount = 3, maximumHints = 100 } = {}) {
  const characters = Array.from(String(text || ''));
  const output = []; const hints = [];
  let compressedRunCount = 0;
  for (let index = 0; index < characters.length;) {
    const character = characters[index];
    let end = index + 1;
    while (end < characters.length && characters[end] === character) end += 1;
    const count = end - index;
    if (count >= minimumRun && expressiveCharacterPattern.test(character)) {
      const kept = Math.min(retainedCount, count);
      output.push(character.repeat(kept)); compressedRunCount += 1;
      if (hints.length < maximumHints) hints.push({ character, originalCount: count, retainedCount: kept, meaning: '拖长、强调或强烈语气；自然表达强度，不按原数量复写' });
    } else output.push(character.repeat(count));
    index = end;
  }
  return { text: output.join(''), hints, compressedRunCount };
}

export function findTranslationShapeIssue(source, translation, { maximumRun = 12 } = {}) {
  const sourceCharacters = Array.from(String(source || '')).length;
  const translatedCharacters = Array.from(String(translation || '')).length;
  const maximumTranslationCharacters = Math.max(300, Math.ceil(sourceCharacters * 3) + 200);
  if (translatedCharacters > maximumTranslationCharacters) return { type: 'translation-too-long', translatedCharacters, maximumTranslationCharacters };
  const characters = Array.from(String(translation || ''));
  for (let index = 0; index < characters.length;) {
    let end = index + 1;
    while (end < characters.length && characters[end] === characters[index]) end += 1;
    const count = end - index;
    if (count > maximumRun && expressiveCharacterPattern.test(characters[index])) return { type: 'excessive-character-run', character: characters[index], count, maximumRun };
    index = end;
  }
  return null;
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
