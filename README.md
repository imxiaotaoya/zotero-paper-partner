<p align="center">
  <img src="./assets/image.png" alt="Zotero Paper Partner icon" width="120">
</p>

# Zotero Paper Partner · Enhanced Fork

A Zotero plugin that answers `Q:` questions you write inside notes — silently, in the background, without breaking your reading flow.

**This fork makes it actually read your PDFs.** The upstream plugin only saw whatever you had copied into your notes, silently failed on Kimi-style APIs, and broke on Zotero 9. This fork fixes all of that and adds a visible status machine, follow-up memory, and real page citations.

> 🇨🇳 **完整中文说明请看 [README.zh-CN.md](./README.zh-CN.md)**（内容更详细，推荐阅读）

![Zotero](https://img.shields.io/badge/Zotero-9-E05A47?logo=zotero&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=000)
![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991?logo=openai&logoColor=white)

---

## What changed vs upstream

| Version | Change | Problem it solves |
|---|---|---|
| v0.1.2 | Stop hardcoding `temperature: 0.3` | Kimi models only allow 1.0 — every request was rejected with HTTP 400, surfacing as a silent `A[error]` line |
| v0.1.3 | PDF full-text injection (`PdfContext` module) | The model only saw your copied notes; everything else was hallucinated from its training memory |
| v0.1.4 | Zotero 9 compatibility | `Zotero.Fulltext.getItemContent` was removed in Zotero 9 — full-text reading always failed. Now reads the `.zotero-ft-cache` file directly |
| v0.1.5 | Whole-document injection + `[page N]` markers | Keyword-based selection fails for cross-language Q&A; page citations were guessed. PDFs ≤50k chars are now attached in full |
| v0.1.6 | Settings page / follow-up memory / BM25 selection | No continuity between questions; poor selection for long documents. Adds Temperature & Max Tokens settings |
| v0.1.7 | Status machine / answer-only budget / Kimi temperature adaptation / native timeout | Dead connections froze `A[running]` forever; reasoning burned the whole token budget; Kimi pins temperature per thinking mode |

## How it works now

```
You type in a note:      Q: What does section 2 claim about COVID?

The note shows:          A[reading]:    ← locates the PDF, reads full text (indexes on first use)
                         A[thinking]:   ← full text + note context + recent Q/A sent to the LLM
                         A[done]: Section 2 (§2, [page 3]) argues that voluntary rapid
                                  deployment "super-charged the rate of discovery" ...
```

- PDFs ≤ 50,000 characters are attached **in full**; larger ones fall back to BM25 chunk selection
- Answers cite real `[page N]` markers instead of guessing
- Follow-ups ("what about section 3?") work via the last 2-3 Q/A pairs from the same note
- Empty/cut-off answers automatically retry once with a doubled budget
- Dead connections abort after 180-240s (scales with the answer budget) instead of hanging forever

## Best suited for

- Zotero 7+ (tested on 9.0.6) with any OpenAI-compatible API (Kimi, DeepSeek, …)
- Asking questions in one language about papers written in another (e.g. Chinese questions, English papers)
- Paragraph/section-level comprehension, term explanation, "quote the original and tell me where it says so"
- Quiet, no-popup reading flow — one question, one call, no chat window

**Not ideal for:** multi-step mathematical reasoning (deep thinking is off by default; re-enable via the `thinking` pref), documents > 50k characters (falls back to selection — pair it with manual excerpts), or agent-style multi-turn browsing.

## Install

1. Download `dist/paper-partner-0.1.7.xpi`
2. Zotero → Tools → Plugins → gear icon → **Install Plugin From File**
3. Restart Zotero

> When upgrading: remove the old version first, restart, then install the new one from file.

## Configuration (Zotero Settings → Paper Partner)

| Setting | Notes |
|---|---|
| API Endpoint | Full chat/completions URL, e.g. `https://api.kimi.com/coding/v1/chat/completions` (Kimi) or `https://api.deepseek.com/v1/chat/completions` (DeepSeek) |
| API Key / Model | From your provider, e.g. model `k3` (Kimi) or `deepseek-chat` |
| Temperature | Only sent to providers that accept it — Kimi pins its own temperature per thinking mode, so this fork omits the field there |
| Max Tokens | Caps the **visible answer** only (Auto = 3000); reasoning headroom is added separately |

## Credits & license

Original idea, design and `target.md` spec by [Sihan Qin](https://github.com/QinSihan) ([upstream repo](https://github.com/QinSihan/zotero-paper-partner)). All changes in this fork are documented commit-by-commit in [CHANGELOG.md](./CHANGELOG.md). Rights to the original project remain with the upstream author; this fork is for personal study and research.
