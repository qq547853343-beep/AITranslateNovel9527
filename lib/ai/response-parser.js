export function parseStructuredAIResponse(data) {
  let content = readContent(data);
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(content); }
  catch { throw Object.assign(new Error('AI 返回的结构化 JSON 格式无效，请重试。'), { code: 'AI_RESPONSE_INVALID', retryable: true, contentLength: content.length }); }
}

export function parseTextAIResponse(data) { return readContent(data); }

function readContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw Object.assign(new Error('AI 返回内容为空或格式无效。'), { code: 'AI_RESPONSE_EMPTY' });
  return content;
}
