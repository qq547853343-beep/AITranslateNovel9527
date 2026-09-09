# 网页选区 ZIP 扩展

该目录是 Chrome/Edge Manifest V3 扩展。它把当前网页的选中文字和 `<img>` 图片导出为 `WEB_CONTENT_ZIP_FORMAT.md` 定义的标准包。

## 开发安装

1. 打开 Chrome `chrome://extensions/` 或 Edge `edge://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展”，指向本目录。
4. 在普通 HTTP/HTTPS 网页中选择文字和图片。
5. 点击扩展按钮，再点击“保存为网页 ZIP”。

也可以在项目根目录运行 `pnpm extension:pack`，将生成的分发 ZIP 解压后按上述方式加载。

扩展仅在用户点击时读取当前标签页。为了下载跨域图片，需要 HTTP/HTTPS 主机权限；下载明确不携带 Cookie 或 Authorization。图片以实际魔数识别，PNG、JPEG、GIF、WebP 的响应字节直接写入无压缩 ZIP 条目，不经过 Canvas 或重新编码。相同 URL 只下载一次。

SVG、CSS 背景图、视频、`blob:` 图片和受站点反爬/鉴权限制而无法重新请求的图片当前不支持。任一图片失败时不会生成缺图的半成品 ZIP。
