// ==UserScript==
// @name         WhatsApp Web 翻译助手
// @namespace    wa-translate
// @version      4.2.0
// @description  中文→多国语言：按客户自动识别语种，输入框一键翻译+发送；划词翻译。零依赖，不装服务。
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      clients5.google.com
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      open.bigmodel.cn
// @connect      dashscope.aliyuncs.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    console.log('[WA翻译助手] v4.2.0 启动');

    var STATE_IDLE = 0, STATE_READY = 1;
    var state = STATE_IDLE;
    var lastTranslated = '';

    /* ================= 语言表 ================= */
    // code = 翻译接口用的代码；short = 按钮上显示的 2 字母
    var LANGS = [
        ['en', 'English 英语', 'EN'],
        ['es', 'Español 西班牙语', 'ES'],
        ['pt', 'Português 葡萄牙语', 'PT'],
        ['ru', 'Русский 俄语', 'RU'],
        ['fr', 'Français 法语', 'FR'],
        ['de', 'Deutsch 德语', 'DE'],
        ['it', 'Italiano 意大利语', 'IT'],
        ['ar', 'العربية 阿拉伯语', 'AR'],
        ['tr', 'Türkçe 土耳其语', 'TR'],
        ['id', 'Bahasa Indonesia 印尼语', 'ID'],
        ['vi', 'Tiếng Việt 越南语', 'VI'],
        ['th', 'ไทย 泰语', 'TH'],
        ['pl', 'Polski 波兰语', 'PL'],
        ['nl', 'Nederlands 荷兰语', 'NL'],
        ['fa', 'فارسی 波斯语', 'FA'],
        ['he', 'עברית 希伯来语', 'HE'],
        ['hi', 'हिन्दी 印地语', 'HI'],
        ['ja', '日本語 日语', 'JA'],
        ['ko', '한국어 韩语', 'KO'],
        ['ms', 'Bahasa Melayu 马来语', 'MS'],
        ['uk', 'Українська 乌克兰语', 'UK'],
        ['ro', 'Română 罗马尼亚语', 'RO'],
        ['el', 'Ελληνικά 希腊语', 'EL'],
        ['sv', 'Svenska 瑞典语', 'SV'],
        ['ca', 'Català 加泰罗尼亚语', 'CA'],
        ['zh-CN', '中文 简体', 'ZH']
    ];
    function langShort(c) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === c) return LANGS[i][2]; return (c || '?').toUpperCase(); }
    function langName(c) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === c) return LANGS[i][1]; return c; }

    /* ================= 配置持久化 ================= */
    var S = Object.assign({
        txMode: 'auto',        // auto = 跟随客户语言；否则固定为某语言
        defaultLang: 'en',     // 识别不出时用
        chatLang: {},          // chatKey -> { lang, manual }
        sendAfter: true,       // 译完按回车即发送（沿用 v3.16）
        aiOn: false,           // 可选：用 AI 翻译（更准，需 Key）
        aiBase: 'https://api.deepseek.com/v1',
        aiKey: '',
        aiModel: 'deepseek-chat'
    }, GM_getValue('cfg4', {}) || {});
    function saveCfg() { GM_setValue('cfg4', S); }

    /* ================= 翻译接口 ================= */
    function gmGet(url, timeout) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET', url: url, timeout: timeout || 10000,
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject('HTTP ' + r.status);
                },
                onerror: function () { reject('网络错误'); },
                ontimeout: function () { reject('超时'); }
            });
        });
    }
    function gmPostForm(url, body, timeout) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'POST', url: url, timeout: timeout || 8000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: body,
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject('HTTP ' + r.status);
                },
                onerror: function () { reject('网络错误'); },
                ontimeout: function () { reject('超时'); }
            });
        });
    }
    function gmPostJson(url, body, headers) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'POST', url: url, timeout: 60000,
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
                data: JSON.stringify(body),
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject('HTTP ' + r.status + ' ' + String(r.responseText).slice(0, 120));
                },
                onerror: function () { reject('网络错误'); },
                ontimeout: function () { reject('超时'); }
            });
        });
    }
    function parseDict(json) {
        var j = JSON.parse(json);
        var seg = (j && j[0]) || [];
        if (typeof seg === 'string') return seg;
        var out = '';
        for (var i = 0; i < seg.length; i++) {
            var item = seg[i];
            if (typeof item === 'string') {
                // 末尾的 "zh-CN"/"pt" 是接口返回的原文语种标记，不是译文，丢掉
                if (i === seg.length - 1 && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(item)) continue;
                out += item;
            } else if (item && item[0]) {
                out += item[0];
            }
        }
        out = out.trim();
        if (!out) throw new Error('empty');
        return out;
    }
    // MyMemory 出错时同样返回 HTTP 200，把错误文案塞进 translatedText，
    // 例如 en|en 会返回 "PLEASE SELECT TWO DISTINCT LANGUAGES" —— 必须识别成失败，不能当译文用
    var MM_ERR = /PLEASE SELECT TWO DISTINCT LANGUAGES|IS AN INVALID SOURCE LANGUAGE|INVALID (SOURCE|TARGET) LANGUAGE|MYMEMORY WARNING|TOO MANY REQUESTS|NO QUERY SPECIFIED/i;
    function parseMM(json) {
        var j = JSON.parse(json);
        var t = j.responseData && j.responseData.translatedText;
        if (!t) throw new Error('mymemory:empty');
        if (MM_ERR.test(t)) throw new Error('mymemory:' + String(t).slice(0, 60));
        return t;
    }
    // Google 另一个端点（translate_a/single），比 clients5 稳、支持长文本，作为首选
    function parseSingle(r) {
        var j = JSON.parse(r), seg = j && j[0];
        if (!Array.isArray(seg)) throw new Error('single:bad');
        var out = '';
        for (var i = 0; i < seg.length; i++) { if (seg[i] && seg[i][0]) out += seg[i][0]; }
        out = out.trim();
        if (!out) throw new Error('single:empty');
        return out;
    }
    function gSingle(text, sl, tl) {
        return gmPostForm('https://translate.googleapis.com/translate_a/single',
            'client=gtx&sl=' + sl + '&tl=' + tl + '&dt=t&q=' + encodeURIComponent(text), 6000)
            .then(parseSingle);
    }
    // 同一端点的 GET 版：某些代理/网络下 POST 会被打断，GET 往往还能通
    function gSingleGet(text, sl, tl) {
        return gmGet('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' + sl + '&tl=' + tl +
            '&q=' + encodeURIComponent(text), 5000).then(parseSingle);
    }
    // 译文内存缓存：同一段文字反复点"译"不再重新请求（最多 200 条）
    var mtCache = {}, mtKeys = [];
    function mtCached(k, v) {
        if (mtCache[k] === undefined) {
            mtCache[k] = v; mtKeys.push(k);
            if (mtKeys.length > 200) { delete mtCache[mtKeys.shift()]; }
        }
        return mtCache[k];
    }
    // 免费机翻：Google POST → Google GET → clients5 → MyMemory
    // Google 连续失败时进入 60 秒"短路"，直接走 MyMemory，避免每次点译都白等三遍
    var googleDownUntil = 0;
    function mtViaGoogle(text, sl, tl, q) {
        return gSingle(text, sl, tl)
            .catch(function () { return gSingleGet(text, sl, tl); })
            .catch(function () {
                return gmGet('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + sl + '&tl=' + tl + '&q=' + q, 3500).then(parseDict);
            })
            .then(function (res) { googleDownUntil = 0; return res; })
            .catch(function (err) { googleDownUntil = Date.now() + 60000; throw err; });
    }
    function mtViaMyMemory(text, q, src, tl, err1) {
        // 兜底源语正好等于目标语时不再发 en|en 那种必错请求（那正是 PLEASE SELECT 的来源）
        if (src === tl) return text;
        return gmGet('https://api.mymemory.translated.net/get?q=' + q + '&langpair=' + src + '|' + tl, 6000)
            .then(parseMM)
            .catch(function (err2) {
                throw new Error(String(err1 || '').slice(0, 40) + ' / ' + String(err2).slice(0, 60));
            });
    }
    function mtTranslate(text, sl, tl) {
        var q = encodeURIComponent(text);
        var ck = sl + '|' + tl + '|' + text;
        if (mtCache[ck] !== undefined) return Promise.resolve(mtCache[ck]);
        // 明确同语种 → 不翻译
        var det = (sl && sl !== 'auto') ? sl : detectLang([text]);
        if (det && det === tl) return Promise.resolve(text);
        // 判定不出来不再直接报「源语种无法判定」：划词/收信场景绝大多数是英文，按英文算即可
        var src = det || 'en';
        var google = (Date.now() < googleDownUntil)
            ? Promise.reject(new Error('Google 暂不可用'))
            : mtViaGoogle(text, sl, tl, q);
        return google
            .catch(function (err1) { return mtViaMyMemory(text, q, src, tl, err1); })
            .then(function (res) { return mtCached(ck, res); });
    }
    // 可选：AI 翻译（外贸术语更准）
    function aiTranslate(text, tl) {
        var sys = '你是专业外贸翻译。把用户文本翻译成 ' + langName(tl) + '(' + tl + ')。' +
            '只输出译文本身，不要解释、不要引号；数字、规格型号(M10x1.5/DIN 933/SS304)、单位、货币、URL、邮箱保持原样；' +
            '语气按商务习惯，简洁专业。五金紧固件术语要准确：六角螺栓=hex bolt，螺母=nut，垫圈=washer，牙条=threaded rod，' +
            '铆钉=rivet，销=pin，喉箍=hose clamp，管夹=pipe clamp，镀锌=zinc plated，不锈钢304=SS304。';
        return gmPostJson(S.aiBase.replace(/\/+$/, '') + '/chat/completions', {
            model: S.aiModel || 'deepseek-chat',
            temperature: 0.2,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: text }]
        }, { 'Authorization': 'Bearer ' + S.aiKey }).then(function (r) {
            var j = JSON.parse(r);
            var out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!out) throw new Error('AI 返回为空');
            return out.trim();
        });
    }
    function translateSmart(text, tl) {
        if (S.aiOn && S.aiKey) {
            return aiTranslate(text, tl).catch(function (e) {
                console.warn('[WA翻译助手] AI 翻译失败，退回机翻:', e);
                return mtTranslate(text, 'auto', tl);
            });
        }
        return mtTranslate(text, 'auto', tl);
    }

    /* ================= 会话语种识别（纯本地） ================= */
    var STOP = {
        es: 'el los las del al una pero muy gracias necesito cuanto precio quiero piezas hola buenos dias senor tambien donde cual tienes ocupo',
        pt: 'os as um uma nao obrigado preco ola preciso voce qual quanto pecas gostaria bom dia tudo tambem onde',
        fr: 'le la les de des du que et en un une pour par avec est ne pas ce qui au bonjour merci prix besoin',
        de: 'der die das und ist nicht ein eine fur mit von den zu sich auf dem preis bitte danke brauche',
        it: 'il lo la gli le di che e in un una per con del al non si come piu grazie prezzo ho bisogno',
        nl: 'de het een en van is niet voor met dat op te zijn prijs bedankt alstublieft',
        en: 'the and is are for with you we can this that have please price thanks would your need send',
        tr: 've bir bu icin ile degil var fiyat tesekkur lutfen ne kadar lazim merhaba',
        id: 'dan yang di ini itu untuk dengan tidak saya kami harga terima kasih butuh',
        pl: 'i w na z do nie jest to ze sie dla cena dziekuje prosze potrzebuje',
        vi: 'va cua la cho khong co gia cam on bao nhieu can',
        ro: 'si in de la cu nu este pentru pret multumesc va rog',
        sv: 'och att det som ar for med inte jag pris tack behover',
        ca: 'els amb gratis preu aquest aquesta molt tambe gracies vull'
    };
    function deaccent(s) {
        try {
            return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[ıİ]/g, 'i').replace(/ł/g, 'l').replace(/đ|ð/g, 'd').replace(/ß/g, 'ss');
        } catch (e) { return s; }
    }
    function wordTokens(t) { return (deaccent(t.toLowerCase()).match(/[a-z]+/g) || []); }

    // texts: 该会话最近若干条"对方"消息
    function detectLang(texts) {
        var blob = (texts || []).join(' ').toLowerCase();
        if (!blob) return null;
        if (/[\u4e00-\u9fff]/.test(blob)) return 'zh-CN';
        if (/[\u3040-\u30ff]/.test(blob)) return 'ja';
        if (/[\uac00-\ud7af]/.test(blob)) return 'ko';
        if (/[\u0600-\u06ff]/.test(blob)) return /[\u06a9\u06cc\u067e\u0686\u0698\u06af]/.test(blob) ? 'fa' : 'ar';
        if (/[\u0590-\u05ff]/.test(blob)) return 'he';
        if (/[\u0e00-\u0e7f]/.test(blob)) return 'th';
        if (/[\u0900-\u097f]/.test(blob)) return 'hi';
        if (/[\u0370-\u03ff]/.test(blob)) return 'el';
        if (/[\u0400-\u04ff]/.test(blob)) {
            // 乌克兰语特征字母
            if (/[іїєґ]/.test(blob)) return 'uk';
            return 'ru';
        }
        var words = wordTokens(blob);
        if (!words.length) return null;
        // 统计每个词出现在几个语种表里：只有"独占词"才算有效证据，避免 de/do/la 这类多语共用词带偏
        var pools = {};
        for (var code in STOP) pools[code] = STOP[code].split(' ');
        var seen = {};
        for (var code2 in pools) {
            for (var wi = 0; wi < pools[code2].length; wi++) {
                var w = pools[code2][wi];
                if (!seen[w]) seen[w] = [];
                if (seen[w].indexOf(code2) < 0) seen[w].push(code2);
            }
        }
        var best = null, bestHit = 0;
        for (var code3 in pools) {
            var hit = 0;
            for (var i = 0; i < words.length; i++) {
                var owners = seen[words[i]];
                if (owners && owners.length === 1 && owners[0] === code3) hit++;
            }
            if (hit > bestHit) { best = code3; bestHit = hit; }
        }
        if (!best || bestHit === 0) return null;      // 认不出就别乱设
        return best;
    }

    /* ================= WhatsApp 上下文 ================= */
    function chatKey() {
        var n = document.querySelector('#main [data-id^="false_"], #main [data-id^="true_"]');
        if (n) {
            var p = (n.getAttribute('data-id') || '').split('_');
            if (p.length >= 3 && /@/.test(p[1])) return p[1];
        }
        var t = document.querySelector('#main header span[title]');
        return t ? 'title:' + t.getAttribute('title') : 'unknown';
    }
    // 消息节点：四层兜底，任何版式的 WhatsApp 都能取到（排除输入框里的草稿）
    function inComposer(el) {
        try { return !!(el.closest && el.closest('footer')); } catch (e) { return false; }
    }
    // 兜底判断「这是我发的」：气泡靠右 = 我方；靠左 = 客户
    function isOutgoing(el) {
        try {
            var row = el.closest('[data-id]') || el.closest('div[role="row"]') || el;
            var main = document.querySelector('#main');
            if (!row || !main || !row.getBoundingClientRect) return false;
            var r = row.getBoundingClientRect(), m = main.getBoundingClientRect();
            if (!r.width || !m.width) return false;
            return (r.left + r.width / 2) > (m.left + m.width / 2);
        } catch (e) { return false; }
    }
    function msgSource() {
        var a = document.querySelectorAll('#main [data-id^="false_"]');
        if (a.length) return a;
        a = document.querySelectorAll('#main .message-in');
        if (a.length) return a;
        var raw = document.querySelectorAll('#main .selectable-text');
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            if (!inComposer(raw[i]) && !isOutgoing(raw[i])) out.push(raw[i]);
        }
        if (out.length) return out;
        var rows = document.querySelectorAll('#main div[role="row"]');
        for (var j = 0; j < rows.length; j++) {
            if (!inComposer(rows[j]) && !isOutgoing(rows[j])) out.push(rows[j]);
        }
        return out;
    }
    function stripNoise(s) {
        return (s || '')
            .replace(/\d{1,2}:\d{2}(\s*[APap][Mm])?/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function isJunk(t) {
        return /end-to-end encrypted|Messages and calls|Learn more|deleted this message|waiting for this message|已加密|端到端/i.test(t);
    }
    function incomingTexts(n) {
        var arr = [], nodes = msgSource();
        for (var i = Math.max(0, nodes.length - (n || 8)); i < nodes.length; i++) {
            var box = nodes[i].querySelector ? (nodes[i].querySelector('.selectable-text') || nodes[i]) : nodes[i];
            var t = stripNoise(box.innerText || box.textContent || '');
            if (t.length > 2 && !isJunk(t)) arr.push(t);
        }
        return arr;
    }
    var lastKey = '', lastSig = '';
    function refreshChatLang() {
        var k = chatKey();
        var cur = S.chatLang[k];
        var nodes = msgSource();
        var tail = nodes.length ? stripNoise((nodes[nodes.length - 1].innerText || '')).slice(0, 80) : '';
        var sig = k + '#' + nodes.length + '#' + tail;
        if (sig === lastSig) return;
        if (k !== lastKey) {                    // 切会话：清掉上一会话的"可回车发送"状态
            state = STATE_IDLE;
            lastTranslated = '';
            paintBtn();
        }
        lastKey = k; lastSig = sig;
        if (cur && cur.manual) return;          // 手动指定过就不自动改
        var lang = detectLang(incomingTexts(12));
        if (!lang) return;
        if (!cur || cur.lang !== lang) {
            S.chatLang[k] = { lang: lang, manual: false };
            saveCfg();
            paintBtn();
        }
    }

    // 当前该发什么语言
    function targetLang() {
        if (S.txMode !== 'auto') return S.txMode;
        var c = S.chatLang[chatKey()];
        return (c && c.lang) || S.defaultLang;
    }

    /* ================= 输入框定位 ================= */
    function findEditor() {
        // 只在"可见"的编辑器里找：发图片/视频时聊天输入框仍在 DOM 里但已隐藏，
        // 旧写法会抓到那个隐藏框 → 点"译"只提示"输入框为空"。
        var list = document.querySelectorAll('[contenteditable="true"]'), vis = [];
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (el.getAttribute('contenteditable') !== 'true') continue;
            var r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            var st = null;
            try { st = window.getComputedStyle(el); } catch (e) {}
            if (st && (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0')) continue;
            if (el.closest('[aria-hidden="true"]')) continue;
            vis.push(el);
        }
        if (!vis.length) return null;
        // 1) 正在编辑的那个（图片说明文字框就是靠这条命中）
        var ae = document.activeElement;
        if (ae && ae.getAttribute && ae.getAttribute('contenteditable') === 'true' && vis.indexOf(ae) >= 0) return ae;
        var sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount && sel.anchorNode) {
            var host = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
            var ce = host && host.closest ? host.closest('[contenteditable="true"]') : null;
            if (ce && vis.indexOf(ce) >= 0) return ce;
        }
        // 2) 常规聊天输入框
        var f = document.querySelector('#main footer');
        if (f) { for (var j = 0; j < vis.length; j++) if (f.contains(vis[j])) return vis[j]; }
        // 3) 兜底：最后一个可见的（媒体预览层挂在 DOM 末尾）
        return vis[vis.length - 1];
    }

    /* ================= 替换输入框内容（Lexical 注入，沿用 v3.16 验证过的链路） ================= */
    function curText() { var l = findEditor(); return l ? ((l.innerText || '').trim()) : ''; }
    function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function countOf(hay, needle) { var n = 0, i = hay.indexOf(needle); while (i > -1) { n++; i = hay.indexOf(needle, i + needle.length); } return n; }
    function isTarget(oldText, newText) {
        var it = curText();
        if (!it) return false;
        if (norm(it).indexOf(norm(oldText)) > -1) return false;
        return countOf(norm(it), norm(newText)) === 1;
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function syncSelection(editor) {
        document.execCommand('selectAll', false, null);
        try {
            var r = document.createRange(); r.selectNodeContents(editor);
            var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        } catch (e) {}
        editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
        editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        editor.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
        editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    }
    function pasteInto(editor, text) {
        var dt = new DataTransfer();
        dt.setData('text', text); dt.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    async function replaceEditorText(editor, newText, oldText) {
        if (isTarget(oldText, newText)) return true;
        for (var round = 0; round < 2; round++) {
            var l = findEditor(); if (!l) return false;
            try { l.focus(); } catch (e) {}
            try { syncSelection(l); } catch (e) {}
            try {
                l.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true,
                    bubbles: true, cancelable: true, composed: true
                }));
            } catch (e) {}
            try { pasteInto(findEditor() || l, newText); } catch (e) {}
            await sleep(300);
            if (isTarget(oldText, newText)) return true;
            var now = curText();
            if (now && countOf(norm(now), norm(newText)) === 1) return true;
            try { var l2 = findEditor(); if (l2) l2.textContent = ''; } catch (e) {}
            await sleep(250);
        }
        return isTarget(oldText, newText);
    }
    function trustedPaste() {
        try {
            var el = findEditor(); if (!el) return false;
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('paste');
            return true;
        } catch (e) { return false; }
    }

    /* ================= 发送 ================= */
    function isVis(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
        var st = null;
        try { st = window.getComputedStyle(el); } catch (e) {}
        if (st && (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0')) return false;
        return true;
    }
    function findSendIcon() {
        // 发图片时聊天输入区的发送键还在 DOM 里但已隐藏，必须取"看得见"的那个
        var list = document.querySelectorAll('span[data-icon="wds-ic-send-filled"], span[data-icon="send"]');
        for (var i = list.length - 1; i >= 0; i--) if (isVis(list[i])) return list[i];
        return null;
    }
    function sendMessage() {
        var icon = findSendIcon();
        if (icon) { var b = icon.closest('button'); if (b) { b.click(); return true; } }
        var aria = document.querySelector('button[aria-label="发送"], button[aria-label="Send"]');
        if (aria) { aria.click(); return true; }
        var ed = findEditor();
        if (ed) {
            ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            ed.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            return true;
        }
        return false;
    }

    /* ================= 按钮 ================= */
    // 两个按钮装进同一个 flex 容器：间距与垂直对齐交给浏览器排版，
    // 不再用 JS 各算各的 left/top（图片预览里发送键尺寸不同就会各漂各的）
    var dock = document.createElement('div');
    dock.id = 'wa-tr-dock';
    dock.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:none;align-items:center;gap:8px;';
    var btn = document.createElement('div');
    btn.id = 'wa-tr-btn';
    var dup = document.getElementById('wa-tr-btn'); if (dup) dup.remove();
    btn.style.cssText = 'position:relative;background:#008069;color:#fff;font:700 15px -apple-system,sans-serif;width:42px;height:42px;border-radius:50%;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none;text-align:center;box-sizing:border-box;display:flex;padding:0;overflow:hidden;flex-direction:column;align-items:center;justify-content:center;flex:0 0 42px;';
    function setBtn(t, bg) {                  // 闪提示用（长文案，自动缩小）
        btn.innerHTML = '<b style="font:700 10px/1.15 -apple-system,sans-serif;font-weight:700;"></b>';
        btn.firstChild.textContent = t;
        btn.style.background = bg || '#008069';
    }
    function setBtnLang(code, bg) {           // 正常两行：译 / 语种
        btn.innerHTML = '<b style="font:700 15px/1 -apple-system,sans-serif;">译</b>' +
            '<i style="font:700 9px/1.3 -apple-system,sans-serif;font-style:normal;opacity:.92;letter-spacing:.3px;"></i>';
        btn.lastChild.textContent = code || '';
        btn.style.background = bg || '#008069';
    }
    function paintBtn() {
        if (S.txMode !== 'auto') { setBtnLang(langShort(S.txMode), '#008069'); return; }
        var c = S.chatLang[chatKey()];
        if (c && c.lang) setBtnLang(langShort(c.lang), '#008069');
        else setBtnLang('AUTO', '#64748b');
    }

    // 语言选择小按钮（圆形，和"译"同尺寸；大倒三角，一眼看出是下拉）
    var langBtn = document.createElement('div');
    langBtn.id = 'wa-tr-lang';
    langBtn.title = '选择目标语言';
    langBtn.style.cssText = 'position:relative;background:#1f2c33;' +
        'color:#fff;width:42px;height:42px;border-radius:50%;' +
        'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none;box-sizing:border-box;' +
        'display:flex;padding:0;align-items:center;justify-content:center;flex:0 0 42px;' +
        'transition:transform .12s ease, filter .12s ease;';
    langBtn.innerHTML =
        '<span id="wa-tr-tri" style="display:flex;align-items:center;justify-content:center;line-height:0;transition:transform .16s ease;">' +
        '<svg width="22" height="15" viewBox="0 0 22 15" aria-hidden="true">' +
        '<path d="M11 14.2 L1.6 2.4 A1.9 1.9 0 0 1 3.4 1.1 L18.6 1.1 A1.9 1.9 0 0 1 20.4 2.4 Z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>' +
        '</svg></span>';
    // 三角元素在 langBtn.querySelector('#wa-tr-tri')（开合时翻转 180°）
    langBtn.onmouseenter = function () { langBtn.style.filter = 'brightness(1.18)'; };
    langBtn.onmouseleave = function () { langBtn.style.filter = ''; };
    langBtn.onmousedown = function (e) { if (e) e.preventDefault(); langBtn.style.transform = 'scale(.92)'; };
    langBtn.onmouseup = function () { langBtn.style.transform = ''; };
    btn.title = '把输入框中文翻译成目标语言';
    // 点在按钮上不要抢走输入框焦点/选区（图片说明文字框尤其需要）
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });

    var menu = document.createElement('div');
    menu.id = 'wa-tr-menu';
    menu.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#ffffff;color:#111b27;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.28);font:13px/1.4 -apple-system,sans-serif;width:250px;max-height:60vh;overflow:auto;display:none;padding:6px;';

    function buildMenu() {
        var k = chatKey();
        var cur = S.chatLang[k] || {};
        var html = '<div style="padding:6px 8px;color:#64748b;font-size:11px;">目标语言（本次会话）</div>';
        html += '<div class="it" data-v="auto" style="padding:8px;border-radius:8px;cursor:pointer;color:#111b27;' + ((!cur.manual && S.txMode === 'auto') ? 'background:#ecfdf5;font-weight:700;' : '') + '">自动跟客户 ' + (!cur.manual && cur.lang ? '（当前 ' + langShort(cur.lang) + '）' : '') + '</div>';
        html += '<div class="it" data-v="redetect" style="padding:8px;border-radius:8px;cursor:pointer;color:#0369a1;">🔄 重新识别本会话语言</div>';
        for (var i = 0; i < LANGS.length; i++) {
            var L = LANGS[i], on = cur.manual && cur.lang === L[0];
            html += '<div class="it" data-v="' + L[0] + '" style="padding:7px 8px;border-radius:8px;cursor:pointer;color:#111b27;' + (on ? 'background:#ecfdf5;font-weight:700;' : '') + '">' + L[1] + '</div>';
        }
        html += '<div class="it" data-v="settings" style="padding:8px;border-radius:8px;cursor:pointer;border-top:1px solid #e2e8f0;margin-top:4px;color:#0369a1;">⚙ 翻译设置…</div>';
        menu.innerHTML = html;
        Array.prototype.forEach.call(menu.querySelectorAll('.it'), function (el) {
            el.onmouseenter = function () { if (!el.style.background) el.style.background = '#f1f5f9'; };
            el.onmouseleave = function () { if (el.style.background === '#f1f5f9' || el.style.background === 'rgb(241, 245, 249)') el.style.background = ''; };
            el.onclick = function () {
                var v = el.getAttribute('data-v');
                closeLangMenu();
                if (v === 'settings') { openSettings(); return; }
                if (v === 'redetect') {
                    delete S.chatLang[k]; saveCfg();
                    lastSig = '';
                    var lg = detectLang(incomingTexts(12));
                    if (lg) { S.chatLang[k] = { lang: lg, manual: false }; saveCfg(); paintBtn(); flash('识别为 ' + langShort(lg)); }
                    else { paintBtn(); flash('识别不出，请手动选'); }
                    return;
                }
                if (v === 'auto') {
                    delete S.chatLang[k];
                    S.txMode = 'auto';
                    lastSig = '';
                    saveCfg(); paintBtn();
                    setTimeout(function () { refreshChatLang(); paintBtn(); }, 300);
                    flash('已改为自动识别'); return;
                }
                S.chatLang[k] = { lang: v, manual: true };
                S.txMode = 'auto';          // 手动只影响本会话
                saveCfg(); paintBtn();
                flash('本会话译为 ' + langShort(v));
            };
        });
    }

    function flash(msg) {
        setBtn(msg, '#f59e0b');
        setTimeout(paintBtn, 1500);
    }

    /* ================= 主按钮：翻译 ================= */
    btn.onclick = function () {
        var ed = findEditor();
        if (!ed) { setBtn('无输入框', '#ef4444'); setTimeout(paintBtn, 1600); return; }
        var t = (ed.innerText || ed.textContent || '').trim();
        if (!t) { setBtn('输入框为空', '#f59e0b'); setTimeout(paintBtn, 1600); return; }
        if (t === lastTranslated) return;

        var ck = chatKey();
        var known = S.chatLang[ck] && S.chatLang[ck].lang;
        if (S.txMode === 'auto' && !known) {
            // 没识别出客户语言，绝不默认翻成英语——先让老板选一次
            buildMenu();
            menu.style.display = 'block';
            setBtn('先选客户语言', '#f59e0b');
            setTimeout(paintBtn, 2500);
            return;
        }

        var tl = targetLang();
        if (!tl || tl === 'zh-CN') { setBtn('目标是中文', '#ef4444'); setTimeout(paintBtn, 1600); return; }

        state = STATE_IDLE;
        setBtn('译 ' + langShort(tl) + '…', '#3b82f6');

        translateSmart(t, tl).then(function (res) {
            console.log('[WA翻译助手]', t, '→', tl, ':', res);
            return replaceEditorText(ed, res, t).then(function (ok) {
                if (!ok) {
                    var copied = false;
                    try { copied = GM_setClipboard(res); } catch (e) {}
                    if (!copied) { try { navigator.clipboard.writeText(res); copied = true; } catch (e) {} }
                    if (copied) {
                        var hasOne = (function () { var c = curText(); return !!(c && countOf(norm(c), norm(res)) >= 1); })();
                        if (!hasOne) trustedPaste();
                    }
                    setTimeout(function () {
                        if (isTarget(t, res)) { lastTranslated = res; state = STATE_READY; paintBtn(); }
                    }, 600);
                    setBtn(copied ? '已复制·请粘贴' : '替换失败', copied ? '#f59e0b' : '#ef4444');
                    setTimeout(paintBtn, 4000);
                    return;
                }
                lastTranslated = res;
                state = STATE_READY;
                paintBtn();
            });
        }).catch(function (err) {
            console.error('[WA翻译助手] 翻译失败:', err);
            setBtn('翻译失败', '#ef4444');
            setTimeout(paintBtn, 3000);
        });
    };

    langBtn.onclick = function (e) {
        e.stopPropagation();
        var open = menu.style.display === 'block';
        if (open) { closeLangMenu(); return; }
        buildMenu();
        menu.style.display = 'block';
        var r = langBtn.getBoundingClientRect();
        var mw = menu.offsetWidth || 250, mh = menu.offsetHeight || 400;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.style.left = Math.max(8, Math.min(r.left + r.width - mw, window.innerWidth - mw - 8)) + 'px';
        menu.style.top = Math.max(8, r.top - mh - 10) + 'px';
        var tri = langBtn.querySelector('#wa-tr-tri');
        if (tri) { tri.style.transform = 'rotate(180deg)'; }
        langBtn.style.background = '#008069';
    };
    function closeLangMenu() {
        menu.style.display = 'none';
        var tri = langBtn.querySelector('#wa-tr-tri');
        if (tri) { tri.style.transform = ''; }
        langBtn.style.background = '#1f2c33';
    }
    document.addEventListener('mousedown', function (e) {
        if (menu.style.display === 'block' && !menu.contains(e.target) && !langBtn.contains(e.target)) closeLangMenu();
    });

    dock.appendChild(langBtn);
    dock.appendChild(btn);
    document.body.appendChild(dock);
    document.body.appendChild(menu);
    paintBtn();

    /* ================= 跟随输入框定位（面板开关/窗口缩放自适应） ================= */
    // 输入区里所有可见按钮（用来找最靠右的“发送”）
    function footerButtons() {
        var f = document.querySelector('#main footer'), out = [];
        if (!f) return out;
        var list = f.querySelectorAll('button'), best = null;
        for (var i = 0; i < list.length; i++) {
            if (!isVis(list[i])) continue;
            var r = list[i].getBoundingClientRect();
            if (!best || r.left > best.r.left) best = { el: list[i], r: r };
        }
        if (best) out.push(best);
        return out;
    }
    // 发送键的"视觉盒子"：图标往上找最多 5 层祖先，取 ≤96px 的最大盒子（=那个白色圆）
    function sendBox() {
        var icon = findSendIcon();
        if (!icon) return null;
        var box = icon.getBoundingClientRect();
        if (!box.width) return null;
        var el = icon;
        for (var i = 0; i < 5 && el; i++) {
            var r = el.getBoundingClientRect();
            if (r.width > box.width && r.width <= 96 && r.height <= 96) box = r;
            el = el.parentElement;
        }
        return box;
    }
    // 只在聊天窗体显示：没有 #main、没有可见输入框、或输入框被弹层（设置/预览遮罩）盖住 → 一律隐藏
    function inChatPane() {
        var main = document.querySelector('#main');
        if (!main || !isVis(main)) return false;
        var ed = findEditor();
        if (!ed) return false;
        var r = ed.getBoundingClientRect();
        try {
            var hit = document.elementFromPoint(r.left + Math.min(30, r.width / 2), r.top + r.height / 2);
            if (hit && hit !== ed && !ed.contains(hit)) return false;   // 被别的层盖住
        } catch (e) {}
        return true;
    }
    function anchorRect() {
        // 返回 {x: 两个按钮右边缘贴靠的横坐标, mid: 垂直中线(发送圆心的视觉中心)}
        if (!inChatPane()) return null;
        var sb = sendBox();
        if (sb) return { x: sb.left, mid: sb.top + sb.height / 2 };
        var fb = footerButtons();
        if (fb.length) {
            var lr = fb[0].r;
            return { x: lr.left, mid: lr.top + lr.height / 2 };
        }
        var ed = findEditor();
        if (ed) {
            var r2 = ed.getBoundingClientRect();
            if (r2.width) return { x: r2.right - 56, mid: r2.top + r2.height / 2 };   // 给发送键留位
        }
        var f = document.querySelector('#main footer');
        if (f && isVis(f)) {
            var r3 = f.getBoundingClientRect();
            if (r3.width) return { x: r3.right - 56, mid: r3.top + r3.height / 2 };
        }
        return null;
    }
    // 输入框所在的那一条（含表情等内嵌按钮）：这些不算"右侧邻居"，否则会把我们挤进输入框里
    function composerBox() {
        var ed = findEditor();
        if (!ed) return null;
        var el = ed;
        for (var i = 0; i < 4 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            if (el.querySelector && el.querySelector('button, [role="button"]')) return el;
        }
        return null;
    }
    // 贴靠右侧最近的按钮：发送键、或并排的新按钮（新版多了"定时发送"），
    // 一律保证 dock 右边缘 = 该按钮左边缘 - 12px，这样自然排在它前面
    function snapToNeighbor() {
        var box = composerBox();
        for (var pass = 0; pass < 2; pass++) {
            var d = dock.getBoundingClientRect();
            if (!d.width) return;
            var list = document.querySelectorAll('button, [role="button"]'), best = null;
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (dock.contains(el) || el.contains(dock) || menu.contains(el)) continue;
                if (box && box.contains(el)) continue;                        // 输入框内的按钮不算
                if (!isVis(el)) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 16 || r.width > 120 || r.height > 120) continue;
                if (r.bottom < d.top + 4 || r.top > d.bottom - 4) continue;   // 不在同一水平带
                if (r.left <= d.left + 4) continue;                           // 只看 dock 右侧的
                if (r.left > d.right + 120) continue;                         // 太远，不算邻居
                if (!best || r.left < best.left) best = r;
            }
            if (!best) return;
            var dx = d.right - (best.left - 12);
            var dy = (d.top + d.height / 2) - (best.top + best.height / 2);
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            if (Math.abs(dx) >= 1) dock.style.left = Math.max(6, Math.round(parseFloat(dock.style.left) - dx)) + 'px';
            if (Math.abs(dy) >= 1) dock.style.top = Math.round(parseFloat(dock.style.top) - dy) + 'px';
        }
    }
    function placeBar() {
        var a = null, crashed = false;
        try { a = anchorRect(); } catch (e) { crashed = true; }
        if (!a) {
            // 明确"不在聊天窗体" → 隐藏；万一是内部报错，保持现状，别让按钮闪掉
            if (!crashed) dock.style.display = 'none';
            return;
        }
        dock.style.display = 'flex';

        var GAP = 12;                       // 与发送键之间
        var w = dock.offsetWidth || 92, h = dock.offsetHeight || 42;
        dock.style.left = Math.max(6, Math.round(a.x - GAP - w)) + 'px';
        dock.style.top = Math.round(a.mid - h / 2) + 'px';

        // 按真实渲染再收口一次（发送键有缩放动画时也不会错位）
        try {
            var dr = dock.getBoundingClientRect();
            var dx = (a.x - GAP) - dr.right;
            if (Math.abs(dx) >= 1) dock.style.left = Math.round(parseFloat(dock.style.left) + dx) + 'px';
            var dy = a.mid - (dr.top + dr.height / 2);
            if (Math.abs(dy) >= 1) dock.style.top = Math.round(parseFloat(dock.style.top) + dy) + 'px';
            if (parseFloat(dock.style.left) < 6) dock.style.left = '6px';
        } catch (e) {}
        try { snapToNeighbor(); } catch (e) {}
    }
    var _ro = null;
    function watchComposer() {
        try { placeBar(); } catch (e) {}
        try {
            if (!_ro && window.ResizeObserver) {
                _ro = new ResizeObserver(function () { placeBar(); });
                var m = document.querySelector('#main');
                if (m) _ro.observe(m);
            }
        } catch (e) {}
    }
    watchComposer();
    setInterval(watchComposer, 800);
    window.addEventListener('resize', placeBar);

    /* ================= 回车发送（译完才生效，沿用 v3.16） ================= */
    document.addEventListener('keydown', function (e) {
        if (!S.sendAfter) return;
        if (state === STATE_READY && e.key === 'Enter' && !e.shiftKey) {
            var ed = findEditor();
            if (ed && (ed === document.activeElement || ed.contains(document.activeElement))) {
                e.preventDefault();
                e.stopPropagation();
                if (sendMessage()) {
                    state = STATE_IDLE;
                    paintBtn();
                }
            }
        }
    }, true);

    setInterval(function () {
        if (state !== STATE_READY) return;
        var ed = findEditor(); if (!ed) return;
        if ((ed.innerText || '').trim() !== lastTranslated.trim()) { state = STATE_IDLE; paintBtn(); }
    }, 500);

    /* ================= 会话语种自动识别 ================= */
    setInterval(refreshChatLang, 2000);
    setTimeout(refreshChatLang, 2500);

    /* ================= 设置面板 ================= */
    function openSettings() {
        var old = document.getElementById('wa-tr-cfg'); if (old) old.remove();
        var m = document.createElement('div');
        m.id = 'wa-tr-cfg';
        m.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;';
        var optDef = LANGS.map(function (L) {
            return '<option value="' + L[0] + '"' + (L[0] === S.defaultLang ? ' selected' : '') + '>' + L[1] + '</option>';
        }).join('');
        m.innerHTML =
            '<div style="background:#fff;color:#111b27;width:460px;max-width:94vw;border-radius:14px;font:13px/1.6 -apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden;">' +
            '<div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #e2e8f0;"><b style="font-size:15px;">翻译设置</b><span style="flex:1;"></span><span id="x" style="cursor:pointer;color:#94a3b8;font-weight:700;">✕</span></div>' +
            '<div style="padding:16px;display:flex;flex-direction:column;gap:14px;">' +
            '<div><b>识别不出客户语言时，默认译为</b><br><select id="c-def" style="width:100%;padding:7px;border:1px solid #cbd5e1;border-radius:8px;color:#111b27;background:#fff;margin-top:6px;">' + optDef + '</select></div>' +
            '<div><label style="cursor:pointer;"><input type="checkbox" id="c-send" ' + (S.sendAfter ? 'checked' : '') + '> 译完直接回车发送（取消则只替换不发送）</label></div>' +
            '<div style="border-top:1px dashed #e2e8f0;padding-top:12px;">' +
            '<label style="cursor:pointer;"><input type="checkbox" id="c-ai" ' + (S.aiOn ? 'checked' : '') + '> <b>用 AI 翻译</b>（术语更准，需填 Key；不勾则用免费机翻）</label>' +
            '<input id="c-base" value="' + S.aiBase + '" placeholder="Base URL" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #cbd5e1;border-radius:8px;color:#111b27;background:#fff;margin-top:8px;">' +
            '<input id="c-key" value="' + S.aiKey + '" placeholder="API Key（仅存本机）" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #cbd5e1;border-radius:8px;color:#111b27;background:#fff;margin-top:6px;">' +
            '<input id="c-model" value="' + S.aiModel + '" placeholder="模型，如 deepseek-chat / glm-4-flash" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #cbd5e1;border-radius:8px;color:#111b27;background:#fff;margin-top:6px;">' +
            '</div></div>' +
            '<div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid #e2e8f0;background:#fafafa;"><span style="flex:1;"></span>' +
            '<button id="sv" style="background:#008069;color:#fff;border:0;border-radius:8px;padding:8px 18px;font:600 13px inherit;cursor:pointer;">保存</button></div></div>';
        document.body.appendChild(m);
        m.querySelector('#x').onclick = function () { m.remove(); };
        m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
        m.querySelector('#sv').onclick = function () {
            S.defaultLang = m.querySelector('#c-def').value;
            S.sendAfter = m.querySelector('#c-send').checked;
            S.aiOn = m.querySelector('#c-ai').checked;
            S.aiBase = m.querySelector('#c-base').value.trim() || 'https://api.deepseek.com/v1';
            S.aiKey = m.querySelector('#c-key').value.trim();
            S.aiModel = m.querySelector('#c-model').value.trim() || 'deepseek-chat';
            saveCfg(); paintBtn(); m.remove();
            flash('已保存');
        };
    }
    GM_registerMenuCommand('翻译设置', openSettings);

    /* ================= 划词翻译 ================= */
    var bubble = document.createElement('div');
    bubble.style.cssText = 'position:fixed;z-index:2147483647;max-width:340px;padding:8px 12px;background:#111b27;color:#e6edf3;font:13px/1.6 -apple-system,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;white-space:pre-wrap;';
    document.body.appendChild(bubble);
    document.addEventListener('mousedown', function (e) { if (!bubble.contains(e.target)) bubble.style.display = 'none'; });
    document.addEventListener('mouseup', function (e) {
        if (menu.style.display === 'block') return;
        var text = (window.getSelection() + '').trim();
        if (!text || text.length > 500) return;
        mtTranslate(text, 'auto', 'zh-CN').then(function (res) {
            bubble.textContent = res;
            bubble.style.left = Math.min(e.clientX + 12, innerWidth - 360) + 'px';
            bubble.style.top = Math.min(e.clientY + 12, innerHeight - 100) + 'px';
            bubble.style.display = 'block';
        }).catch(function (err) {
            bubble.textContent = '翻译失败:' + (err && err.message ? err.message : err);
            bubble.style.display = 'block';
        });
    });

    /* ================= 加载提示 ================= */
    var toast = document.createElement('div');
    toast.textContent = 'WA翻译助手 v4.2.0 已加载 ✓ 点多语言切换 → 自动跟客户';
    toast.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#111b27;color:#4ade80;font:600 12px/1.6 -apple-system,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.35);';
    document.body.appendChild(toast);
    setTimeout(function () { toast.style.display = 'none'; }, 4000);
})();
