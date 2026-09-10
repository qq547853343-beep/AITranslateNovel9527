export async function readDeepSeekEventStream(response, { onContent } = {}) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!response.body?.getReader || !contentType.includes('text/event-stream')) return response.json();
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let content = ''; let finishReason = null; let usage = null; let id = null; let model = null;
  const consume = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { throw Object.assign(new Error('DeepSeek 流式响应包含无效 SSE 数据。'), { code: 'AI_STREAM_INVALID', retryable: true }); }
    id ||= chunk.id || null; model ||= chunk.model || null;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) { content += delta; onContent?.(content, delta); }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary = pending.match(/\r?\n\r?\n/);
    while (boundary) {
      consume(pending.slice(0, boundary.index));
      pending = pending.slice(boundary.index + boundary[0].length);
      boundary = pending.match(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  if (pending.trim()) consume(pending);
  return { id, model, choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }], usage };
}

export function extractPartialTranslation(content) {
  const match = /"translation"\s*:\s*"/.exec(String(content || ''));
  if (!match) return { found: false, complete: false, value: '' };
  const source = String(content); let value = ''; let index = match.index + match[0].length;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') return { found: true, complete: true, value };
    if (character !== '\\') { value += character; index += 1; continue; }
    if (index + 1 >= source.length) break;
    const escaped = source[index + 1];
    if (escaped === 'u') {
      const hex = source.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16)); index += 6; continue;
    }
    const mapped = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escaped];
    if (mapped == null) break;
    value += mapped; index += 2;
  }
  return { found: true, complete: false, value };
}
