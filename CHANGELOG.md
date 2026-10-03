# Changelog

本 fork 相对上游 v0.1.1（[QinSihan/zotero-paper-partner](https://github.com/QinSihan/zotero-paper-partner)）的全部变更。
每个版本对应仓库中的一个 commit，改动细节见提交信息与 diff。

## 0.1.7 — 状态机 · 回答专用预算 · Kimi 温度自适配 · 原生超时

### 状态机
- `A[running]` 拆分为 `A[reading]`（定位并读取 PDF 全文）与 `A[thinking]`（模型生成中）
- 首次使用某篇 PDF 时，`A[reading]:` 会显示"正在建立全文索引"提示
- 空回答/截断自动以加倍预算重试时，`A[thinking]:` 会显示重试提示
- 每次状态切换 = 一次笔记写入；终态 `A[done]/A[error]/A[stale]` 语义不变

### Token 预算语义
- Max Tokens 设置只限制**可见回答**（Auto = 3000）
- 思考默认**关闭**（避免 overthinking 与"思考耗尽预算导致空回答"）；手动将 `thinking` pref 设为 `standard` 可恢复思考并自动附加 8000 token 余量
- 回答被截断时自动以加倍回答预算重试一次（3000 → 6000，上限 32768）

### Kimi 温度自适配
- 实测 Kimi 端点按思考模式锁定 temperature（思考开 = 1.0，关 = 0.6），其他值一律 400
- 对 kimi.com / moonshot 系端点自动**省略 temperature 字段**，由 API 使用其要求的值
- 收到 `invalid temperature` 400 时自动去掉温度字段重发一次（对任何限制型提供商自愈）
- Temperature 设置保留，仅对未锁定温度的提供商（如 DeepSeek）生效

### 传输与超时
- HTTP 层从 `fetch` 改为 `Zotero.HTTP.request`：bootstrap 插件作用域没有 `AbortController` 全局，且原生 `timeout` 参数自带连接/无活动/总时长三重保护
- 超时 = 180 秒下限 + 40 ms/token 随回答预算缩放（6000 预算 → 240 秒），长回答不会被误杀，死连接仍会被兜住
- `responseType` 改为 `text` + 手动 JSON 解析：API 报错时错误详情（`responseText`）可完整读出并写入 `A[error]`

## 0.1.6 — 设置页 · 问答记忆 · BM25

- 设置页新增 Temperature / Max Tokens 下拉框
- **问答记忆**：处理问题时携带同一笔记上方最近 2-3 组已完成的 Q/A（≤1500 字符），支持"那第二部分呢？"式追问；仅携带 `A[done]`，报错历史不污染上下文
- 长文档选段升级：预算 4500 → 16000 字符、取前 10 块（块 1600 字符），打分从词频改为 BM25（文档频率降权常见词，稀有词主导排序）

## 0.1.5 — 整篇注入 · 页码标记

- PDF 正文 ≤ 50000 字符时跳过选段、整篇附上；超过则退回 BM25 前身（词频）选段
- PDF 缓存中的独立页码行转换为 `[page N]` 标记，使模型可以基于真实页码引用位置

## 0.1.4 — 适配 Zotero 9

- `Zotero.Fulltext.getItemContent` 在 Zotero 9 中已移除（9.0.6 安装包源码确认），0.1.3 的读取路径永远失败
- 改为 `getItemCacheFile(item).path` 定位 `.zotero-ft-cache` 直接读取，辅以附件路径推导的回退
- 缓存缺失时先 `indexItems` 建索引再读取；所有失败路径写入 `[PaperPartner]` 调试日志

## 0.1.3 — PDF 全文注入

- 新增 `PdfContext` 模块：定位笔记所属条目的 PDF 附件 → 读取全文 → 分块（1200 字符）→ 按「问题词 ×2 + 笔记上下文词 ×1」词频打分 → 取最相关 4 块 + 标题/摘要区（≤4500 字符）注入 prompt
- 此前模型只能看到笔记里已有的文字，答案质量完全取决于用户摘抄了什么

## 0.1.2 — Kimi 兼容性

- API 请求的 `temperature` 从写死的 0.3 改为 1.0：Kimi 模型只允许 1.0，原版每个请求都被 HTTP 400 拒绝（`invalid temperature`），且仅体现为笔记里一行不起眼的 `A[error]`
