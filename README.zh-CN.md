<p align="center">
  <img src="./assets/image.png" alt="Zotero Paper Partner icon" width="120">
</p>

# Zotero Paper Partner（论文伙伴）· 增强版

一个 Zotero 插件：在笔记里写一行 `Q: 你的问题`，插件在后台静默调用大模型回答，不打断你的阅读。

**本 fork 让它真正"读到"你的 PDF。** 上游版本只能看到你复制进笔记的文字，在 Kimi 系 API 上会静默失败，在 Zotero 9 上全文读取完全失效——这些都在本 fork 中修复，并新增了可见的状态流转、追问记忆和基于真实页码的原文引用。

> 🇬🇧 English summary in [README.md](./README.md)
>
> 本 fork 基于 [QinSihan/zotero-paper-partner](https://github.com/QinSihan/zotero-paper-partner)（v0.1.1），改动以 commit 为单位完整记录在本仓库历史与 [CHANGELOG.md](./CHANGELOG.md) 中。

![Zotero](https://img.shields.io/badge/Zotero-9-E05A47?logo=zotero&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=000)
![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI兼容-412991?logo=openai&logoColor=white)

---

## 使用流程

在 Zotero 中阅读文献时，打开挂在条目下的笔记：

1. 新起一行写 `Q: 你的问题`（**半角冒号**），按回车、再回车留一个空行
2. 观察状态流转：

```
A[reading]:  正在定位并读取该条目 PDF 的全文（首次使用会先建索引，约 10-30 秒）
A[thinking]: 全文 + 你的笔记上下文 + 最近几组问答已发送给模型，生成中
A[done]:     答案已插入，引用原文时附带 [page N] 真实页码
A[error]:    出错时写明原因（网络超时 / HTTP 4xx / JSON 异常等）
```

全程无弹窗、不打断阅读。任何异常都以 `A[error]: 具体原因` 呈现在原处，而不是无声失败。

## 为什么 fork：每一版解决了什么问题

| 版本 | 改动 | 解决的问题 |
|---|---|---|
| v0.1.2 | temperature 不再写死 0.3 | Kimi 模型只允许 1.0，原版每个请求都被 HTTP 400 拒绝，且只体现为笔记里一行不起眼的 `A[error]`——看起来就像"插件没反应" |
| v0.1.3 | PDF 全文注入（PdfContext 模块） | 原版模型只能看到笔记里已有的文字——你没摘抄的内容它就"不知道"，全凭训练记忆编造 |
| v0.1.4 | 适配 Zotero 9 | `Zotero.Fulltext.getItemContent` 在 Zotero 9 中已被移除（在 9.0.6 安装文件源码中确认），全文读取永远失败；改为直接读取 `.zotero-ft-cache` 缓存文件 |
| v0.1.5 | 短文档整篇注入 + `[page N]` 页码标记 | 关键词选段在"中文提问 + 英文文献"时基本失效；模型引用页码全靠训练记忆（幻觉）。现在 ≤5 万字符的 PDF 整篇附上 |
| v0.1.6 | 设置页 / 追问记忆 / BM25 选段 | 无法追问（每次提问都是失忆的）；长文档选段不精准。新增 Temperature、Max Tokens 设置项和最近 2-3 组问答记忆 |
| v0.1.7 | 状态机 / 回答专用预算 / Kimi 温度自适配 / 原生超时 | 网络悬死导致 `A[running]` 永远卡住；思考烧光 token 导致空回答；Kimi 按思考模式锁定温度（开=1.0、关=0.6）导致 400 |

## 适用场景

### 适合

- **Zotero 7 及以上**（在 Zotero 9.0.6 实测），使用 OpenAI 兼容 API：Kimi / Moonshot、DeepSeek 等
- **用中文提问、阅读英文文献**——短文档整篇注入，不依赖关键词匹配，跨语言提问无压力
- **段落级与章节级理解**：术语解释、某节讲了什么、"引用原文回答我，并告诉我位置在哪"（答案会给出 `[page N]` 真实页码）
- **同一篇笔记内连续追问**："那第二部分呢？"这类指代式问题可以工作（自动携带最近 2-3 组已完成问答）
- 希望问答过程安静、无弹窗、不打断阅读节奏的人

### 不适合 / 注意

- 需要多步深度推理的数学推导、证明类问题——默认跳过深度思考以保证速度（确有需要可在 Config Editor 把 `extensions.paper-partner.thinking` 设为 `standard`，会自动附加 8000 token 思考余量）
- 超过 5 万字符的大部头（自动退回 BM25 相关性选段，建议配合把关键段落摘抄进笔记）
- 期望多轮对话式 agent 体验——本插件刻意保持"一次提问、一次调用"的轻量设计

## 安装

1. 下载本仓库的 `dist/paper-partner-0.1.7.xpi`
2. Zotero → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File** → 重启 Zotero
3. 设置 → Paper Partner，填入 API Endpoint / API Key / Model

> 升级提示：先在插件管理器里移除旧版、重启、再从文件安装新版，避免"旧版被卸、新版没装上"的中间态（Zotero 运行中旧版文件被锁定所致）。

## 配置说明

| 配置项 | 说明 |
|---|---|
| API Endpoint | OpenAI 兼容的 chat/completions **完整地址**。Kimi For Coding：`https://api.kimi.com/coding/v1/chat/completions`；DeepSeek：`https://api.deepseek.com/v1/chat/completions` |
| API Key | 对应平台的密钥（Kimi For Coding 的 key 形如 `sk-kimi-...`） |
| Model | 如 `k3`（Kimi）、`deepseek-chat`（DeepSeek） |
| Answer Mode | Brief（1-3 句）/ Detailed（2-4 段） |
| Trigger Delay | 停止输入后多久开始处理（默认 2 秒） |
| Temperature | **Kimi 端点按思考模式自行固定温度（思考开=1.0、关=0.6），本 fork 已自动省略该字段**；此设置仅对 DeepSeek 等其他提供商生效 |
| Max Tokens | 只限制**可见回答**（Auto=3000）；思考余量单独计算，不会挤占回答；回答被截断时自动翻倍重试一次 |

## 故障排查

开启 调试输出日志（帮助 → 调试输出日志 → 启用），日志中所有本插件的行为都带 `[PaperPartner]` 前缀。

| 现象 | 含义与处理 |
|---|---|
| `A[error]: Request timed out after 180s` | 网络或端点无响应，稍后重问；持续出现检查代理与网络 |
| `A[error]: HTTP 400: invalid temperature ...` | 已内置自愈（自动去掉温度字段重发）；若仍出现请提 Issue |
| `A[error]: HTTP 4xx/5xx: ...` | API 侧错误——看 body：key 失效、额度不足、模型名错误等 |
| 停在 `A[thinking]` 很久 | 最长 3 分钟自动超时并报错；正常应在 10-60 秒内完成 |
| 写了 `Q:` 完全没反应 | 确认：半角冒号 `Q:`（全角 `Q：` 不认）、Q 行不是笔记最后一段（按回车留空行）、笔记挂在有 PDF 的条目下、API Key 已配置 |

## 与上游的关系

- 改动集中在 `bootstrap.js`（PDF 上下文、状态机、HTTP 传输、记忆）与 `prefs.xhtml`（设置页）
- `manifest.json` 的 `update_url` 与 `updates.json` 已指向本 fork，不会拉取上游更新覆盖补丁
- 原始设计与 `target.md` 规格文档出自上游作者 [Sihan Qin](https://github.com/QinSihan)，感谢这个"安静阅读伙伴"的优雅创意
- 版权归上游作者所有，本 fork 供个人学习与研究使用
