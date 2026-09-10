# AITranslateNovel9527 设计与实施总结

## 文档信息

- 项目版本：`ver0.2`
- 文档性质：功能设计、实施结果与维护基线
- 当前状态：ver0.1 翻译工作流、ver0.2 Electron Windows 启动器、标准化网页 ZIP 导入、网页选区导出扩展、渐进式模块化、流式译文与 DeepSeek 用量面板均已实现
- 运行方式：Windows Electron 桌面启动器；同时保留 Node.js 开发入口
- 启动器管理地址：`http://127.0.0.1:7000`
- 翻译服务默认地址：`http://127.0.0.1:6501`
- AI 服务：DeepSeek Chat API

本文档第 1 至 24 节记录 ver0.1 翻译业务设计，第 25 节记录 ver0.2 Electron 启动器，第 26 至 28 节记录标准化网页 ZIP 导入、模块边界和任务并发增强，第 29 节记录网页选区导出扩展，第 30 节记录流式译文与 DeepSeek 用量。ver0.2 保持增量演进，不把大型文档 Worker Pool 当作已实现功能。

## 1. 项目目标

在完整保留现有图文翻译、API Key 本地加密、图片本地存储、文本导入以及 TXT、DOCX、EPUB 导出功能的基础上，增加独立规则集、自然语言规则解析、长文本可靠翻译、上下文连续性、中断恢复、术语校验、进度展示和配套资料导出能力。

项目继续保持轻量本地工具定位。页面最终主要展示译文，不引入长期的小说项目管理系统。为了支持中断恢复，仅保存有过期时间的本地临时翻译任务。

## 2. 现有功能保留范围

以下现有能力必须保持可用：

- DeepSeek API Key 的本地配置、加密保存与删除。
- 目标语言选择和文档名称设置。
- TXT、Markdown、CSV、JSON、HTML 等文字文件导入。
- 富文本原文输入。
- 从剪贴板粘贴图文内容。
- 拖入 PNG、JPEG、WebP 图片。
- 图片仅保存在本地，不发送给 AI。
- 原文和译文中的图片顺序保持一致。
- 内容块的标题、段落、列表、引用和换行结构。
- TXT、DOCX、EPUB 导出。
- 本地端口检测和现有服务管理页面。
- 服务仅监听本机地址。

未选择规则集时，翻译行为应与当前版本一致。

## 3. 页面布局

主页面调整为左右两栏：

```text
┌─────────────────────────────────┬─────────────────────┐
│ 左侧：图文翻译工作区             │ 右侧上方：规则描述区  │
│                                 ├─────────────────────┤
│ 原文、翻译控制、进度和译文结果    │ 右侧下方：规则集管理  │
│ 复制、TXT/DOCX/EPUB及资料导出    │                     │
└─────────────────────────────────┴─────────────────────┘
```

- 左侧约占页面宽度的 65%。
- 右侧约占页面宽度的 35%。
- 现有连接设置移入顶部按钮打开的抽屉或弹窗，功能保持不变。
- 移动端改为上下布局，翻译区在上，规则区在下。

## 4. 独立规则集

规则集与翻译内容相互独立。用户每次翻译时可以选择一个或多个规则集，同一个规则集可以重复用于不同小说或不同批次的翻译。

规则集支持：

- 新建
- 重命名
- 编辑
- 复制
- 启用和停用
- 软删除和恢复
- 搜索和分类筛选
- 调整优先级
- 导入和导出
- 历史版本恢复

规则集使用不可变 ID。重命名只改变显示名称，不改变关联关系。

建议的数据结构：

```json
{
  "id": "ruleset_a83f92",
  "name": "小说A专用术语",
  "description": "小说A系列统一规则",
  "version": 1,
  "priority": 100,
  "createdAt": "2026-09-09T12:00:00+08:00",
  "updatedAt": "2026-09-09T12:00:00+08:00",
  "deletedAt": null,
  "rules": []
}
```

## 5. 规则类型

支持以下规则类型：

### 5.1 术语规则

规定原文术语必须使用的目标译法。

### 5.2 人物规则

保存人物姓名、别名、性别、称谓、代词和人物关系。

### 5.3 地名、组织和技能规则

统一地点、国家、组织、阵营、职业、技能和物品译法。

### 5.4 风格规则

规定整体语言风格，例如轻小说风格、书面旁白或口语对白。

### 5.5 称谓规则

规定敬称是否保留以及人物之间的固定称呼。

### 5.6 禁止译法

记录不允许出现的错误译法或旧译法。

### 5.7 格式保护规则

保护变量、标签、网址、代码和特殊标记。

### 5.8 背景规则

提供人物关系和世界观信息，只用于帮助 AI 理解语境。

### 5.9 临时规则

只对当前翻译任务生效，除非用户主动保存到正式规则集。

单条规则建议结构：

```json
{
  "id": "rule_001",
  "type": "term",
  "source": "聖女",
  "target": "圣女",
  "aliases": ["聖女様"],
  "forbidden": ["神圣少女"],
  "category": "称号",
  "sendMode": "matched",
  "enabled": true,
  "priority": 100,
  "note": ""
}
```

## 6. 自然语言生成和修改规则

右侧上方提供规则描述输入框。由于输入框属于规则区域，本地服务直接将其识别为规则解析任务，不让 AI 猜测它是正文还是规则。

处理流程：

```text
输入自然语言规则
→ 本地标记 parse_rule_instruction
→ 携带当前规则集和相关已有规则发送给 AI
→ AI 返回结构化候选操作
→ 本地校验并检测冲突
→ 页面显示预览
→ 用户确认后保存
```

AI 可以返回新增、修改、停用和删除规则等候选操作，但不能直接修改本地规则文件。规则集的新建、重命名、复制和删除通过明确的本地界面完成。

## 7. 规则本地筛选

翻译前由本地服务决定本次发送哪些规则：

```text
读取当前启用的规则集
→ 排除停用和已删除规则
→ 匹配正文中的原词和别名
→ 加入始终发送的规则
→ 合并重复规则
→ 处理优先级和冲突
→ 只发送最终相关规则
```

发送模式：

- `matched`：正文命中时发送。
- `always`：每次翻译都发送。
- `contextual`：当前章节或上下文相关时发送。
- `manual`：用户手动选择后发送。

规则优先级：

```text
当前任务临时规则
> 小说专用规则
> 系列共享规则
> 通用规则
```

同优先级冲突必须在翻译前提示用户，不把相互矛盾的规则同时发送给 AI。长短术语重叠时默认优先匹配较长术语。

## 8. 翻译请求隔离

翻译和规则解析使用独立接口：

```text
POST /api/translate-document
POST /api/rules/parse
```

翻译请求中正文和规则使用独立字段：

```json
{
  "segments": [
    {
      "id": "segment_0001",
      "text": "聖女アリスは王都へ向かった。"
    }
  ],
  "glossary": [
    {
      "id": "rule_001",
      "source": "聖女",
      "target": "圣女"
    }
  ],
  "instructions": [
    "只输出译文",
    "保留段落和换行"
  ]
}
```

AI 不输出术语表、原文、前言、标题或解释到译文正文中。

## 9. 长文本自动分段

现有基础分段升级为结构化分段，优先顺序为：

```text
内容块
→ 章节标题
→ 空行
→ 自然段
→ 句号、问号和感叹号
→ 超长单句强制切分
```

分段必须：

- 结合模型上下文上限计算，不只依赖固定字符数。
- 尽量避免从句子中间切开。
- 保留原始内容块 ID、顺序和格式。
- 不改变图片位置。
- 前端预计分段数与服务端实际分段算法一致。
- 支持最多 200,000 字符的现有输入限制，后续可配置。

分段记录示例：

```json
{
  "segmentId": "segment_0001",
  "blockId": "text-0",
  "partIndex": 0,
  "sourceText": "原文",
  "translatedText": "",
  "status": "pending"
}
```

## 10. 上下文连续性

翻译当前分段时附带有限上下文：

- 前 1 至 3 个分段的原文和译文。
- 当前上下文涉及的人物、称谓和术语。
- 始终生效的风格规则。
- 必要的人物关系和背景摘要。

采用滑动窗口控制上下文长度，避免请求不断增大。上下文仅用于辅助理解，不重复写入最终译文。

第一版默认采用“一致性优先”的顺序翻译。后续可以增加“速度优先”的有限并发模式。

## 11. 临时翻译任务和中断恢复

为了支持恢复，增加本地临时翻译任务，但不建立长期翻译项目。

任务保存：

- 任务 ID
- 文档名称
- 目标语言和模型
- 规则集 ID及版本
- 原始内容块
- 分段结果与状态
- 当前分段
- 已完成、失败和剩余数量
- 创建时间与过期时间

状态包括：

```text
pending
translating
completed
failed
cancelled
```

恢复行为：

- 页面刷新或服务重启后检测未完成任务。
- 用户选择继续后，从失败或未完成分段开始。
- 已完成分段不重复请求 AI。
- 完成、导出或清空时可以删除临时记录。
- 临时任务默认在本地保留有限时间。
- 用户可以关闭恢复功能或手动清理记录。

## 12. 翻译进度界面

进度区域采用圆形进度条，并在圆形进度条侧方显示当前翻译分段。

```text
┌─────────────────────────────────────────────────────┐
│       ╭────────╮     正在翻译第 13 / 30 段           │
│      │   43%   │     当前内容：聖女アリスは王都へ……   │
│       ╰────────╯     当前状态：正在请求 DeepSeek      │
│                      已完成 12 · 失败 0 · 剩余 18     │
│                      [取消翻译] [查看当前分段]         │
└─────────────────────────────────────────────────────┘
```

圆环状态颜色：

- 蓝紫色：正在翻译
- 绿色：翻译完成
- 红色：存在失败
- 黄色：暂停或部分完成
- 灰色：等待开始或已经取消

侧方显示：

- 当前分段序号和总分段数
- 当前段落的一至两行摘要
- 当前段字符数
- 当前步骤
- 完成、失败和剩余数量
- 当前重试次数

当前步骤可以是：准备分段、匹配规则、请求 AI、接收译文、恢复格式、术语校验或翻译完成。

移动端改为圆形进度条在上、分段信息在下。

## 13. 翻译操作体验

需要增加或完善：

- 翻译进度与当前分段显示。
- 取消当前翻译，同时保留已完成分段。
- 自动或手动重试失败分段。
- 从失败位置继续。
- 重新翻译当前段、失败段或全部内容。
- 使用修改后的规则重新翻译。
- 复制全部译文或当前分段译文。
- 只清空原文、只清空译文或清空全部。
- 显示字数、字符数、图片数和预计分段数。
- 显示当前模型、目标语言、规则集和命中规则数量。
- 页面内翻译完成和失败通知。
- 可选浏览器系统通知。
- 显示实际耗时、成功数、失败数和重试次数。

重新翻译全部内容前应提示会产生新的 API 消耗。

## 14. 原文格式保持

必须保持：

- 段落和空行
- 标题层级
- 列表和引用块
- 图片位置
- 对话引号
- 缩进和换行
- 特殊符号
- HTML 或 Markdown 结构
- 变量和占位符

需要保护的内容示例：

```text
{name}
{0}
%s
%d
{{variable}}
<br>
<span>
[SE:001]
https://example.com
```

翻译前将受保护内容转换成本地安全占位符，翻译后恢复，并校验占位符数量和顺序。最终文档结构由本地内容块决定，不由 AI 决定。

## 15. 术语和结果校验

AI 返回译文后，本地执行：

- 固定译法检查。
- 禁止译法检查。
- 人名一致性检查。
- 受保护格式和占位符完整性检查。
- 分段 ID、数量和顺序检查。
- 空译文和明显遗漏检查。
- 额外解释、前言或代码块检查。
- 图片数量和位置检查。

校验模式：

- 严格：校验失败时拒绝结果并重试。
- 警告：保留结果并显示问题。
- 关闭：不执行术语校验。

默认使用警告模式。用户可以查看具体异常分段并单独重新翻译。

## 16. 译文输出

页面翻译结果区域只展示最终译文和原有图片，不显示术语表、提示词和分析内容。

AI 内部使用结构化响应：

```json
{
  "translations": [
    {
      "id": "segment_0001",
      "text": "圣女爱丽丝前往了王都。"
    }
  ],
  "notes": [],
  "decisionSummary": [],
  "uncertainties": []
}
```

翻译说明和决策摘要按需生成。不请求或保存 AI 的内部完整思维过程，只保存可审核的翻译决定、歧义和不确定项。

## 17. 导出功能和可靠性

继续保留现有 TXT、DOCX、EPUB 导出，并新增“输出资料”功能。

可选输出内容：

- 最终译文
- 原文
- 本次术语表
- 翻译说明
- 翻译决策摘要
- 本次实际使用的规则
- 翻译任务信息

建议目录：

```text
小说名称_20260909_153000/
├─ translated.txt
├─ source.txt
├─ glossary.tsv
├─ translation-notes.md
├─ analysis-summary.md
├─ applied-rules.json
└─ manifest.json
```

导出要求：

- 所有文本统一使用 UTF-8。
- 不导出 API Key 或其他密钥。
- 避免覆盖已有文件，自动增加时间或序号。
- 支持重新导出，不要求重新翻译。
- 导出前校验译文和内容块完整性。
- 先生成临时内容，全部成功后再写入正式目录。
- 导出失败时指出具体失败文件。
- 用户取消时不留下不完整的正式文件。
- DOCX 和 EPUB 继续保持图片位置。
- 浏览器支持目录写入时直接保存到同一文件夹。
- 浏览器不支持目录写入时退化为 ZIP 资料包。

`manifest.json` 可以记录模型、语言、规则集及版本、字符数、分段数、重试次数、耗时和翻译时间。

## 18. API 向后兼容

现有翻译请求继续有效：

```json
{
  "blocks": [],
  "targetLanguage": "中文"
}
```

扩展请求增加可选字段：

```json
{
  "blocks": [],
  "targetLanguage": "中文",
  "ruleSetIds": ["ruleset_a83f92"],
  "temporaryRules": [],
  "validationMode": "warning",
  "outputOptions": {
    "notes": true,
    "decisionSummary": true
  }
}
```

响应继续保留原有 `blocks`，新增元数据：

```json
{
  "blocks": [],
  "translatedTextBlocks": 12,
  "meta": {
    "jobId": "job_9527",
    "matchedRules": [],
    "appliedRules": [],
    "validationIssues": [],
    "notes": [],
    "decisionSummary": [],
    "uncertainties": []
  }
}
```

未提供规则集和增强选项时，保持现有翻译行为。

## 19. 本地数据库与云端迁移架构

### 19.1 本地存储方案

`ver0.1` 采用 SQLite 统一保存以下非文件型数据：

- 应用设置
- 独立规则集和规则条目
- 规则集版本记录
- 临时翻译任务、分段状态和恢复信息
- 加密后的 API Key 记录
- 数据库结构版本和迁移记录

SQLite 是嵌入式文件数据库，不需要用户提前安装或启动独立数据库服务。启动 Node.js 服务时，应用自动完成：

```text
启动 Node.js 服务
→ 打开 data/app.db
→ 数据库不存在时自动创建
→ 执行尚未完成的结构迁移
→ 校验数据库状态
→ 开始提供翻译服务
```

运行时可能出现以下本地文件：

```text
data/
├─ app.db
├─ app.db-wal
├─ app.db-shm
├─ .master-key
└─ assets/
```

这些文件继续由 `.gitignore` 中的 `data/` 规则排除，不上传到 GitHub。

本地数据库实现：

- 使用 Node.js 24 内置的 `node:sqlite` 驱动，避免额外数据库服务和原生扩展安装。
- 启用 WAL 模式以改善读写并发。
- 启用外键约束。
- 设置合理的 `busy_timeout`。
- 规则修改、任务进度和密钥迁移必须使用事务。
- 数据库迁移采用递增版本号，禁止依赖手工改表。
- 对数据库文件提供可选的本地备份和恢复能力。
- 不将数据库放在可能被多个设备同时写入的同步盘目录中。

### 19.2 数据访问抽象

业务代码不能直接依赖 SQLite SQL。通过 Repository 接口访问数据：

```text
RuleSetRepository
├─ SQLiteRuleSetRepository
└─ PostgreSQLRuleSetRepository

TranslationJobRepository
├─ SQLiteTranslationJobRepository
└─ PostgreSQLTranslationJobRepository

SettingsRepository
├─ SQLiteSettingsRepository
└─ PostgreSQLSettingsRepository
```

核心业务层只依赖接口，不感知底层使用 SQLite 或 PostgreSQL。接口至少覆盖：

```js
class RuleSetRepository {
  async list(options) {}
  async getById(id) {}
  async create(ruleSet) {}
  async update(id, changes, expectedVersion) {}
  async softDelete(id) {}
  async restore(id) {}
}
```

`expectedVersion` 用于防止未来多用户或多实例环境下发生并发覆盖。

### 19.3 密钥存储抽象

API Key 通过统一的 `SecretStore` 接口管理：

```text
SecretStore
├─ AesGcmSecretStore：本地版
├─ KmsSecretStore：未来云端版
└─ MemorySecretStore：自动化测试
```

统一接口：

```js
class SecretStore {
  async save(scopeId, secretName, plaintext) {}
  async read(scopeId, secretName) {}
  async delete(scopeId, secretName) {}
  async rotate(scopeId, secretName) {}
}
```

本地版采用：

```text
API Key
→ 由独立随机主密钥使用 AES-256-GCM 加密
→ 将密文、随机 IV、认证标签和版本信息保存到 SQLite
→ 将 32 字节主密钥单独保存在 data/.master-key
→ 使用时在内存中短暂解密
```

此方案不依赖 Windows 用户账户，适合轻量本地使用。SQLite 不保存主密钥，但数据库与 `.master-key` 必须分开保护：同时取得两者的人可以解密 API Key。密钥记录采用可迁移的版本化格式：

```json
{
  "scopeId": "local-user",
  "secretName": "deepseek-api-key",
  "provider": "local-aes-256-gcm",
  "formatVersion": 1,
  "ciphertext": "...",
  "metadata": {
    "iv": "...",
    "authTag": "...",
    "aadVersion": 1
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

现有 MVP 使用 `.master-key` 和 AES-256-GCM。升级到 `ver0.1` 时进行一次性兼容迁移：

```text
检测旧 secrets.json 和 .master-key
→ 使用现有逻辑解密
→ 通过 AesGcmSecretStore 使用同一主密钥重新加密
→ 在事务中写入 SQLite
→ 重新读取并验证
→ 迁移成功后清理旧 secrets.json，保留 .master-key
```

迁移失败时继续保留旧文件并给出明确错误，不能导致用户密钥丢失。

### 19.4 未来云端方案

迁移云端后，推荐组合为：

```text
PostgreSQL
+ 云平台 KMS / Key Vault / Secret Manager
+ KmsSecretStore
+ 多用户身份认证和权限隔离
```

如果云服务使用运营方统一提供的 DeepSeek Key，该密钥应直接存入云平台 Secret Manager，不进入业务数据库。

如果允许每个用户提供自己的 AI Key，则使用信封加密：

```text
用户 API Key
→ 随机数据密钥加密
→ API Key 密文保存到 PostgreSQL
→ 数据密钥再由云端 KMS 主密钥加密
→ 加密后的数据密钥与 keyId 一并保存
```

云端密钥记录示例：

```json
{
  "scopeId": "user_9527",
  "secretName": "deepseek-api-key",
  "provider": "cloud-kms",
  "formatVersion": 2,
  "ciphertext": "...",
  "metadata": {
    "keyId": "...",
    "keyVersion": 1,
    "encryptedDataKey": "...",
    "iv": "...",
    "authTag": "..."
  }
}
```

从本地迁移到云端时，由迁移程序通过 `SecretStore` 完成解密和重新加密，翻译、规则集和任务业务逻辑不需要修改。

### 19.5 可扩展性边界

为保证未来可以扩展为云服务，`ver0.1` 开始遵循：

- 不在业务层直接调用 AES、SQLite 或具体 KMS SDK。
- 不在业务层直接拼写 SQL。
- 所有数据记录使用稳定 UUID，而不是依赖本地文件名。
- 所有持久化记录包含创建时间、更新时间和结构版本。
- 规则集更新支持乐观并发版本。
- 临时任务归属通过 `scopeId` 表示；本地为单用户，云端可映射为用户或租户。
- 模型提供者通过接口抽象，避免业务逻辑绑定 DeepSeek。
- 本地部署保持零数据库运维；云端部署允许水平扩容。

## 20. 安全要求

- MVP 继续兼容现有 AES-256-GCM 密钥文件，`ver0.1` 使用独立本地主密钥加密 SQLite 密钥记录。
- API Key 不写入日志、规则集、任务记录和导出文件。
- SQLite 不保存明文 API Key 或主密钥；主密钥单独保存在被 Git 忽略的 `data/.master-key`。
- 解密后的 API Key 仅在请求期间短暂保存在内存中。
- 本地 `SecretStore` 不绑定 Windows 用户；复制本地数据时必须同时保护数据库和主密钥文件。
- 云端 `SecretStore` 使用 KMS 或 Secret Manager，并支持密钥轮换和访问审计。
- 新增规则修改接口仅允许本机页面调用。
- 对规则数量、字段长度、请求体大小和任务数量设置限制。
- 文件名和 ID 必须经过校验，防止路径穿越。
- SQLite 写操作使用事务；数据库迁移和备份失败时不得破坏原数据。
- 图片仍然只保存在本地。
- 临时任务明确显示保存期限，并允许用户随时清除。

## 21. 推荐代码组织

在保留现有入口的基础上逐步拆分：

```text
lib/
├─ deepseek-client.js
├─ text-segmenter.js
├─ context-builder.js
├─ rule-matcher.js
├─ rule-parser.js
├─ translation-validator.js
├─ export-bundle.js
├─ secrets/
│  ├─ secret-store.js
│  ├─ aes-gcm-secret-store.js
│  ├─ kms-secret-store.js
│  └─ memory-secret-store.js
└─ storage/
   ├─ database.js
   ├─ migrations/
   ├─ rule-set-repository.js
   ├─ translation-job-repository.js
   ├─ settings-repository.js
   ├─ sqlite/
   └─ postgres/
```

`server.js` 继续作为 Express 路由入口。前端继续使用现有 Vue 3 单页形式，首版不强制引入构建工具。

存储和密钥提供者通过启动配置注入：

```text
本地默认：SQLite + AesGcmSecretStore
自动化测试：临时 SQLite + MemorySecretStore
未来云端：PostgreSQL + KmsSecretStore
```

## 22. 推荐实施顺序

1. 为现有翻译、图片和导出能力增加基础回归测试。
2. 建立 Repository、SecretStore 和模型提供者接口。
3. 引入 SQLite、数据库迁移机制和本地 Repository 实现。
4. 实现 AesGcmSecretStore 及现有 AES 密钥文件的安全迁移。
5. 拆分 DeepSeek 调用和文本分段模块，但保持原接口行为。
6. 实现规则集的新建、重命名、编辑、复制、删除和恢复。
7. 增加右侧规则集界面。
8. 增加自然语言规则解析、预览和确认。
9. 增加本地规则匹配、优先级和冲突处理。
10. 升级长文本分段和上下文连续性。
11. 实现临时翻译任务、进度查询、取消和中断恢复。
12. 增加圆形进度条、当前分段和重试操作。
13. 增加格式保护和术语结果校验。
14. 增加翻译说明、决策摘要和资料目录导出。
15. 完整回归 SQLite、密钥迁移、TXT、DOCX、EPUB、图片、API Key 和端口检测功能。

## 23. ver0.1 完成标准

`ver0.1` 完成时应满足：

- 原有全部功能能够继续使用。
- 用户可以管理多个独立规则集。
- 用户可以通过自然语言生成候选规则并确认保存。
- 翻译时只发送本段相关规则和必要上下文。
- 长文本可以自动分段并恢复原顺序。
- 页面使用圆形进度条显示整体进度，侧方显示当前分段。
- 翻译可以取消、恢复、重试和重新翻译。
- 固定术语、禁止译法和格式占位符能够本地校验。
- 页面最终主要显示纯译文和原有图片。
- 用户可以复制译文并可靠导出 TXT、DOCX、EPUB。
- 用户可以将译文与选定的附加资料输出到同一文件夹或 ZIP 包。
- API Key、图片和临时任务继续遵循本地安全要求。
- SQLite 随 Node.js 服务自动打开，无需用户启动独立数据库服务。
- 规则集、设置和临时任务通过 Repository 接口访问。
- API Key 通过 SecretStore 管理，SQLite 中只保存受保护密文。
- 现有 AES 密钥文件可以安全迁移，失败时不会丢失原凭据。
- PostgreSQL Repository 和 KmsSecretStore 已预留稳定接口，未来迁移不需要改写核心翻译逻辑。

## 24. 完整工作流程

```text
输入原文和图片
→ 选择目标语言、模型和规则集
→ 本地统计字符和预计分段数
→ 保护变量、标签和特殊格式
→ 按文档结构自动分段
→ 本地匹配相关规则
→ 处理重复项和规则冲突
→ 创建本地临时翻译任务
→ 携带有限上下文逐段请求 AI
→ 圆形进度条显示整体进度
→ 侧方显示当前翻译分段和状态
→ 恢复格式并执行术语校验
→ 自动或手动重试失败分段
→ 按原始内容块重新组合图文译文
→ 页面显示最终译文
→ 复制或导出 TXT、DOCX、EPUB及配套资料
```

## 25. ver0.2 Electron Windows 启动器

### 25.1 版本目标与边界

ver0.2 在 ver0.1 翻译服务外增加 Electron Windows 启动器。启动器负责进程、端口、日志、托盘和 Windows 登录项；`server.js` 继续负责翻译、规则、任务、图片、导入和导出。

```text
Electron 主进程
├─ 单实例与全局 PID 锁
├─ server.js 子进程生命周期
├─ 端口、健康检查和日志
├─ SQLite 启动器设置
├─ Windows 登录项与系统托盘
└─ 安全 IPC 与自动更新状态占位

Electron preload
└─ 向管理页面暴露固定白名单 API

Vue 管理页面
└─ 只负责状态展示与用户操作
```

大型文档翻译候选方案、云端部署、Windows Service 和实际自动更新不属于 ver0.2。

### 25.2 端口与服务状态

- 启动器管理端口固定为 `127.0.0.1:7000`。
- 翻译服务默认端口为 `127.0.0.1:6501`，可由用户修改。
- 两个端口不能相同，均不监听外部网卡。
- 不自动随机选择端口，不结束未知端口占用进程。
- 服务只有在记录的子进程存在、端口监听成功、HTTP 健康检查通过且实例身份一致时才显示正常。

端口切换按以下顺序执行：

```text
验证新端口
→ 停止旧服务
→ 等待旧端口释放
→ 启动新端口
→ 校验 PID、实例 ID 与健康响应
→ 成功后保存设置
```

新端口启动失败时不保存错误配置，并尝试恢复原端口服务。启动、停止、重启、保存设置和端口切换共用一个异步操作锁，并发操作会被明确拒绝。

### 25.3 PID、单实例与异常恢复

启动器将服务 PID、端口、实例 ID 和私有控制令牌写入本地运行记录。停止服务时优先调用受保护的本机优雅关闭接口；超时后也只允许结束经过身份校验或仍是直接子进程的记录 PID。

单实例保护分为两层：

1. Electron `requestSingleInstanceLock` 负责正常重复启动并激活已有窗口。
2. Windows 用户临时目录中的全局 PID 锁阻止不同用户数据目录产生第二个启动终端。

全局锁使用独占创建和随机所有者令牌。记录 PID 已失效时，新启动器可以清理失效锁并恢复；释放锁时会再次核对所有者，避免删除其他实例的新锁。

### 25.4 Windows 与托盘行为

以下设置复用现有 `SettingsRepository` 写入 SQLite：

- Windows 登录后启动 Electron 启动器。
- 启动器就绪后自动启动翻译服务。
- 启动时隐藏到系统托盘。
- 服务异常退出后是否自动重启。

不直接把 `server.js` 注册为登录启动项。关闭主窗口只隐藏到托盘；托盘“退出”才停止记录的翻译服务并退出。存在活动翻译任务时，托盘退出会先要求确认。

自动重启默认关闭；启用后连续最多三次并使用递增等待。端口占用等确定性错误不会进入无限重启循环。

### 25.5 日志与安全

Launcher 和 Service 日志写入运行数据目录的 `logs/`：

- 默认保留 7 天。
- 单文件最多 10 MB。
- 最多保留 5 个历史文件。
- 管理页面显示最近 200 行。
- API Key、Authorization、Bearer Token 等敏感字段写入前脱敏。

BrowserWindow 启用 `contextIsolation`、禁用渲染进程 Node.js、启用沙箱和 Web 安全。preload 只暴露状态、服务操作、端口检测、日志、设置和更新占位接口，不允许执行任意命令。管理页面只从固定本机来源调用 IPC。

### 25.6 打包、数据和更新边界

使用 electron-builder 生成 Windows x64 解包目录和 NSIS 安装包。安装包携带 Electron/Node 运行时，最终用户不需要安装 Node.js。

以下运行数据不进入安装包或 Git：

- SQLite 数据库及 WAL 文件。
- `data/.master-key`。
- 用户导入或粘贴的图片。
- Launcher/Service 日志。
- 临时翻译任务和服务 PID 记录。

自动更新只提供 IPC 状态占位，ver0.2 不下载、安装、替换或回滚程序。

### 25.7 ver0.2 验证基线

- Node.js 测试共 94 项，覆盖既有翻译业务、启动器、迁移、AI adapter、SSE 流式解析、Token 用量、规则候选规范化、并发保护、剪贴板网页、ZIP 导入、SVG 隔离、浏览器注入函数自包含性与扩展原格式图片及容量边界。
- 覆盖设置持久化、操作锁、全局锁、端口检测、日志脱敏与轮转、服务生命周期、端口切换回滚、异常重启上限和健康身份校验。
- Windows 解包版已实际启动 `server.js` 子进程并取得带实例 ID 的健康响应。
- 使用不同用户数据目录重复启动时，第二个启动进程退出，进程数量不增加。
- 管理页面已有 1120×760、窄窗口和移动断点；Electron 最小窗口已降为 560×480，以便窄屏布局可实际生效。
- Windows x64 NSIS 安装包构建成功；当前未配置代码签名和正式产品图标。

## 26. 标准化网页 ZIP 导入

标准包固定包含 `manifest.json`、`document.json`、`content.html` 与 `assets/`。`document.json` 是唯一规范内容来源；`content.html` 只验证存在与大小，不进入 DOM，也不能覆盖规范内容。PNG/JPEG/GIF/WebP 按魔数验证并保持原字节。安全 SVG 保持原始字节，同时必须附带 PNG 预览；导入后 SVG 隔离到 `data/original-assets/`，普通页面和导出只使用 `data/assets/` 中的 PNG 预览。

导入由 `WebPackageReader → ImportWebPackage → StagedAssetStore` 完成：先限制压缩包、文件数量、单文件、展开总量和压缩比，再校验安全路径、manifest、内容块与资源引用；所有资源先写入会话临时目录，完整文档模型校验通过后再提交。任何错误都会删除临时文件和本次已提交文件。

新增接口：

```text
POST /api/import/web-package
multipart 字段：package
```

成功返回 `manifest`、统一 `Document`、本地资源映射和预览来源。失败返回稳定的 `WEB_PACKAGE_*` 错误码。ZIP 导入当前只创建可预览、可翻译的临时资源，不新增文档持久化表，因此没有为它增加数据库迁移。完整格式见 `WEB_CONTENT_ZIP_FORMAT.md`。

## 27. 渐进式模块边界

当前新增边界如下：

```text
server.js / lib/application.js  组合依赖与 HTTP 映射
lib/api/                       余额和任务事件等 HTTP 路由适配器
lib/application/               翻译兼容、规则候选、ZIP 导入用例
lib/domain/                    Document、ZIP 合同和任务状态机
lib/infrastructure/            ZIP、资源暂存、图片识别和导出器
lib/ai/                        Prompt、响应解析与外部错误映射
lib/migrations/                递增且带校验和的 SQLite 迁移
electron/                      进程、端口、日志、托盘与安全 IPC
public/                        Vue 界面、浏览器 API client、剪贴板读取
browser-extension/              Chrome/Edge 选区读取、图片下载与标准 ZIP 生成
```

DeepSeek 是 `TranslationProvider` / `RuleProposalProvider` 的具体实现。旧 `/api/translate` 保留原请求和响应格式，但已通过兼容 Application 用例调用 Provider。规则候选仍须用户确认后才写入。

## 28. SQLite 迁移与翻译任务并发

迁移继续使用 `node:sqlite`、`BEGIN IMMEDIATE`、WAL、外键和 busy timeout。迁移已拆到 `lib/migrations/`；每项有递增版本、名称和 SHA-256 校验和。启动时校验迁移历史与关键 schema，失败会回滚并关闭数据库。

第 3 号迁移为翻译任务增加 `revision`、`worker_id`、`lease_until`、`last_heartbeat_at`、`last_error` 和 `recovery_reason`。Repository 使用 revision CAS，worker 必须持有有效租约；心跳续租不改变业务 revision。旧 worker 的迟到 AI 返回在写入前会重新核对 worker、状态和 revision，不能覆盖取消、重试或新 worker 的状态。已完成任务保持终态；“全部重译”创建新任务，避免覆盖旧完成结果。

这不是大型文档 Worker Pool：当前仍为单任务内顺序翻译，只增强现有任务的恢复与竞态防护。

## 29. Chrome/Edge 网页选区导出扩展

`browser-extension/` 是独立的 Manifest V3 扩展，不在渲染进程中引入 Node.js，也不向网页暴露任意命令能力。用户点击扩展后，它仅对当前 HTTP/HTTPS 标签页临时注入选区读取函数，提取受支持的标题、段落、列表、引用与 `<img>`，按原出现顺序构造 `ContentBlock`。

扩展使用跨域主机权限重新下载图片，但明确使用 `credentials: omit`，不发送 Cookie 或 Authorization。PNG、JPEG、GIF 和 WebP 字节不经 Canvas、不转码，以原格式写入 STORE ZIP 条目。安全 SVG 的原始字节也写入 ZIP，另通过浏览器安全图像模式生成 PNG 预览；含主动内容或外部引用的 SVG 拒绝导出。选区图片的 `getBoundingClientRect()` 尺寸被记录为 CSS 像素。相同 URL 只下载一次，多个图片块可复用同一资源。

生成包严格包含 `manifest.json`、`document.json`、`content.html` 和已引用的 `assets/`。`document.json` 仍是规范来源，`content.html` 由已转义的模型重新生成。选区与导入合同同步限制为最多 5,000 个内容块、2,000 个唯一图片、4,004 个 ZIP 条目（含可选目录条目）、200 MB ZIP、500 MB 解压总量、单资源 8 MB 和文字 200,000 字符；SVG 原件和 PNG 预览分别计入条目与容量。任一图片失败时构建整体失败，不下载半成品 ZIP。这不引入大型文档任务队列或 Worker Pool。

自然语言规则候选在 Application 层统一规范化：风格、背景和格式说明会归入 `target` 并默认始终发送；只提供禁止词列表的禁止译法规则允许空 `target`；AI 更新操作中的空占位字段不会清除现有必要字段。每条候选包含保存前校验状态，前端会标出无效项并禁止确认，服务端再次校验以防绕过界面。

出于主动内容与隐私边界，扩展不保留 SVG、CSS 背景图、视频、`blob:` URL 或要求登录态/防盗链的图片。WebP 可在应用内显示及导出 EPUB，但当前 DOCX 依赖不支持 WebP，导出 Word 前需转换为 PNG/JPEG。

## 30. 流式译文、余额与 Token 用量

长文本翻译的 DeepSeek 适配器使用 SSE，并通过 `stream_options.include_usage` 获取最后一个响应块中的官方用量。基础设施层负责 SSE 解码与结构化 JSON 增量提取；`TranslationService` 只接收 Provider 的译文增量和最终结果。当前分段的未完成译文只存于服务内存并经本机 SSE 接口推送，不逐 Token 写 SQLite；分段通过占位符、术语和形态校验后仍按原事务边界写入最终结果。

```text
GET  /api/translation-jobs/:id/events
POST /api/translation-jobs/:id/segments/:segmentId/retry
GET  /api/deepseek/balance
GET  /api/usage/session
```

页面保留轮询作为 SSE 断线兜底。译文区允许纵向拖动并设置最大高度，内容超出后内部滚动；用户离开底部时停止自动跟随并显示“回到当前”。失败段公开稳定的段号、源块位置、尝试次数与错误，可定位并单独重置为 `pending`；有效 worker 存在时仍拒绝并发重试，旧 worker 的迟到返回继续受 workerId、revision 和状态校验保护。

`/api/deepseek/balance` 由本地后端携带解密后的 API Key 请求官方 `/user/balance`，前端只获得余额值和更新时间，永远不获得密钥。翻译进行中每 60 秒刷新余额，结束后立即刷新；查询失败只影响余额卡片。任务 Token 累计和估算费用保存于既有 `translation_jobs.meta_json`，服务会话累计仅保存在当前进程内存，因此没有新增表、字段或数据库迁移。估算费用按代码中标注日期的公开单价计算，最终以 DeepSeek 账单为准。

主界面可读性保持为纯前端关注点：正文和输入区使用更大的基础字号，主要按钮维持至少约 42px 的点击高度，状态、说明和规则元数据不再使用过小字号。说明文字在鼠标悬停时提高亮度并增加轻微辉光，键盘操作提供清晰焦点轮廓。390px 移动端采用独立的标题栏宽度分配，放大字号后仍不产生横向滚动；这些变化不修改 API、SQLite 或任务状态。
