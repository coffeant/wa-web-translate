## 脚本标识
- **名称**：WhatsApp Web 翻译助手
- **命名空间**：`wa-translate`
- **版本**：4.1.2
- **说明**：中文→多国语言；按客户自动识别语种，输入框一键翻译+发送，划词翻译；零依赖，不装服务

## 运行范围
- `https://web.whatsapp.com/*`

## 权限（@grant）
1. `GM_xmlhttpRequest` — 跨域请求翻译接口
2. `GM_setClipboard` — 复制译文兜底
3. `GM_setValue` / `GM_getValue` — 持久化配置
4. `GM_registerMenuCommand` — 油猴菜单入口

## 允许的域名（@connect）
- `clients5.google.com`（主力机翻）
- `translate.googleapis.com`
- `api.mymemory.translated.net`（兜底机翻）
- `api.openai.com` / `api.deepseek.com` / `open.bigmodel.cn` / `dashscope.aliyuncs.com`（可选 AI 翻译）

## 执行时机
- `@run-at` → `document-idle`
