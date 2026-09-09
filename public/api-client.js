(function exposeApiClient(global) {
  async function request(url, options = {}) {
    const response = await global.fetch(url, options);
    const type = response.headers.get('content-type') || '';
    const body = type.includes('json') ? await response.json() : await response.blob();
    if (!response.ok) {
      const error = new Error(body?.error || '请求失败');
      error.code = body?.code;
      error.details = body?.details;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function json(method, body) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

  async function uploadWebPackage(file) {
    const form = new FormData();
    form.append('package', file);
    return request('/api/import/web-package', { method: 'POST', body: form });
  }

  global.TranslationApi = Object.freeze({ request, json, uploadWebPackage });
})(window);
