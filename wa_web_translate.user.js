// ==UserScript==
// @name         WhatsApp 智译助手 (对标 TradeMessenger)
// @namespace    wa-translate-pro
// @version      1.0.0
// @description  对标中国制造网 TradeMessenger：接收消息翻译 / 发送实时翻译 / 按联系人AUTO语言 / LLM+术语库翻译 / AI聊天上下文推荐回复。只填入不代发，人工确认后发送。
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      clients5.google.com
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @connect      api.deepl.com
// @connect      api-free.deepl.com
// @connect      api.openai.com
// @connect      open.bigmodel.cn
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      dashscope.aliyuncs.com
// @connect      api.minimaxi.com
// @connect      api.minimax.chat
// @connect      openrouter.ai
// @connect      api.siliconflow.cn
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /**************** 工具 ****************/
    function gmReq(opt) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest(Object.assign({
                timeout: 30000,
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject('HTTP ' + r.status + ' ' + String(r.responseText).slice(0, 200));
                },
                onerror: function () { reject('网络错误'); },
                ontimeout: function () { reject('超时'); }
            }, opt));
        });
    }
    function gmGet(url) { return gmReq({ method: 'GET', url: url }); }
    function gmPostJson(url, body, headers) {
        return gmReq({
            method: 'POST', url: url,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
            data: typeof body === 'string' ? body : JSON.stringify(body)
        });
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function hashStr(s) { var h = 0, i; for (i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return 'h' + (h >>> 0).toString(36); }

    /**************** 设置 ****************/
    var DEFAULTS = {
        rxEnabled: true, rxLang: 'zh-CN',
        txEnabled: true, txLang: 'auto', txDefaultLang: 'en',
        engine: 'llm',                       // llm | deepl | free | auto
        llmBase: 'https://api.openai.com/v1', llmKey: '', llmModel: 'gpt-4o-mini',
        deeplKey: '', freeFallback: true,
        glossary: [
            'M8=','SS304=','M8 tapped=','MOQ=','FOB=',
            'MOQ|最小起订量', 'FOB|离岸价', 'SS304|不锈钢304',
            'hex bolt|六角螺栓', 'nut|螺母', 'washer|垫圈'
        ].join('\n'),
        aiPersona: '我是五金紧固件出口商，专业、友好、简洁。回复围绕报价、交期、规格确认推进订单。',
        aiCount: 3, aiContextN: 30,
        contactLang: {}                       // contactKey -> 'en'...
    };
    var settings = Object.assign({}, DEFAULTS, GM_getValue('cfg', {}) || {});
    function saveCfg() { GM_setValue('cfg', settings); }
    var tmCache = GM_getValue('tm', {}) || {};
    function saveTM() { var k = Object.keys(tmCache); if (k.length > 800) { k.slice(0, 200).forEach(function (x) { delete tmCache[x]; }); } GM_setValue('tm', tmCache); }

    var LANGS = [
        ['zh-CN', '中文(简体)'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'],
        ['de', 'Deutsch'], ['ru', 'Русский'], ['ar', 'العربية'], ['pt', 'Português'],
        ['ja', '日本語'], ['ko', '한국어'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'],
        ['id', 'Indonesia'], ['tr', 'Türkçe'], ['it', 'Italiano'], ['nl', 'Nederlands'],
        ['pl', 'Polski'], ['hi', 'हिन्दी']
    ];
    function langName(c) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === c) return LANGS[i][1]; return c; }
    function detectLangHeuristic(t) {
        var s = t || '';
        if (/[\u4e00-\u9fff]/.test(s)) return /[\u3040-\u30ff]/.test(s) ? 'ja' : 'zh-CN';
        if (/[\uac00-\ud7af]/.test(s)) return 'ko';
        if (/[\u0600-\u06ff]/.test(s)) return 'ar';
        if (/[\u0400-\u04ff]/.test(s)) return 'ru';
        if (/[\u0e00-\u0e7f]/.test(s)) return 'th';
        if (/[\u0900-\u097f]/.test(s)) return 'hi';
        if (/[\u0590-\u05ff]/.test(s)) return 'he';
        if (/[\u0370-\u03ff]/.test(s)) return 'el';
        return 'en';
    }

    /**************** 翻译引擎 ****************/
    function buildSystemPrompt(src, tgt) {
        var gl = (settings.glossary || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        var glTxt = gl.length ? '\n术语对照表(禁止译错，保持原样或按表翻译):\n' + gl.join('\n') : '';
        return '你是专业的外贸翻译引擎。把用户文本从' + (src || '自动检测语种') + '翻译成' + langName(tgt) + '(' + tgt + ')。' +
            '要求：只输出译文本身，不要解释、不要引号、不要标注语言；保留数字、规格型号、单位、货币缩写、URL、邮件地址原样；标点按目标语言习惯。' + glTxt;
    }
    function llmTranslate(text, src, tgt) {
        var base = (settings.llmBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
        return gmPostJson(base + '/chat/completions', {
            model: settings.llmModel || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
                { role: 'system', content: buildSystemPrompt(src, tgt) },
                { role: 'user', content: text }
            ]
        }, { 'Authorization': 'Bearer ' + (settings.llmKey || '') }).then(function (r) {
            var j = JSON.parse(r);
            var out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!out) throw new Error('LLM返回为空');
            return { text: out.trim(), engine: 'LLM' };
        });
    }
    function deeplTranslate(text, src, tgt) {
        var tgtD = tgt === 'zh-CN' ? 'ZH' : tgt.toUpperCase();
        var params = 'text=' + encodeURIComponent(text) + '&target_lang=' + tgtD + '&source_lang=' + (src && src !== 'auto' ? src.toUpperCase() : '');
        if (src === 'zh-CN' || !src) params = 'text=' + encodeURIComponent(text) + '&target_lang=' + tgtD;
        return gmPostJson((settings.deeplPro ? 'https://api.deepl.com' : 'https://api-free.deepl.com') + '/v2/translate',
            params, { 'Authorization': 'DeepL-Auth-Key ' + (settings.deeplKey || ''), 'Content-Type': 'application/x-www-form-urlencoded' })
            .then(function (r) { var j = JSON.parse(r); if (!j.translations || !j.translations[0]) throw new Error('deepl'); return { text: j.translations[0].text, engine: 'DeepL' }; });
    }
    function googleFree(text, src, tgt) {
        return gmGet('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + (src || 'auto') + '&tl=' + tgt + '&q=' + encodeURIComponent(text))
            .then(function (r) { return { text: parseDict(r), engine: 'Google' }; })
            .catch(function () {
                var pair = (src || 'en') + '|' + tgt;
                return gmGet('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + pair)
                    .then(function (r) { var j = JSON.parse(r); return { text: (j.responseData && j.responseData.translatedText) || '', engine: 'MyMemory' }; });
            });
    }
    function parseDict(json) {
        var j = JSON.parse(json), seg = (j && j[0]) || [], out = '';
        for (var i = 0; i < seg.length; i++) { if (typeof seg[i] === 'string') out += seg[i]; else if (seg[i] && seg[i][0]) out += seg[i][0]; }
        return out.trim();
    }
    // 主入口：TM缓存 → 引擎链 → 兜底
    function translateSmart(text, src, tgt) {
        text = String(text || '').trim();
        if (!text) return Promise.resolve({ text: '', engine: '-' });
        var tgtF = tgt || 'zh-CN';
        var key = hashStr(text + '|' + tgtF + '|' + (settings.glossary || '').slice(0, 50));
        if (tmCache[key]) return Promise.resolve({ text: tmCache[key], engine: 'TM' });
        var chain = [];
        if (settings.engine === 'llm' && settings.llmKey) chain.push(function () { return llmTranslate(text, src, tgtF); });
        if (settings.engine === 'deepl' && settings.deeplKey) chain.push(function () { return deeplTranslate(text, src, tgtF); });
        if (settings.engine !== 'free') {
            if (settings.llmKey) chain.push(function () { return llmTranslate(text, src, tgtF); });
            if (settings.deeplKey) chain.push(function () { return deeplTranslate(text, src, tgtF); });
        }
        if (settings.engine === 'llm' || settings.engine === 'deepl' || settings.engine === 'auto' || settings.engine === 'free' || settings.freeFallback) {
            chain.push(function () { return googleFree(text, src, tgtF); });
        }
        function run(i) {
            if (i >= chain.length) return Promise.reject(new Error('全部引擎失败'));
            return chain[i]().catch(function () { return run(i + 1); });
        }
        return run(0).then(function (r) {
            if (r && r.text && r.engine !== 'TM') {
                tmCache[key] = r.text; saveTM();
            }
            return r;
        });
    }

    /**************** WhatsApp DOM 助手 ****************/
    function findEditor() {
        var sels = [
            'footer div[contenteditable="true"]',
            'div[contenteditable="true"][spellcheck="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]'
        ];
        for (var i = 0; i < sels.length; i++) { var el = document.querySelector(sels[i]); if (el) return el; }
        return null;
    }
    function currentContactKey() {
        var h = document.querySelector('#main header');
        if (h) {
            var t = h.querySelector('span[title], [title]');
            if (t && t.getAttribute('title')) return t.getAttribute('title');
        }
        var info = document.querySelector('[data-testid="conversation-info-header"], [data-testid="conversation-panel-header"]');
        if (info) return (info.innerText || '').split('\n')[0].trim() || 'unknown';
        return 'unknown';
    }
    function currentTxLang() {
        if (settings.txLang !== 'auto') return settings.txLang;
        var ck = currentContactKey();
        return (settings.contactLang && settings.contactLang[ck]) || settings.txDefaultLang || 'en';
    }
    // Lexical 输入框注入（沿用旧脚本验证过的链路）
    function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function countOf(hay, needle) { var n = 0, i = hay.indexOf(needle); while (i > -1) { n++; i = hay.indexOf(needle, i + needle.length); } return n; }
    function curText() { var l = findEditor(); return l ? ((l.innerText || '').trim()) : ''; }
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
        var dt = new DataTransfer(); dt.setData('text', text); dt.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    async function fillEditor(text) {
        for (var round = 0; round < 2; round++) {
            var l = findEditor(); if (!l) return false;
            try { l.focus(); } catch (e) {}
            try { syncSelection(l); } catch (e) {}
            try { pasteInto(l, text); } catch (e) {}
            await sleep(300);
            var now = norm(curText());
            if (now && countOf(now, norm(text)) === 1) return true;
            var l2 = findEditor(); if (l2) l2.textContent = '';
            await sleep(200);
        }
        return false;
    }
    function findSendIcon() {
        return document.querySelector('span[data-icon="wds-ic-send-filled"]') || document.querySelector('span[data-icon="send"]');
    }
    function sendMessage() {
        var icon = findSendIcon(); if (icon) { var b = icon.closest('button'); if (b) { b.click(); return true; } }
        var aria = document.querySelector('button[aria-label="发送"], button[aria-label="Send"]'); if (aria) { aria.click(); return true; }
        return false;
    }

    /**************** UI 基础 ****************/
    function toast(msg, color, ms) {
        var old = document.getElementById('wt-toast'); if (old) old.remove();
        var t = document.createElement('div'); t.id = 'wt-toast'; t.textContent = msg;
        t.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;background:#111b27;color:' + (color || '#4ade80') + ';font:600 13px/1.5 -apple-system,sans-serif;padding:9px 18px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, ms || 2600);
    }
    var btnBase = 'border:0;cursor:pointer;font:600 12px -apple-system,sans-serif;padding:6px 12px;border-radius:8px;color:#fff;';
    var SW_CSS = '.wt-sw{position:relative;display:inline-block;width:40px;height:22px;}' +
        '.wt-sw input{display:none;}' +
        '.wt-sw i{position:absolute;inset:0;background:#cbd5e1;border-radius:22px;transition:.2s;}' +
        '.wt-sw i:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.2s;}' +
        '.wt-sw input:checked + i{background:#00a884;}' +
        '.wt-sw input:checked + i:before{transform:translateX(18px);}';

    /**************** 接收消息翻译 ****************/
    function markTranslatedEl(ct, box, text) {
        box.className = 'wt-rx-box';
        box.setAttribute('data-wt', '1');
        box.style.cssText = 'margin:2px 0 2px 12px;padding:4px 10px;border-left:3px solid #00a884;color:#54656f;font:13px/1.55 -apple-system,sans-serif;white-space:pre-wrap;word-break:break-word;max-width:640px;';
        box.innerHTML = '<span style="color:#00a884;font-weight:700;font-size:11px;margin-right:6px;">译</span>' + esc(text);
        ct.setAttribute('data-wt-done', '1');
        (ct.parentNode || ct.closest('.message-in')).appendChild(box);
    }
    function translateMessageIn(ct) {
        if (ct.getAttribute('data-wt-done') === '1') return;
        var sel = ct.querySelector('.selectable-text, span[data-qa="msg-text"], span');
        var raw = (sel && (sel.innerText || sel.textContent) || '').trim();
        if (!raw || raw.length > 3000) return;
        ct.setAttribute('data-wt-done', '1');
        var box = document.createElement('div');
        markTranslatedEl(ct, box, '翻译中…');
        translateSmart(raw, detectLangHeuristic(raw), settings.rxLang).then(function (r) {
            markTranslatedEl(ct, box, r.text);
            var ck = currentContactKey();
            if (detectLangHeuristic(raw) !== settings.rxLang) {
                settings.contactLang[ck] = detectLangHeuristic(raw); saveCfg();
            }
        }).catch(function () { markTranslatedEl(ct, box, '翻译失败'); });
    }
    function scanMessages(root) {
        if (!settings.rxEnabled) return;
        var nodes = (root || document).querySelectorAll('.message-in .copyable-text:not([data-wt-done])');
        for (var i = 0; i < nodes.length; i++) {
            if (i > 60) break;
            translateMessageIn(nodes[i]);
        }
    }
    var rxObserver = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
            var added = muts[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
                var n = added[j];
                if (n.nodeType !== 1) continue;
                var list = n.matches && n.matches('.message-in .copyable-text') ? [n] : n.querySelectorAll('.message-in .copyable-text:not([data-wt-done])');
                for (var k = 0; k < list.length && k < 30; k++) translateMessageIn(list[k]);
            }
        }
    });
    function startRx() {
        var main = document.querySelector('#main');
        if (!main) { setTimeout(startRx, 1500); return; }
        rxObserver.observe(main, { childList: true, subtree: true });
        setTimeout(function () { scanMessages(document); }, 2500);
        setTimeout(function () { scanMessages(document); }, 8000);
    }
    startRx();

    /**************** 发送翻译条 ****************/
    var txBar = document.createElement('div');
    txBar.id = 'wt-tx-bar';
    txBar.style.cssText = 'position:fixed;left:14px;bottom:64px;z-index:2147483647;width:340px;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.28);font:13px/1.5 -apple-system,sans-serif;display:none;flex-direction:column;overflow:hidden;';
    txBar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f0f2f5;border-bottom:1px solid #e2e8f0;">' +
        '<b style="font-size:13px;color:#111b27;">发送翻译</b>' +
        '<span id="wt-tx-lang" style="color:#008069;font-weight:700;"></span>' +
        '<span style="flex:1;"></span>' +
        '<button id="wt-tx-cfg" style="' + btnBase + 'background:#94a3b8;">设置</button>' +
        '</div>' +
        '<div style="padding:10px;">' +
        '<textarea id="wt-tx-input" rows="2" placeholder="输入需要翻译的文字（中文或任意语言）" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:13px/1.5 inherit;resize:none;outline:none;"></textarea>' +
        '<div style="display:flex;gap:6px;margin-top:8px;align-items:center;">' +
        '<span style="color:#64748b;font-size:11px;">Ctrl+Enter 翻译</span><span style="flex:1;"></span>' +
        '<button id="wt-tx-go" style="' + btnBase + 'background:#008069;">翻译并预览</button>' +
        '</div>' +
        '<div id="wt-tx-out" style="display:none;margin-top:10px;padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">' +
        '<div id="wt-tx-text" style="color:#111b27;white-space:pre-wrap;word-break:break-word;"></div>' +
        '<div id="wt-tx-meta" style="color:#64748b;font-size:11px;margin-top:6px;"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
        '<button id="wt-tx-fill" style="' + btnBase + 'background:#00a884;">填入输入框</button>' +
        '<button id="wt-tx-fill2" style="' + btnBase + 'background:#0ea5e9;">原文+译文</button>' +
        '<button id="wt-tx-copy" style="' + btnBase + 'background:#94a3b8;">复制译文</button>' +
        '</div></div></div>';
    document.body.appendChild(txBar);
    var $ = function (id) { return document.getElementById(id); };
    var lastTx = '';
    function txLangLabel() { var c = currentTxLang(); $('wt-tx-lang').textContent = '→ ' + langName(c) + (settings.txLang === 'auto' ? ' (AUTO)' : ''); }
    $('wt-tx-cfg').onclick = openSettings;
    async function doTx() {
        var text = ($('wt-tx-input').value || '').trim();
        if (!text) return;
        var tgt = currentTxLang();
        $('wt-tx-go').textContent = '翻译中…'; $('wt-tx-go').disabled = true;
        try {
            var r = await translateSmart(text, 'auto', tgt);
            lastTx = r.text;
            $('wt-tx-text').textContent = r.text;
            $('wt-tx-meta').textContent = '引擎:' + r.engine + ' · 目标语:' + langName(tgt) + ' · 请人工确认后发送';
            $('wt-tx-out').style.display = 'block';
        } catch (e) { toast('翻译失败:' + e, '#f87171'); }
        $('wt-tx-go').textContent = '翻译并预览'; $('wt-tx-go').disabled = false;
    }
    $('wt-tx-go').onclick = doTx;
    $('wt-tx-input').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTx(); } });
    $('wt-tx-fill').onclick = function () { if (lastTx) { fillEditor(lastTx).then(function (ok) { toast(ok ? '已填入，请检查后点发送' : '填入失败，请手动粘贴', ok ? '#4ade80' : '#f87171'); }); } };
    $('wt-tx-fill2').onclick = function () {
        if (!lastTx) return;
        var both = ($('wt-tx-input').value || '').trim() + '\n' + lastTx;
        fillEditor(both).then(function (ok) { toast(ok ? '已填入(双语)，请检查后发送' : '填入失败', ok ? '#4ade80' : '#f87171'); });
    };
    $('wt-tx-copy').onclick = function () {
        if (!lastTx) return;
        try { GM_setClipboard(lastTx); toast('已复制译文'); } catch (e) { navigator.clipboard.writeText(lastTx); toast('已复制'); }
    };
    // 底部 AI / 译 悬浮钮
    var dock = document.createElement('div');
    dock.style.cssText = 'position:fixed;left:14px;bottom:20px;z-index:2147483647;display:flex;gap:8px;';
    dock.innerHTML = '<button id="wt-btn-tx" style="' + btnBase + 'background:#008069;padding:8px 14px;">译✎</button>' +
        '<button id="wt-btn-ai" style="' + btnBase + 'background:#7c3aed;padding:8px 14px;">AI 回复</button>' +
        '<button id="wt-btn-quick" style="' + btnBase + 'background:#334155;padding:8px 14px;">快译</button>';
    document.body.appendChild(dock);
    $('wt-btn-tx').onclick = function () {
        var show = txBar.style.display !== 'flex';
        txBar.style.display = show ? 'flex' : 'none';
        if (show) { txLangLabel(); $('wt-tx-input').focus(); }
    };
    $('wt-btn-quick').onclick = function () {
        var ed = findEditor(); if (!ed) return toast('未找到输入框', '#f87171');
        var t = (ed.innerText || '').trim(); if (!t) return toast('输入框为空', '#f59e0b');
        toast('快译中…', '#60a5fa');
        translateSmart(t, 'auto', currentTxLang()).then(function (r) {
            fillEditor(r.text).then(function (ok) { toast(ok ? '已填入: ' + r.engine + '，确认后发送' : '填入失败，已复制译文', ok ? '#4ade80' : '#f59e0b'); });
        }).catch(function (e) { toast('失败:' + e, '#f87171'); });
    };
    setInterval(txLangLabel, 3000);

    /**************** AI 回复推荐 ****************/
    var aiPanel = document.createElement('div');
    aiPanel.id = 'wt-ai-panel';
    aiPanel.style.cssText = 'position:fixed;right:14px;bottom:64px;width:360px;max-height:70vh;z-index:2147483647;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.28);font:13px/1.5 -apple-system,sans-serif;display:none;flex-direction:column;overflow:hidden;';
    aiPanel.innerHTML =
        '<div style="display:flex;align-items:center;padding:8px 10px;background:#f5f3ff;border-bottom:1px solid #e9d5ff;">' +
        '<b style="color:#5b21b6;">AI 回复推荐</b><span id="wt-ai-ctx" style="margin-left:8px;color:#64748b;font-size:11px;"></span><span style="flex:1;"></span>' +
        '<button id="wt-ai-close" style="' + btnBase + 'background:#94a3b8;">关闭</button></div>' +
        '<div id="wt-ai-list" style="padding:10px;overflow:auto;"></div>' +
        '<div style="padding:8px 10px;border-top:1px solid #e2e8f0;background:#fafafa;color:#64748b;font-size:11px;">生成后务必人工核对再发送 · 语种随对方语言</div>';
    document.body.appendChild(aiPanel);
    function gatherContext() {
        var out = [];
        var nodes = document.querySelectorAll('#main [data-id]');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var ct = el.querySelector('.copyable-text') || el;
            var sel = ct.querySelector('.selectable-text') || ct;
            var txt = (sel.innerText || sel.textContent || '').trim();
            if (!txt) continue;
            var mine = !!el.closest('.message-out');
            if (el.classList && el.classList.contains('message-in')) mine = false;
            if (el.classList && el.classList.contains('message-out')) mine = true;
            out.push((mine ? '我' : '对方') + ': ' + txt);
        }
        return out.slice(-(settings.aiContextN || 30)).join('\n');
    }
    async function aiGenerate() {
        if (!settings.llmKey) { openSettings(); return toast('请先在设置里填 LLM API Key', '#f59e0b'); }
        var ctx = gatherContext();
        $('wt-ai-ctx').textContent = '上下文 ' + String(ctx.split('\n').length) + ' 条';
        $('wt-ai-list').innerHTML = '<div style="color:#64748b;">生成中…</div>';
        var tgt = currentTxLang();
        var sys = '你是外贸业务助理，帮老板回复WhatsApp客户。' + settings.aiPersona +
            '\n客户语种：' + langName(tgt) + '。基于下面的聊天记录，给出恰好 ' + settings.aiCount + ' 条可以直接发送的回复建议，覆盖不同角度(确认信息/推进报价/催回复)。' +
            '\n输出格式：每条一行，行与行之间用单独一行 ' + '---' + ' 分隔；不要编号；只写客户语种的正文，不要中文，不要解释。';
        try {
            var r = await gmPostJson((settings.llmBase || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions', {
                model: settings.llmModel || 'gpt-4o-mini', temperature: 0.7,
                messages: [{ role: 'system', content: sys }, { role: 'user', content: ctx || '(无上下文)' }]
            }, { 'Authorization': 'Bearer ' + settings.llmKey });
            var j = JSON.parse(r); var content = j.choices[0].message.content.trim();
            var items = content.split(/\n-{3,}\n|\n---\n/).map(function (s) { return s.trim(); }).filter(Boolean);
            renderAi(items);
        } catch (e) { $('wt-ai-list').innerHTML = '<div style="color:#f87171;">生成失败:' + esc(e.message || e) + '</div>'; }
    }
    function renderAi(items) {
        var box = $('wt-ai-list'); box.innerHTML = '';
        if (!items.length) { box.innerHTML = '<div style="color:#f87171;">未生成候选</div>'; return; }
        items.forEach(function (t) {
            var d = document.createElement('div');
            d.style.cssText = 'padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;';
            d.innerHTML = '<div style="white-space:pre-wrap;word-break:break-word;">' + esc(t) + '</div>' +
                '<div style="display:flex;gap:6px;margin-top:8px;">' +
                '<button class="wt-ai-fill" style="' + btnBase + 'background:#7c3aed;">填入输入框</button>' +
                '<button class="wt-ai-cn" style="' + btnBase + 'background:#94a3b8;">看中文</button>' +
                '<button class="wt-ai-copy" style="' + btnBase + 'background:#cbd5e1;color:#111b27;">复制</button></div>';
            d.querySelector('.wt-ai-fill').onclick = function () { fillEditor(t).then(function (ok) { toast(ok ? '已填入，确认后发送' : '填入失败', ok ? '#4ade80' : '#f87171'); }); };
            d.querySelector('.wt-ai-cn').onclick = function (e) {
                e.target.textContent = '翻译中…';
                translateSmart(t, 'auto', 'zh-CN').then(function (r) { e.target.textContent = r.text; }).catch(function () { e.target.textContent = '失败'; });
            };
            d.querySelector('.wt-ai-copy').onclick = function () { try { GM_setClipboard(t); toast('已复制'); } catch (e) { navigator.clipboard.writeText(t); } };
            box.appendChild(d);
        });
    }
    $('wt-btn-ai').onclick = function () {
        var show = aiPanel.style.display !== 'flex';
        aiPanel.style.display = show ? 'flex' : 'none';
        if (show) aiGenerate();
    };
    $('wt-ai-close').onclick = function () { aiPanel.style.display = 'none'; };

    /**************** 设置弹窗(对标 TradeMessenger 翻译设置) ****************/
    function openSettings() {
        var old = document.getElementById('wt-settings'); if (old) old.remove();
        var m = document.createElement('div');
        m.id = 'wt-settings';
        m.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;';
        m.innerHTML =
            '<style>' + SW_CSS + '</style>' +
            '<div style="background:#fff;width:520px;max-width:94vw;max-height:88vh;overflow:auto;border-radius:14px;font:13px/1.6 -apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.35);">' +
            '<div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #e2e8f0;"><b style="font-size:15px;color:#111b27;">翻译设置</b><span style="flex:1;"></span><button id="wt-s-x" style="' + btnBase + 'background:#94a3b8;">关闭</button></div>' +
            '<div style="padding:16px;display:flex;flex-direction:column;gap:16px;">' +
            sec('接收消息翻译', '<label class="wt-sw"><input type="checkbox" id="c-rx" ' + (settings.rxEnabled ? 'checked' : '') + '><i></i></label> <span style="color:#64748b;">开启接收翻译</span><br>' +
                '<span style="color:#64748b;">翻译为</span> <select id="c-rxl">' + langOpts(settings.rxLang) + '</select> <span style="color:#94a3b8;font-size:11px;">开启后，收到的消息自动译为中文/目标语言</span>') +
            sec('发送消息实时翻译', '<label class="wt-sw"><input type="checkbox" id="c-tx" ' + (settings.txEnabled ? 'checked' : '') + '><i></i></label> <span style="color:#64748b;">开启发送翻译</span><br>' +
                '<span style="color:#64748b;">翻译为</span> <select id="c-txl">' + '<option value="auto"' + (settings.txLang === 'auto' ? ' selected' : '') + '>自动检测 (AUTO)</option>' + langOpts(settings.txLang === 'auto' ? '' : settings.txLang) + '</select>' +
                '<div style="margin-top:6px;color:#94a3b8;font-size:11px;">AUTO = 按当前联系人的消息语种自动选择；未识别时用默认语言 ' +
                '<select id="c-txd">' + langOpts(settings.txDefaultLang) + '</select></div>') +
            sec('翻译引擎', '<select id="c-eng" style="margin-bottom:8px;">' +
                '<option value="llm"' + (settings.engine === 'llm' ? ' selected' : '') + '>LLM 翻译(带术语,质量最佳)</option>' +
                '<option value="deepl"' + (settings.engine === 'deepl' ? ' selected' : '') + '>DeepL</option>' +
                '<option value="free"' + (settings.engine === 'free' ? ' selected' : '') + '>免费端点</option>' +
                '<option value="auto"' + (settings.engine === 'auto' ? ' selected' : '') + '>自动链(LLM→DeepL→免费)</option></select><br>' +
                '<span style="color:#64748b;">LLM (OpenAI 兼容: GLM/DeepSeek/Qwen/Moonshot/OpenAI…)</span><br>' +
                '<input id="c-base" value="' + esc(settings.llmBase) + '" placeholder="Base URL https://api.openai.com/v1" style="' + inp() + 'margin-bottom:6px;">' +
                '<input id="c-key" value="' + esc(settings.llmKey) + '" placeholder="API Key (仅存本机 Tampermonkey 存储)" style="' + inp() + 'margin-bottom:6px;">' +
                '<input id="c-model" value="' + esc(settings.llmModel) + '" placeholder="Model 如 gpt-4o-mini / glm-4-flash / deepseek-chat" style="' + inp() + 'margin-bottom:6px;">' +
                '<span style="color:#64748b;">DeepL Key(可选)</span> <input id="c-deepl" value="' + esc(settings.deeplKey) + '" style="' + inp() + 'width:200px;"><br>' +
                '<label style="color:#64748b;font-size:12px;"><input type="checkbox" id="c-fb" ' + (settings.freeFallback ? 'checked' : '') + '> 付费引擎失败时用免费端点兜底</label>') +
            sec('术语库(每行一条, 源文|译文；规格/型号保持原样不写)', '<textarea id="c-gloss" rows="4" style="' + inp() + 'height:90px;resize:vertical;">' + esc(settings.glossary) + '</textarea>') +
            sec('AI 回复推荐', '<span style="color:#64748b;">业务人设(影响推荐语气与策略)</span><textarea id="c-persona" rows="2" style="' + inp() + 'height:50px;resize:vertical;">' + esc(settings.aiPersona) + '</textarea>' +
                '<div style="margin-top:6px;">候选条数 <input id="c-cnt" type="number" min="1" max="5" value="' + settings.aiCount + '" style="width:52px;' + inp() + '"> · 上下文条数 <input id="c-ctxn" type="number" min="5" max="80" value="' + settings.aiContextN + '" style="width:52px;' + inp() + '"></div>') +
            '</div>' +
            '<div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid #e2e8f0;background:#fafafa;">' +
            '<button id="wt-s-test" style="' + btnBase + 'background:#0ea5e9;">测试翻译</button>' +
            '<button id="wt-s-tm" style="' + btnBase + 'background:#94a3b8;">清空翻译记忆</button><span style="flex:1;"></span>' +
            '<button id="wt-s-save" style="' + btnBase + 'background:#008069;">保存</button></div></div>';
        document.body.appendChild(m);
        function inp() { return 'box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:13px/1.5 inherit;width:100%;outline:none;'; }
        function sec(title, body) { return '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fcfdff;"><b style="color:#111b27;">' + title + '</b><div style="margin-top:8px;">' + body + '</div></div>'; }
        function langOpts(sel) { return LANGS.map(function (l) { return '<option value="' + l[0] + '"' + (l[0] === sel ? ' selected' : '') + '>' + l[1] + '</option>'; }).join(''); }
        m.querySelector('#wt-s-x').onclick = function () { m.remove(); };
        m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
        m.querySelector('#wt-s-save').onclick = function () {
            settings.rxEnabled = m.querySelector('#c-rx').checked;
            settings.rxLang = m.querySelector('#c-rxl').value;
            settings.txEnabled = m.querySelector('#c-tx').checked;
            settings.txLang = m.querySelector('#c-txl').value;
            settings.txDefaultLang = m.querySelector('#c-txd').value;
            settings.engine = m.querySelector('#c-eng').value;
            settings.llmBase = m.querySelector('#c-base').value.trim();
            settings.llmKey = m.querySelector('#c-key').value.trim();
            settings.llmModel = m.querySelector('#c-model').value.trim();
            settings.deeplKey = m.querySelector('#c-deepl').value.trim();
            settings.freeFallback = m.querySelector('#c-fb').checked;
            settings.glossary = m.querySelector('#c-gloss').value;
            settings.aiPersona = m.querySelector('#c-persona').value;
            settings.aiCount = Math.max(1, Math.min(5, +m.querySelector('#c-cnt').value || 3));
            settings.aiContextN = Math.max(5, Math.min(80, +m.querySelector('#c-ctxn').value || 30));
            saveCfg();
            toast('已保存', '#4ade80'); txLangLabel();
            setTimeout(function () { scanMessages(document); }, 300);
            m.remove();
        };
        m.querySelector('#wt-s-test').onclick = function () {
            var sample = 'We can offer SS304 M8 hex bolts at USD 0.005/pc, MOQ 1000 pieces, FOB Ningbo.';
            var tgt = m.querySelector('#c-rxl').value;
            var b = m.querySelector('#c-base').value.trim(), k = m.querySelector('#c-key').value.trim(), mo = m.querySelector('#c-model').value.trim();
            var bak = [settings.llmBase, settings.llmKey, settings.llmModel, settings.glossary];
            settings.llmBase = b; settings.llmKey = k; settings.llmModel = mo; settings.glossary = m.querySelector('#c-gloss').value;
            toast('测试翻译中…', '#60a5fa', 5000);
            translateSmart(sample, 'en', tgt).then(function (r) {
                alert('译文(' + r.engine + '):\n' + r.text);
                settings.llmBase = bak[0]; settings.llmKey = bak[1]; settings.llmModel = bak[2]; settings.glossary = bak[3];
            }).catch(function (e) { alert('测试失败:' + e); });
        };
        m.querySelector('#wt-s-tm').onclick = function () {
            if (confirm('清空全部翻译记忆？下次相同文本会重新请求引擎')) { tmCache = {}; GM_deleteValue('tm'); toast('已清空', '#4ade80'); }
        };
    }
    GM_registerMenuCommand('WhatsApp 智译助手 · 设置', openSettings);
    if (!settings.llmKey) setTimeout(function () { toast('首次使用：请点左下角「AI 回复」或菜单填 LLM Key 后生效', '#f59e0b', 5000); }, 4000);

    // 划词翻译气泡(保留旧功能)
    var bubble = document.createElement('div');
    bubble.style.cssText = 'position:fixed;z-index:2147483647;max-width:340px;padding:8px 12px;background:#111b27;color:#e6edf3;font:13px/1.6 -apple-system,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;white-space:pre-wrap;';
    document.body.appendChild(bubble);
    document.addEventListener('mousedown', function (e) { if (!bubble.contains(e.target)) bubble.style.display = 'none'; });
    document.addEventListener('mouseup', function (e) {
        var text = (window.getSelection() + '').trim();
        if (!text || text.length > 500) return;
        translateSmart(text, 'auto', settings.rxLang).then(function (r) {
            bubble.textContent = r.text;
            bubble.style.left = Math.min(e.clientX + 12, innerWidth - 360) + 'px';
            bubble.style.top = Math.min(e.clientY + 12, innerHeight - 100) + 'px';
            bubble.style.display = 'block';
        }).catch(function (err) { bubble.textContent = '翻译失败:' + err; bubble.style.display = 'block'; });
    });

    setTimeout(function () { toast('WhatsApp 智译助手已加载 ✓', '#4ade80'); }, 800);
})();
