# AITranslateNovel9527

AITranslateNovel9527 是一个 Windows 本地 AI 图文翻译工具。当前版本为 **ver0.3**，由 Electron 启动器管理本地 Express 服务；翻译、规则、图片和导出数据均保留在本机。

## 这版新增了什么

- **标准网页 ZIP 导入**：读取 `manifest.json`、`document.json`、`content.html` 和 `assets/`，以 `document.json` 作为唯一内容来源，失败自动清理临时资源。
- **网页选区导出扩展**：Chrome/Edge 可将选中文字和图片导出为标准 ZIP，保持顺序、尺寸和 PNG/JPEG/GIF/WebP 原格式；安全 SVG 保留原件并生成 PNG 预览。
- **翻译可靠性**：任务支持租约、心跳、revision 校验、恢复、取消、重试和单段重译，旧 worker 不能覆盖新状态。
- **流式翻译**：DeepSeek SSE 实时输出当前分段，译文区支持调整高度、暂停自动跟随、回到当前、失败段定位。
- **用量面板**：后端查询 DeepSeek `/user/balance`，记录输入、输出、总 Token，并显示任务及当前会话估算用量。
- **输出稳定性**：使用 `max_tokens`、译文形态校验、语气字符压缩和一次自动重试，减少 JSON 截断与异常扩写。
- **界面可读性**：放大正文、状态和按钮字号，增加悬停提示、键盘焦点和移动端布局优化。

ver0.3 保留 ver0.2 的 Electron 服务启动器、托盘、单实例、端口切换、日志轮转、开机启动和安全 IPC；也保留 ver0.1 的规则集、文本导入、图片处理、长文本任务及 TXT/DOCX/EPUB 导出。

## 快速开始

环境要求：Windows、Node.js 24+、pnpm。

```powershell
pnpm install
pnpm start
```

浏览器访问 `http://127.0.0.1:6501`。SQLite 会自动打开，不需要单独启动数据库。

使用 Electron 启动器：

```powershell
pnpm launcher
```

启动器管理地址固定为 `127.0.0.1:7000`，翻译服务默认端口为 `127.0.0.1:6501`。关闭窗口只隐藏到托盘；从托盘退出才会停止受控服务。

## 常用流程

1. 在连接设置中保存 DeepSeek API Key。
2. 新建或选择规则集；自然语言规则必须经过候选预览和用户确认才会保存。
3. 输入文字、粘贴网页 HTML、拖入图片，或导入标准网页 ZIP。
4. 选择目标语言并开始翻译；可实时查看当前段、整体进度、Token 和余额。
5. 复制译文，或导出 TXT、DOCX、EPUB 和配套资料。

## 网页 ZIP 扩展

开发安装：打开 Chrome/Edge 扩展管理页，启用开发者模式，选择“加载已解压的扩展”，目录为 `browser-extension/`。

打包分发：

```powershell
pnpm extension:pack
```

产物为 `dist/AITranslateNovel9527-browser-extension-0.3.0.zip`。格式和安全边界见 [WEB_CONTENT_ZIP_FORMAT.md](WEB_CONTENT_ZIP_FORMAT.md) 与 [browser-extension/README.md](browser-extension/README.md)。

当前 ZIP 限制：

| 项目 | 上限 |
|---|---:|
| 内容块 | 5,000 |
| 唯一图片 | 2,000 |
| 单张图片（含 SVG PNG 预览） | 20 MB |
| ZIP 本体 | 200 MB |
| 解压后总大小 | 500 MB |
| 文字总量 | 200,000 字符 |

直接上传图片接口仍单独限制为 8 MB；这与网页 ZIP 导入上限不同。

## 架构边界

```text
Electron / Vue / ZIP 文件
          ↓
HTTP API 或 IPC 适配层
          ↓
Application 用例层
          ↓
Domain 文档、规则、任务状态
          ↓
Infrastructure：SQLite、DeepSeek、文件、ZIP、导出
```

`server.js` 负责组合依赖和启动服务；API 只处理 HTTP；Application 负责流程编排；Domain 不依赖 Express、SQLite 或浏览器 DOM；Electron 主进程负责服务生命周期和系统能力。

## 本地数据与安全

- 数据库：`data/app.db`；图片：`data/assets/`；安全 SVG 原件：`data/original-assets/`；日志：`data/logs/`。
- API Key 使用 `data/.master-key` 进行 AES-256-GCM 加密，前端永远不会取得密钥。
- 服务和启动器只监听回环地址；Electron 使用 context isolation、沙箱和 preload 白名单。
- ZIP 导入会拒绝路径穿越、异常压缩比、无效资源和主动内容 SVG；失败不会留下半成品文件。
- 自动更新目前只有状态接口，不下载、安装、替换或回滚程序。

## 构建、测试与文档

```powershell
pnpm test
pnpm pack:win
pnpm dist:win
```

安装包包含 Electron/Node 运行时，用户不需要另装 Node.js。当前未配置代码签名和正式图标。

- [PROJECT_DOCUMENT.md](PROJECT_DOCUMENT.md)：完整设计与实施基线。
- [ELECTRON_LAUNCHER_REQUIREMENTS.md](ELECTRON_LAUNCHER_REQUIREMENTS.md)：启动器需求和安全边界。
- [WEB_CONTENT_ZIP_FORMAT.md](WEB_CONTENT_ZIP_FORMAT.md)：网页 ZIP 合同、限制和接口。

当前自动化测试基线为 **94 项**。大型文档 Worker Pool、云端部署和浏览器扩展后台同步仍不属于本版本范围。
