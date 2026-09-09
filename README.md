# AITranslateNovel9527

本地小说图文翻译服务，当前版本 `ver0.1`。使用 DeepSeek Chat API，支持独立规则集、自然语言生成候选规则、长文本分段、上下文连续翻译、中断恢复、术语校验以及 TXT、DOCX、EPUB 和配套资料导出。

## 启动

需要 Node.js 24 或更高版本与 pnpm。

```powershell
pnpm install
pnpm start
```

浏览器打开 `http://127.0.0.1:6501`。SQLite 会随服务自动打开，不需要单独启动数据库。

## 基本流程

1. 在“连接设置”中保存 DeepSeek API Key。
2. 新建或选择一个或多个独立规则集。
3. 在右侧输入自然语言规则并点击“解析规则”。AI 只生成候选操作；检查预览并点击“确认保存”后才写入规则集。
4. 在左侧输入或导入原文，然后开始翻译。
5. 完成后复制译文，导出 TXT、Word、EPUB，或把译文与术语表、原文、说明、分析和规则输出到同一文件夹。

## 本地数据与密钥

- 设置、规则集、版本记录和临时翻译任务保存在 `data/app.db`。
- API Key 使用 `data/.master-key` 进行 AES-256-GCM 加密，SQLite 中只保存密文。
- `data/` 已被 Git 忽略。不要同时泄露 `app.db` 与 `.master-key`；同时获得二者的人可以解密 API Key。
- 迁移或备份本地数据时，请先停止服务，再整体复制 `data/`。若只复制数据库而不复制主密钥，需要重新填写 API Key。
- 临时翻译任务默认保留 7 天，过期后启动服务时自动清理。

未来云端部署可将 SQLite Repository 替换为 PostgreSQL，并将本地 `SecretStore` 替换为 KMS/Secret Manager 实现，不需要改写核心翻译流程。

## 测试

```powershell
pnpm test
```

详细需求和设计见 [PROJECT_DOCUMENT.md](PROJECT_DOCUMENT.md)。
