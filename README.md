 @name         WhatsApp Web 翻译助手
 @namespace    wa-translate
 @version      4.0.5
 @description  中文→多国语言：按客户自动识别语种，输入框一键翻译+发送；划词翻译。零依赖，不装服务。
 @match        https://web.whatsapp.com/*
 @grant        GM_xmlhttpRequest
 @grant        GM_setClipboard
 @grant        GM_setValue
 @grant        GM_getValue
 @grant        GM_registerMenuCommand
 @connect      clients5.google.com
 @connect      translate.googleapis.com
 @connect      api.mymemory.translated.net
 @connect      api.openai.com
 @connect      api.deepseek.com
 @connect      open.bigmodel.cn
 @connect      dashscope.aliyuncs.com
 @run-at       document-idle
