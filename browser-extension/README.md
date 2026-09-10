# 网页选区 ZIP 扩展

该目录是 Chrome/Edge Manifest V3 扩展。它把当前网页的选中文字和 `<img>` 图片导出为 `WEB_CONTENT_ZIP_FORMAT.md` 定义的标准包。

## 开发安装

1. 打开 Chrome `chrome://extensions/` 或 Edge `edge://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展”，指向本目录。
4. 在普通 HTTP/HTTPS 网页中选择文字和图片。
5. 点击扩展按钮，再点击“保存为网页 ZIP”。

也可以在项目根目录运行 `pnpm extension:pack`，将生成的分发 ZIP 解压后按上述方式加载。

扩展仅在用户点击时读取当前标签页。为了下载跨域图片，需要 HTTP/HTTPS 主机权限；下载明确不携带 Cookie 或 Authorization。图片以实际内容识别，PNG、JPEG、GIF、WebP 的响应字节直接写入无压缩 ZIP 条目，不经过 Canvas 或重新编码。安全 SVG 也保留原始字节，同时生成 PNG 安全预览；`document.json` 记录图片在原网页选区中的实际 CSS 像素宽高。相同 URL 只下载一次。

WordPress Emoji（`emoji`、`wp-smiley` 或 `s.w.org/images/core/emoji/`）属于段落内的语义字符。扩展会使用其短 `alt` 内容还原为行内文字，例如 `‼`、`♥`，避免导入后变成居中的独立图片块。普通插图和其他 SVG 不执行此转换，仍按原格式保存。

容量上限为 5,000 个内容块、2,000 个唯一图片资源和 200 MB ZIP；文字总量仍限制为 200,000 字符，单图限制为 20 MB。导入器使用相同上限，因此扩展生成的合规包可以直接导入。

含脚本、事件属性、外部引用、`foreignObject` 等主动内容的 SVG 会被拒绝。CSS 背景图、视频、`blob:` 图片和受站点反爬/鉴权限制而无法重新请求的图片当前不支持。任一图片或 SVG 预览生成失败时不会生成缺图的半成品 ZIP。
