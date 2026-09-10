# AITranslateNovel9527

本地 Windows AI 图文翻译服务，当前版本 `ver0.2`。使用 DeepSeek Chat API，支持独立规则集、自然语言生成候选规则、长文本分段、上下文连续翻译、中断恢复、术语校验、标准化网页 ZIP 导入、网页选区 ZIP 导出扩展、TXT/DOCX/EPUB 导出，以及负责本地服务生命周期的 Electron 桌面启动器。

## 版本说明

### ver0.2

- 新增 Electron Windows 桌面启动器，不重写 ver0.1 翻译业务。
- 管理端口固定为 `127.0.0.1:7000`，翻译服务默认端口为 `127.0.0.1:6501`。
- 新增服务启动、停止、重启、健康检查、端口检测、安全端口切换及失败回滚。
- 新增托盘、Windows 登录后启动、启动时隐藏、自动启动服务和可选异常自动重启。
- 新增 Electron 单实例保护和带 PID 校验的用户级全局锁，防止重复启动终端或服务。
- 新增 Launcher/Service 日志采集、轮转、最近 200 行查看和敏感字段脱敏。
- 新增安全 preload/IPC 白名单；渲染进程不直接访问 Node.js、文件、进程或任意命令。
- 新增 electron-builder Windows x64 解包版和 NSIS 安装包配置。
- 自动更新仅预留接口和状态，不执行下载、安装、替换或回滚。
- 原文编辑区可主动读取剪贴板网页 `text/html`；其中的远程 PNG/JPEG/GIF/WebP 图片经地址、重定向、大小和类型校验后转存为本地资源，不携带 Cookie 或授权信息。
- 新增标准化网页 ZIP 导入：以 `document.json` 为唯一内容来源，安全校验 `manifest.json`、文件路径、压缩比、展开大小和图片引用，失败时清理全部临时资源。
- 新增 Chrome/Edge 网页选区导出扩展：保持文字与图片顺序及实际显示尺寸，按真实格式原样保存 PNG/JPEG/GIF/WebP；安全 SVG 保留原件并附带 PNG 预览，生成的标准 ZIP 可直接导入本服务。
- SQLite 迁移拆分为不可变、带名称和 SHA-256 校验和的递增迁移；翻译任务增加 revision、worker 租约、心跳和迟到写回保护。
- DeepSeek 调用拆分为 Provider、提示词构造、响应解析和错误映射；旧 `/api/translate` 通过兼容用例进入 Provider，不再由路由直接请求 AI。
- 长文本翻译使用 DeepSeek SSE 流式响应，当前分段实时显示；译文区可拖动调整高度、限制最大高度、暂停自动跟随，并支持回到顶部、回到当前、失败段定位和单段重试。
- 新增 DeepSeek 余额与 Token 用量面板：余额由本地后端查询，任务用量写入现有任务元数据，会话用量保存在服务进程内存；余额查询失败不会阻止翻译。
- 提升主界面、规则栏、状态区和弹窗的基础字号与点击区域；说明文字支持悬停高亮，并补充键盘焦点、滚动条及移动端顶部布局优化。

### ver0.1

- 完成独立规则集、自然语言候选规则、长文本分段翻译、中断恢复、术语校验及配套资料导出。
- 将设置、规则和临时翻译任务迁移至 SQLite，API Key 使用独立主密钥进行 AES-256-GCM 加密。

## 开发环境启动

需要 Node.js 24 或更高版本与 pnpm。

```powershell
pnpm install
pnpm start
```

浏览器打开 `http://127.0.0.1:6501`。SQLite 会随服务自动打开，不需要单独启动数据库。

## Windows 桌面启动器

开发环境可运行：

```powershell
pnpm launcher
```

Electron 启动器的管理端口固定为 `127.0.0.1:7000`，翻译服务默认使用 `127.0.0.1:6501`。启动器可在服务停止时独立查看状态、端口和日志，并负责启动、停止、重启、端口切换、托盘驻留及当前用户登录后启动。正常重复启动会激活已有窗口；额外的全局启动锁会阻止不同配置目录产生第二个启动终端，并能在记录 PID 已失效时恢复。

关闭窗口只会隐藏到托盘；从托盘选择“退出”才会停止启动器记录的服务并退出。启动器不会按进程名或未知端口结束其他程序。

生成 Windows x64 解包目录或 NSIS 安装包：

```powershell
pnpm pack:win
pnpm dist:win
```

构建产物位于 `dist/`。安装包已经包含 Electron/Node 运行时，最终用户不需要另行安装 Node.js。运行数据、主密钥、用户图片和日志不会写入安装包。

当前安装包未配置代码签名和产品图标，Windows 可能显示未知发布者提示；这不影响本地功能。

## 网页选区导出扩展

开发安装：在 Chrome 的 `chrome://extensions/` 或 Edge 的 `edge://extensions/` 开启开发者模式，选择“加载已解压的扩展”，并指向 `browser-extension/`。在普通网页中选中文字和图片后，点击扩展按钮即可保存标准 ZIP。

生成便于分发的扩展压缩包：

```powershell
pnpm extension:pack
```

产物位于 `dist/AITranslateNovel9527-browser-extension-0.2.0.zip`。解压后可按上述方式加载。详细权限、安全边界和限制见 [browser-extension/README.md](browser-extension/README.md)。

## 基本流程

1. 在“连接设置”中保存 DeepSeek API Key。
2. 新建或选择一个或多个独立规则集。
3. 在右侧输入自然语言规则并点击“解析规则”。AI 只生成候选操作；检查预览并点击“确认保存”后才写入规则集。
4. 在左侧输入原文、读取剪贴板网页、导入普通文本文件或标准化网页 ZIP，然后开始翻译。
5. 翻译时可实时查看当前分段、Token 用量和估算费用；完成后复制译文，导出 TXT、Word、EPUB，或把译文与术语表、原文、说明、分析和规则输出到同一文件夹。

## 本地数据与密钥

- 设置、规则集、版本记录和临时翻译任务保存在 `data/app.db`。
- API Key 使用 `data/.master-key` 进行 AES-256-GCM 加密，SQLite 中只保存密文。
- `data/` 已被 Git 忽略。不要同时泄露 `app.db` 与 `.master-key`；同时获得二者的人可以解密 API Key。
- 迁移或备份本地数据时，请先停止服务，再整体复制 `data/`。若只复制数据库而不复制主密钥，需要重新填写 API Key。
- 临时翻译任务默认保留 7 天，过期后启动服务时自动清理。
- `schema_migrations` 记录迁移版本、名称和校验和；已应用迁移内容被修改时服务会拒绝进入不完整状态。

未来云端部署可将 SQLite Repository 替换为 PostgreSQL，并将本地 `SecretStore` 替换为 KMS/Secret Manager 实现，不需要改写核心翻译流程。

## 测试

```powershell
pnpm test
```

当前自动化基线为 94 项测试。标准网页包格式见 [WEB_CONTENT_ZIP_FORMAT.md](WEB_CONTENT_ZIP_FORMAT.md)，详细设计见 [PROJECT_DOCUMENT.md](PROJECT_DOCUMENT.md)，Electron 启动器需求与实现状态见 [ELECTRON_LAUNCHER_REQUIREMENTS.md](ELECTRON_LAUNCHER_REQUIREMENTS.md)。
