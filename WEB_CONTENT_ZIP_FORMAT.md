# 标准化网页 ZIP 格式

本文档定义 AITranslateNovel9527 ver0.2 可直接导入的网页内容包。导入格式本身不依赖浏览器扩展，也不属于大型文档翻译方案；仓库同时提供一个按此格式生成 ZIP 的 Chrome/Edge 扩展。

## 文件结构

```text
web-content.zip
├─ manifest.json
├─ document.json
├─ content.html
└─ assets/
   ├─ illustration.png
   ├─ photo.jpg
   ├─ animation.gif
   └─ cover.webp
```

只允许根目录中的三个固定文件，以及 `assets/` 下不含子目录的 PNG/JPG/JPEG/GIF/WebP。文件名只能使用字母、数字、点、下划线和连字符。旧版 `index.html + images/` 当前不兼容。

## manifest.json

```json
{
  "format": "AITranslateNovel9527.web-content",
  "version": "1.0",
  "createdAt": "2026-09-09T00:00:00.000Z",
  "generator": {
    "name": "example-generator",
    "version": "1.0.0"
  }
}
```

字段必须完整，不允许额外字段。`createdAt` 必须是有效日期时间。

## document.json

```json
{
  "schemaVersion": 1,
  "title": "第一章",
  "language": "ja",
  "sourceUrl": "https://example.com/chapter/1",
  "blocks": [
    { "id": "heading-1", "kind": "text", "tag": "h1", "text": "第一章" },
    { "id": "image-1", "kind": "image", "assetPath": "assets/illustration.png", "alt": "插图", "width": 800, "height": 600 },
    { "id": "paragraph-1", "kind": "text", "tag": "p", "text": "正文内容。" }
  ],
  "metadata": {}
}
```

`document.json` 是唯一规范内容来源。内容块 ID 必须唯一，允许的文本标签为 `p`、`h1`、`h2`、`h3`、`blockquote` 和 `li`。图片引用必须在 ZIP 中存在，文件扩展名必须与 PNG/JPEG/GIF/WebP 魔数一致。

`content.html` 仅作为生成端的预览或兼容材料。当前导入器不会渲染或信任它，而是从校验后的 Document/ContentBlock 重新生成本地预览，因此其中的脚本、事件属性和远程资源不能影响导入结果。SVG 当前全部拒绝。GIF 与 WebP 资源会原样保存；由于 DOCX 库不支持 WebP，包含 WebP 的文档应导出 EPUB，或先转换图片再导出 Word。

## 浏览器选区导出扩展

`browser-extension/` 是 Manifest V3 Chrome/Edge 扩展。它读取用户当前选区，按文字与 `<img>` 的出现顺序生成内容块，重新下载每个唯一图片地址，并依据实际文件魔数决定扩展名。PNG、JPEG、GIF 与 WebP 的响应字节会直接写入 ZIP，不经过 Canvas 或重新编码，所以动画和原始编码都得以保留。

扩展不会携带 Cookie 或 Authorization。无法匿名重新请求的防盗链/鉴权图片、`blob:` 图片、CSS 背景图、视频及 SVG 当前会给出错误，不会生成缺图的半成品包。安装和打包方法见 `browser-extension/README.md`。

## 安全限制

- ZIP 本体最大 20 MB。
- 文件最多 500 个。
- 解压后总大小最大 50 MB。
- 单个图片最大 8 MB。
- 单个 JSON 最大 1 MB，`content.html` 最大 2 MB。
- 单文件压缩比最大 100:1。
- 拒绝绝对路径、盘符、反斜杠、空路径段、`.`、`..` 和路径被 ZIP 库清理过的条目。
- 不提取到 ZIP 自带路径；图片转换为随机本地 asset ID。
- 不保存未被 `document.json` 引用的资源。
- 临时目录和本次已提交资源在失败时一并清理。

## HTTP 接口

```text
POST /api/import/web-package
Content-Type: multipart/form-data
字段名: package
```

成功状态为 `201`。返回的 `document.blocks` 可直接用于现有预览和翻译接口，图片已转换成本地 `assetId`。错误响应包含稳定的 `code`、可理解的 `error`，以及可选 `details`。

JSON Schema 位于 `schemas/`；固定合同样例位于 `test/fixtures/contracts/`。ZIP 导入目前不持久化 Document 或导入记录，因此不创建新的 SQLite 文档表。
