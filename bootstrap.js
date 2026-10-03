"use strict";

// ============================================================
// CONFIGURATION
// Behavioral constants.
// User-facing settings live in Zotero Preferences.
// ============================================================
const CONFIG = {
    maxContextLength: 2000, // Max chars of context sent to the model
    triggerDelays: {
        immediate: 0,
        short: 1000,
        medium: 2000,
        long: 3000,
    },
};

const PREF_PREFIX = "extensions.paper-partner.";
const PREF_DEFAULTS = {
    apiKey:      "",
    apiEndpoint: "https://api.deepseek.com/v1/chat/completions",
    model:       "deepseek-chat",
    answerMode:  "brief",
    triggerDelay: "medium",
};

/** Read a user-configurable preference, falling back to PREF_DEFAULTS. */
function getPref(key) {
    try {
        const val = Zotero.Prefs.get(PREF_PREFIX + key, true);
        return (val !== undefined && val !== null && val !== "") ? val : PREF_DEFAULTS[key];
    } catch (_) {
        return PREF_DEFAULTS[key];
    }
}

function getAnswerMode() {
    return getPref("answerMode") === "detailed" ? "detailed" : "brief";
}

function getTriggerDelayMs() {
    const delay = getPref("triggerDelay");
    return CONFIG.triggerDelays[delay] || CONFIG.triggerDelays.medium;
}

function getEndpointHost(endpoint) {
    try {
        return new URL(endpoint).host;
    } catch (_) {
        return "invalid-endpoint";
    }
}

let rootURI = "";
const PLUGIN_ID = "paper-partner@qinsihan.github.io";

// ============================================================
// NOTE PARSER
// Turns Zotero note HTML into a flat list of typed paragraphs,
// then finds which Q: questions still need answers.
// ============================================================
const NoteParser = {
    /**
     * Parse note HTML into an array of paragraph descriptors.
     * Each item: { type: "question"|"answer"|"content", index, el, text, status?, content? }
     *
     * Zotero stores notes as HTML (e.g. <div data-schema-version="8"><p>...</p></div>).
     * We parse with DOMParser and walk all <p> elements.
     */
    parse(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html || "", "text/html");
        const paragraphs = Array.from(doc.querySelectorAll("p"));

        return paragraphs.map((el, index) => {
            const text = el.textContent.trim();
            const qMatch = text.match(/^Q:\s*([\s\S]*)/);
            const aMatch = text.match(/^A\[(\w+)\]:([\s\S]*)/);

            if (qMatch) {
                return { type: "question", index, el, text: qMatch[1].trim() };
            } else if (aMatch) {
                return { type: "answer", index, el, status: aMatch[1], content: aMatch[2].trim() };
            } else {
                return { type: "content", index, el, text };
            }
        });
    },

    /**
     * From the parsed item list, return questions that have no following A[...].
     * Each result includes the question text, its local context (paragraphs between
     * this Q and the previous Q/A boundary), and the DOM element for writing back.
     */
    findPending(items) {
        const pending = [];

        for (let i = 0; i < items.length; i++) {
            if (items[i].type !== "question") continue;

            // If this Q is the last paragraph, the user is likely still typing it.
            // Only process once the user has pressed Enter to start a new paragraph.
            if (i === items.length - 1) continue;

            // Look forward: is there already an A[...] before the next Q?
            let hasAnswer = false;
            for (let j = i + 1; j < items.length; j++) {
                if (items[j].type === "question") break;
                if (items[j].type === "answer") { hasAnswer = true; break; }
            }
            if (hasAnswer) continue;

            // Look backward: collect context up to the previous Q or A boundary
            const contextParts = [];
            for (let j = i - 1; j >= 0; j--) {
                if (items[j].type === "question" || items[j].type === "answer") break;
                contextParts.unshift(items[j].text);
            }

            pending.push({
                questionText: items[i].text,
                contextText: contextParts.join("\n").slice(0, CONFIG.maxContextLength),
                el: items[i].el,
            });
        }

        return pending;
    },

    /**
     * A string that captures both the question and its context.
     * Used to detect whether the note changed while we were calling the API.
     */
    fingerprint(questionText, contextText) {
        return questionText + "\x00" + contextText;
    },
};

// ============================================================
// NOTE WRITER
// Inserts or replaces the A[...] paragraph that immediately follows a Q.
// Always re-fetches the note from Zotero before writing to pick up concurrent edits.
// ============================================================
const NoteWriter = {
    _setParagraphText(el, text) {
        el.textContent = "";

        const lines = String(text).split("\n");
        lines.forEach((line, index) => {
            if (index > 0) el.appendChild(el.ownerDocument.createElement("br"));
            el.appendChild(el.ownerDocument.createTextNode(line));
        });
    },

    /**
     * Find the Q paragraph by its full text content, then insert or replace
     * the immediately following A[...] paragraph.
     *
     * @param {Zotero.Item} item         - The note item
     * @param {Element}     questionEl   - The Q paragraph element (used for text matching)
     * @param {string}      status       - pending | running | done | stale | error
     * @param {string}      [content=""] - Answer text (only for "done")
     * @returns {boolean} false if the question paragraph was not found
     */
    async write(item, questionEl, status, content = "") {
        const html = item.getNote();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html || "", "text/html");
        const paragraphs = Array.from(doc.querySelectorAll("p"));

        // Match by full text: "Q: <question text>"
        const fullQText = questionEl.textContent.trim();
        const qEl = paragraphs.find(p => p.textContent.trim() === fullQText);

        if (!qEl) {
            Zotero.debug("[PaperPartner] Could not find Q paragraph to update: " + fullQText.slice(0, 60));
            return false;
        }

        const answerLine = content ? `A[${status}]: ${content}` : `A[${status}]:`;

        // If the next sibling <p> is already an A[...], replace it in-place.
        // Otherwise insert a new paragraph after the Q.
        const next = qEl.nextElementSibling;
        if (next && next.tagName === "P" && /^A\[\w+\]:/.test(next.textContent.trim())) {
            this._setParagraphText(next, answerLine);
        } else {
            const aEl = doc.createElement("p");
            this._setParagraphText(aEl, answerLine);
            qEl.insertAdjacentElement("afterend", aEl);
        }

        item.setNote(doc.body.innerHTML);
        await item.saveTx();
        return true;
    },
};

// ============================================================
// PDF CONTEXT
// Adds the parent item's PDF to the model's context: fetch the
// fulltext (Zotero fulltext index, indexing on demand), score
// chunks against the question + note context, and keep the most
// relevant ones plus the title/abstract region.
// ============================================================
const PdfContext = {
    maxTextChars: 400000,
    maxChars: 4500,
    chunkTarget: 1200,
    maxChunks: 4,

    _asciiStop: new Set(("the and for with this that are was were have has had you your about into from will would can could should "
        + "what when where how why who does did done its his her their there here been being also than then them they which "
        + "these those over under between each other more most some such only very just like make made use used using give "
        + "help please tell explain summarize summary pdf paper article text note notes section part parts figure table").split(" ")),

    _cjkStop: new Set(["什么", "这个", "那个", "哪些", "这些", "那些", "为什", "怎么", "怎样", "可以",
        "我们", "你们", "自己", "就是", "还是", "但是", "可是", "如果", "因为", "所以", "然后",
        "于是", "这样", "那样", "一下", "一些", "以及", "或者", "并且", "而且", "不过", "只是",
        "只有", "所有", "没有", "不能", "已经", "正在", "这里", "那里", "哪个", "每个", "某个"]),

    _terms(s, cap) {
        const terms = [];
        const seen = new Set();
        const lower = String(s || "").toLowerCase();
        for (const w of lower.match(/[a-z][a-z0-9'-]+/g) || []) {
            if (this._asciiStop.has(w) || seen.has(w)) continue;
            seen.add(w);
            terms.push(w);
            if (terms.length >= cap) return terms;
        }
        for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
            for (let i = 0; i < run.length - 1; i++) {
                const bg = run.slice(i, i + 2);
                if (this._cjkStop.has(bg) || seen.has(bg)) continue;
                seen.add(bg);
                terms.push(bg);
                if (terms.length >= cap) return terms;
            }
        }
        return terms;
    },

    _score(chunkLower, terms, weight) {
        let s = 0;
        for (const t of terms) {
            let n = 0, i = 0;
            while ((i = chunkLower.indexOf(t, i)) !== -1) { n++; i += t.length; }
            if (n) s += weight * n;
        }
        return s;
    },

    _chunk(text) {
        const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
        const chunks = [];
        let cur = "";
        for (let p of paras) {
            while (p.length > this.chunkTarget * 2) {
                chunks.push(p.slice(0, this.chunkTarget));
                p = p.slice(this.chunkTarget);
            }
            if (cur && cur.length + p.length + 1 > this.chunkTarget) {
                chunks.push(cur);
                cur = p;
            } else {
                cur = cur ? cur + "\n" + p : p;
            }
        }
        if (cur) chunks.push(cur);
        return chunks;
    },

    async collect(item, questionText, contextText) {
        try {
            const text = await this._getPdfText(item);
            if (!text || text.length < 200) {
                Zotero.debug("[PaperPartner] PDF context: no usable fulltext (chars=" + (text ? text.length : 0) + ")");
                return "";
            }
            const out = this._select(text.slice(0, this.maxTextChars), questionText, contextText);
            Zotero.debug("[PaperPartner] PDF context: source_chars=" + text.length + ", excerpt_chars=" + out.length);
            return out;
        } catch (e) {
            Zotero.debug("[PaperPartner] PDF context unavailable: " + e.message);
            return "";
        }
    },

    async _readFulltextCache(att) {
        const paths = [];
        try { paths.push(Zotero.Fulltext.getItemCacheFile(att).path + ""); } catch (_) {}
        try {
            const p = await att.getFilePathAsync();
            if (p) paths.push(p.replace(/[\\/][^\\/]*$/, "") + "/.zotero-ft-cache");
        } catch (_) {}
        for (const p of paths) {
            try {
                const text = await Zotero.File.getContentsAsync(p);
                if (typeof text === "string" && text.length > 200) return text;
            } catch (_) {}
        }
        return "";
    },

    async _getPdfText(item) {
        const parentID = item.parentID;
        if (!parentID) { Zotero.debug("[PaperPartner] PDF context: note has no parent item"); return ""; }
        const parent = Zotero.Items.get(parentID);
        if (!parent || !parent.isRegularItem || !parent.isRegularItem()) return "";

        let att = null;
        try { att = await parent.getBestAttachment(); } catch (_) {}
        if (!att || att.attachmentContentType !== "application/pdf") {
            try {
                for (const id of await parent.getAttachments()) {
                    const a = Zotero.Items.get(id);
                    if (a && a.isAttachment && a.attachmentContentType === "application/pdf") { att = a; break; }
                }
            } catch (_) {}
        }
        if (!att) { Zotero.debug("[PaperPartner] PDF context: no PDF attachment on the parent item"); return ""; }

        let text = await this._readFulltextCache(att);
        if (!text) {
            try {
                Zotero.debug("[PaperPartner] Indexing PDF for fulltext: attachment " + att.id);
                await Zotero.Fulltext.indexItems([att.id]);
                text = await this._readFulltextCache(att);
            } catch (e) {
                Zotero.debug("[PaperPartner] Fulltext indexing failed: " + e.message);
                return "";
            }
        }
        return (typeof text === "string") ? text : "";
    },

    _select(text, questionText, contextText) {
        const chunks = this._chunk(text);
        if (!chunks.length) return "";
        const qT = this._terms(questionText, 100);
        const cT = this._terms(contextText, 60);

        const scored = chunks.map((c, i) => {
            const cl = c.toLowerCase();
            const s = (this._score(cl, qT, 2) + this._score(cl, cT, 1)) / Math.sqrt(c.length + 1);
            return { i, c, s };
        });

        const picked = [{ i: 0, c: chunks[0] }];
        let total = chunks[0].length;
        const rest = scored.slice(1).sort((a, b) => b.s - a.s);
        for (const r of rest) {
            if (picked.length >= this.maxChunks || r.s <= 0) break;
            if (total + r.c.length > this.maxChars) continue;
            picked.push(r);
            total += r.c.length;
        }
        picked.sort((a, b) => a.i - b.i);
        return picked.map(p => p.c).join("\n\n[...]\n\n");
    },
};

// ============================================================
// API CLIENT
// OpenAI-compatible chat completion. DeepSeek by default.
// ============================================================
const ApiClient = {
    _modes: {
        brief: {
            maxTokens: 1200,
            systemPrompt:
                "You are a quiet reading assistant embedded in a Zotero note. " +
                "Give a compact answer that can be inserted directly below the user's question. " +
                "Explain only the exact term, sentence, or local claim being asked about. " +
                "Use the provided local note excerpt when it helps. " +
                "Do not add broad background, related work, long summaries, bullet lists, or follow-up suggestions.",
            userInstruction:
                "Answer in 1-3 short sentences. Stay local to the question and the provided local note excerpt. " +
                "The local note excerpt may be truncated to 2000 characters. Keep your answer within 300 output tokens.",
        },
        detailed: {
            maxTokens: 3000,
            systemPrompt:
                "You are a careful academic reading assistant embedded in a Zotero note. " +
                "Help the reader genuinely understand the specific point they asked about. " +
                "You may explain the relevant concept, mechanism, causal relationship, and assumptions, using the same local note excerpt provided for this question. " +
                "Format detailed answers with visible paragraph breaks so they remain easy to scan inside a note. " +
                "Do not drift into a full paper summary, broad literature review, or unrelated background.",
            userInstruction:
                "Answer in 2-4 short paragraphs separated by a blank line. " +
                "Use a brief list only if it makes the explanation clearer, and keep list items short. " +
                "Explain the idea more fully while staying anchored to this question and the provided local note excerpt. " +
                "The local note excerpt may be truncated to 2000 characters. Keep your answer within 1500 output tokens.",
        },
    },

    _buildMessages(questionText, contextText, mode, pdfExcerpts) {
        const config = this._modes[mode] || this._modes.brief;
        const userMessage = contextText
            ? `Context from my reading notes:\n${contextText}\n\nQuestion: ${questionText}`
            : `Question: ${questionText}`;

        return {
            maxTokens: config.maxTokens,
            instruction: config.userInstruction,
            messages: [
                { role: "system", content: config.systemPrompt },
                { role: "user", content: config.userInstruction },
                ...(pdfExcerpts ? [{
                    role: "user",
                    content: "Excerpts from the PDF that this note is attached to (selected automatically; may be incomplete):\n\n"
                        + pdfExcerpts
                        + "\n\nUse these excerpts when they help answer the question. If the answer is not in them, say so from general knowledge without claiming the PDF contains it.",
                }] : []),
                { role: "user", content: userMessage },
            ],
        };
    },

    _normalizeContent(content) {
        if (typeof content === "string") return content.trim();
        if (Array.isArray(content)) {
            return content
                .map(part => {
                    if (typeof part === "string") return part;
                    if (part && typeof part.text === "string") return part.text;
                    if (part && typeof part.content === "string") return part.content;
                    return "";
                })
                .join("")
                .trim();
        }
        return "";
    },

    _summarizeChoice(choice) {
        if (!choice) return "choice=missing";
        const message = choice.message || {};
        const content = message.content;
        const contentType = Array.isArray(content) ? "array" : typeof content;
        return [
            "finish_reason=" + (choice.finish_reason || "unknown"),
            "message_keys=" + Object.keys(message).join("|"),
            "content_type=" + contentType,
            "content_length=" + (typeof content === "string" ? content.length : 0),
        ].join(", ");
    },

    async query(questionText, contextText, pdfExcerpts) {
        const endpoint = getPref("apiEndpoint");
        const model = getPref("model");
        const mode = getAnswerMode();
        const request = this._buildMessages(questionText, contextText, mode, pdfExcerpts);

        Zotero.debug(
            "[PaperPartner] API request: host=" + getEndpointHost(endpoint) +
            ", model=" + model +
            ", mode=" + mode +
            ", max_tokens=" + request.maxTokens +
            ", instruction_length=" + request.instruction.length +
            ", message_count=" + request.messages.length +
            ", pdf_excerpt_chars=" + (pdfExcerpts ? pdfExcerpts.length : 0)
        );

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${getPref("apiKey")}`,
            },
            body: JSON.stringify({
                model,
                messages: request.messages,
                max_tokens: request.maxTokens,
                temperature: 1,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            Zotero.debug(
                "[PaperPartner] API HTTP error: host=" + getEndpointHost(endpoint) +
                ", model=" + model +
                ", status=" + response.status +
                ", body=" + body.slice(0, 500)
            );
            throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        }

        let data;
        try {
            data = await response.json();
        } catch (e) {
            Zotero.debug(
                "[PaperPartner] API JSON parse error: host=" + getEndpointHost(endpoint) +
                ", model=" + model +
                ", status=" + response.status +
                ", error=" + e.message
            );
            throw new Error("Invalid JSON from API");
        }

        const choice = data && data.choices && data.choices[0];
        const message = choice && choice.message;
        const content = message ? this._normalizeContent(message.content) : "";
        const finishReason = choice && choice.finish_reason ? choice.finish_reason : "unknown";

        if (!content) {
            Zotero.debug(
                "[PaperPartner] Empty API response: host=" + getEndpointHost(endpoint) +
                ", model=" + model +
                ", status=" + response.status +
                ", " + this._summarizeChoice(choice)
            );
            throw new Error("Empty response from API (finish_reason=" + finishReason + ")");
        }

        if (finishReason === "length") {
            Zotero.debug(
                "[PaperPartner] API response was cut off: host=" + getEndpointHost(endpoint) +
                ", model=" + model +
                ", status=" + response.status +
                ", " + this._summarizeChoice(choice)
            );
            throw new Error("Response was cut off by the token limit (finish_reason=length)");
        }

        Zotero.debug(
            "[PaperPartner] API response OK: host=" + getEndpointHost(endpoint) +
            ", model=" + model +
            ", status=" + response.status +
            ", finish_reason=" + finishReason +
            ", content_length=" + content.length
        );

        return content;
    },
};

// ============================================================
// TASK QUEUE
// Per-note debounce + global serial execution.
// One note is processed at a time; multiple notes queue up in order.
// ============================================================
const TaskQueue = {
    _debounceTimers: new Map(), // noteId → timer handle
    _queue: [],                 // noteIds waiting to be processed
    _processing: false,

    /** Called when a note is modified. Resets the debounce window. */
    schedule(itemId) {
        const existing = this._debounceTimers.get(itemId);
        if (existing) clearTimeout(existing);

        const delayMs = getTriggerDelayMs();
        const timer = setTimeout(() => {
            this._debounceTimers.delete(itemId);
            this._enqueue(itemId);
        }, delayMs);

        this._debounceTimers.set(itemId, timer);
        Zotero.debug("[PaperPartner] Scheduled note " + itemId + " in " + delayMs + "ms.");
    },

    _enqueue(itemId) {
        if (this._queue.includes(itemId)) return; // Already waiting
        this._queue.push(itemId);
        if (!this._processing) this._drain();
    },

    async _drain() {
        if (this._queue.length === 0) { this._processing = false; return; }
        this._processing = true;

        const itemId = this._queue.shift();
        try {
            await processNote(itemId);
        } catch (e) {
            Zotero.debug("[PaperPartner] Unhandled error for note " + itemId + ": " + e.message);
        }

        // Process next item (call synchronously to avoid deep recursion via setTimeout)
        this._drain();
    },

    /** Cancel all pending timers and flush the queue. Called on plugin shutdown. */
    clear() {
        for (const t of this._debounceTimers.values()) clearTimeout(t);
        this._debounceTimers.clear();
        this._queue.length = 0;
        this._processing = false;
    },
};

// ============================================================
// CORE PROCESSING
// For each unanswered Q in a note, drives the full pending→running→done flow.
// ============================================================
async function processNote(itemId) {
    if (!getPref("apiKey")) {
        Zotero.debug("[PaperPartner] API key not set — configure in Zotero Preferences → Paper Partner.");
        return;
    }

    const item = Zotero.Items.get(itemId);
    if (!item || !item.isNote()) return;

    Zotero.debug("[PaperPartner] Scanning note " + itemId);

    const items = NoteParser.parse(item.getNote());
    const pending = NoteParser.findPending(items);

    if (pending.length === 0) {
        Zotero.debug("[PaperPartner] No unanswered questions, done.");
        return;
    }

    Zotero.debug("[PaperPartner] " + pending.length + " unanswered question(s) found.");

    for (const q of pending) {
        await processQuestion(item, q);
    }
}

async function processQuestion(item, q) {
    const { questionText, contextText, el } = q;
    const fp = NoteParser.fingerprint(questionText, contextText);

    Zotero.debug("[PaperPartner] → Q: " + questionText.slice(0, 80));

    // ① Mark as running (API call about to start)
    await NoteWriter.write(item, el, "running");

    // ② Call the model
    let answer;
    try {
        const pdfExcerpts = await PdfContext.collect(item, questionText, contextText);
        answer = await ApiClient.query(questionText, contextText, pdfExcerpts);
    } catch (e) {
        Zotero.debug("[PaperPartner] API error: " + e.message);
        await NoteWriter.write(item, el, "error", e.message.slice(0, 120));
        return;
    }

    // ③ Consistency check: re-parse the note and verify Q + context haven't changed.
    //    If the user edited the question or its surrounding text while we were waiting,
    //    the answer is no longer valid — mark stale instead of writing garbage back.
    const freshItems = NoteParser.parse(item.getNote());
    const freshQ = freshItems.find(it => it.type === "question" && it.text === questionText);

    if (!freshQ) {
        Zotero.debug("[PaperPartner] Question was removed while processing, skipping.");
        return;
    }

    const freshContextParts = [];
    for (let j = freshQ.index - 1; j >= 0; j--) {
        if (freshItems[j].type === "question" || freshItems[j].type === "answer") break;
        freshContextParts.unshift(freshItems[j].text);
    }
    const freshContext = freshContextParts.join("\n").slice(0, CONFIG.maxContextLength);

    if (NoteParser.fingerprint(questionText, freshContext) !== fp) {
        Zotero.debug("[PaperPartner] Context changed during processing, marking stale.");
        await NoteWriter.write(item, freshQ.el, "stale", "Context changed while processing. Edit this question again to reprocess.");
        return;
    }

    // ④ Write the answer back
    await NoteWriter.write(item, freshQ.el, "done", answer);
    Zotero.debug("[PaperPartner] ✓ Answer written for: " + questionText.slice(0, 80));
}

// ============================================================
// NOTIFIER OBSERVER
// Listens for item modifications and routes notes to the task queue.
// ============================================================
let _observerID = null;

function registerObserver() {
    _observerID = Zotero.Notifier.registerObserver(
        {
            notify(event, type, ids /*, extraData */) {
                if (type !== "item" || event !== "modify") return;
                for (const id of ids) {
                    const item = Zotero.Items.get(id);
                    if (item && item.isNote()) {
                        TaskQueue.schedule(id);
                    }
                }
            },
        },
        ["item"],
        "paper-partner"
    );
    Zotero.debug("[PaperPartner] Observer registered (id=" + _observerID + ")");
}

function unregisterObserver() {
    if (_observerID !== null) {
        Zotero.Notifier.unregisterObserver(_observerID);
        _observerID = null;
    }
}

// ============================================================
// PLUGIN LIFECYCLE
// ============================================================
function install(data, reason) {
    Zotero.debug("[PaperPartner] install");
}

function startup(data, reason) {
    Zotero.debug("[PaperPartner] startup");
    rootURI = data.rootURI;

    Zotero.initializationPromise.then(() => {
        // All prefs logic is inline in the onload of prefs.xhtml — no scripts array needed.
        try {
            Zotero.PreferencePanes.register({
                pluginID: PLUGIN_ID,
                src:      rootURI + "prefs.xhtml",
                label:    "Paper Partner",
            });
            Zotero.debug("[PaperPartner] Preferences pane registered.");
        } catch (e) {
            Zotero.debug("[PaperPartner] PreferencePanes.register failed: " + e.message);
        }

        registerObserver();
        Zotero.debug("[PaperPartner] Ready.");
    });
}

function shutdown(data, reason) {
    Zotero.debug("[PaperPartner] shutdown");
    try { Zotero.PreferencePanes.unregister(PLUGIN_ID); } catch (_) {}
    unregisterObserver();
    TaskQueue.clear();
}

function uninstall(data, reason) {
    Zotero.debug("[PaperPartner] uninstall");
}
