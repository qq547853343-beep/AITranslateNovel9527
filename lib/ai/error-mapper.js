export async function mapAIResponseError(response) {
  let data = {};
  try { data = await response.json(); } catch {}
  const error = new Error(data?.error?.message || `DeepSeek API 请求失败（HTTP ${response.status}）。`);
  error.code = 'AI_PROVIDER_REQUEST_FAILED';
  error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
  error.provider = 'deepseek';
  return { error, data };
}
