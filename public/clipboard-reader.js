(function exposeClipboardReader(global) {
  function clipboardError(message, code, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  async function readClipboardContent(clipboard = global.navigator?.clipboard) {
    if (!clipboard || typeof clipboard.read !== 'function') {
      throw clipboardError('当前浏览器不支持主动读取剪贴板，请在原文框中使用 Ctrl+V。', 'CLIPBOARD_READ_UNSUPPORTED');
    }

    let items;
    try {
      items = await clipboard.read();
    } catch (cause) {
      throw clipboardError('无法读取剪贴板。请允许剪贴板权限后重试，或在原文框中使用 Ctrl+V。', 'CLIPBOARD_READ_DENIED', cause);
    }

    let html = '';
    let text = '';
    const images = [];
    for (const item of items || []) {
      const types = Array.isArray(item.types) ? item.types : [...(item.types || [])];
      if (!html && types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (!text && types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      for (const type of types.filter((value) => value.startsWith('image/'))) {
        images.push({ type, blob: await item.getType(type) });
      }
    }

    if (!html && !text && !images.length) {
      throw clipboardError('剪贴板中没有可导入的网页 HTML、文字或图片。', 'CLIPBOARD_CONTENT_EMPTY');
    }
    return { html, text, images };
  }

  global.ClipboardContentReader = Object.freeze({ readClipboardContent });
})(globalThis);
