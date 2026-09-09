import { extractSelectedContent } from './lib/selection-extractor.js';
import { buildWebContentPackage } from './lib/package-builder.js';

const button = document.querySelector('#save');
const status = document.querySelector('#status');

button.addEventListener('click', async () => {
  button.disabled = true; status.className = ''; status.textContent = '正在读取当前网页选区……';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) throw new Error('请在普通 HTTP/HTTPS 网页中使用此扩展。');
    const [{ result: selection }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractSelectedContent });
    const built = await buildWebContentPackage(selection, { extensionVersion: chrome.runtime.getManifest().version, onProgress: ({ current, total }) => { status.textContent = `正在下载原格式图片 ${current} / ${total}……`; } });
    status.textContent = '正在生成并保存 ZIP……';
    const url = URL.createObjectURL(new Blob([built.zip], { type: 'application/zip' }));
    try { await chrome.downloads.download({ url, filename: built.filename, saveAs: true }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
    status.className = 'ok'; status.textContent = `已生成 ${built.document.blocks.length} 个内容块、${built.assets.length} 张原格式图片。`;
  } catch (error) {
    status.className = 'error'; status.textContent = error?.message || '导出失败。';
  } finally { button.disabled = false; }
});
