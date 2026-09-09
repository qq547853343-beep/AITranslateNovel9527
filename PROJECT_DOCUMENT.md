# AIWordTranslateService9527 设计总结

## 文档信息

- 项目版本：`ver0.1`
- 文档性质：功能设计与实施规划
- 当前状态：需求总结，尚未实施
- 运行方式：Windows 本地服务
- 默认地址：`http://127.0.0.1:6501`
- AI 服务：DeepSeek Chat API

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

AI 可以返回新增、修改、停用、删除和创建规则集等候选操作，但不能直接修改本地规则文件。规则集的重命名、复制和删除优先通过明确的本地界面完成。

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
└─ assets/
```

这些文件继续由 `.gitignore` 中的 `data/` 规则排除，不上传到 GitHub。

本地数据库建议：

- 使用 `better-sqlite3` 作为 Node.js SQLite 驱动，并在实施前确认目标 Windows 环境兼容性。
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
├─ DpapiSecretStore：Windows 本地版
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
→ Windows DPAPI 绑定当前 Windows 用户进行保护
→ 仅将密文和版本信息保存到 SQLite
→ 使用时在内存中短暂解密
```

SQLite 中不保存独立的明文主密钥。密钥记录采用可迁移的版本化格式：

```json
{
  "scopeId": "local-user",
  "secretName": "deepseek-api-key",
  "provider": "windows-dpapi",
  "formatVersion": 1,
  "ciphertext": "...",
  "metadata": {},
  "createdAt": "...",
  "updatedAt": "..."
}
```

现有 MVP 使用 `.master-key` 和 AES-256-GCM。升级到 `ver0.1` 时需要提供一次性兼容迁移：

```text
检测旧 secrets.json 和 .master-key
→ 使用现有逻辑解密
→ 通过 DpapiSecretStore 重新加密
→ 在事务中写入 SQLite
→ 重新读取并验证
→ 迁移成功后再清理旧密钥文件
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

- 不在业务层直接调用 DPAPI、SQLite 或具体 KMS SDK。
- 不在业务层直接拼写 SQL。
- 所有数据记录使用稳定 UUID，而不是依赖本地文件名。
- 所有持久化记录包含创建时间、更新时间和结构版本。
- 规则集更新支持乐观并发版本。
- 临时任务归属通过 `scopeId` 表示；本地为单用户，云端可映射为用户或租户。
- 模型提供者通过接口抽象，避免业务逻辑绑定 DeepSeek。
- 本地部署保持零数据库运维；云端部署允许水平扩容。

## 20. 安全要求

- MVP 继续兼容现有 AES-256-GCM 密钥文件，`ver0.1` 目标方案为 SQLite 密文记录加 Windows DPAPI。
- API Key 不写入日志、规则集、任务记录和导出文件。
- SQLite 不保存明文 API Key 或明文主密钥。
- 解密后的 API Key 仅在请求期间短暂保存在内存中。
- 本地 `SecretStore` 将凭据绑定当前 Windows 用户。
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
│  ├─ dpapi-secret-store.js
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
本地默认：SQLite + DpapiSecretStore
自动化测试：临时 SQLite + MemorySecretStore
未来云端：PostgreSQL + KmsSecretStore
```

## 22. 推荐实施顺序

1. 为现有翻译、图片和导出能力增加基础回归测试。
2. 建立 Repository、SecretStore 和模型提供者接口。
3. 引入 SQLite、数据库迁移机制和本地 Repository 实现。
4. 实现 DpapiSecretStore 及现有 AES 密钥文件的安全迁移。
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
