# 网站图标地址提取工具（Cloudflare Pages 版）

纯前端页面 + Cloudflare Pages Functions 同域代理，无任何外部公共代理依赖。

## 架构

```
favicon-tool/
├── index.html                  # 前端页面（提取 / 预览 / 复制）
├── functions/
│   └── api/
│       ├── extract.js          # GET /api/extract?url=... 抓取页面并解析 favicon，逐级兜底
│       └── icon.js             # GET /api/icon?url=...   图标同域转发（预览/打开用）
└── README.md
```

请求链路：

1. 前端 `GET /api/extract?url=<目标网址>`（同域，无跨域问题）
2. 边缘服务端抓取目标站 HTML → 按 `rel="icon"` → `rel="shortcut icon"` → `rel="apple-touch-icon"` 优先级解析，相对路径自动转绝对地址
3. 页面解析失败 → 探测站点 `/favicon.ico` → Google S2 → DuckDuckGo 图标服务（均尝试「完整域名 → 主域名」两级，全部在 CF 服务端完成，用于目标站 WAF 拦截数据中心 IP 或 SPA 无 favicon 声明的场景）
4. 返回 `{ url: 真实图标地址, preview: /api/icon 同域预览地址, source: 来源, trace: 各步骤轨迹 }`；前端预览与"新标签页打开"走 `/api/icon` 转发，浏览器不直连被墙域名
5. 排查失败原因：直接访问 `/api/extract?url=目标网址`，看返回 JSON 里的 `trace` 数组即可知道每一步的探测结果

## 部署（wrangler CLI，推荐）

```bash
cd favicon-tool
npx wrangler login          # 首次登录
npx wrangler pages deploy . --project-name=favicon-tool
```

部署完成会得到 `https://favicon-tool.pages.dev`。

## 部署（Dashboard 拖拽上传）

Cloudflare Dashboard → Workers & Pages → Create → Pages → Upload assets，
直接拖入 `favicon-tool` 整个文件夹（含 `functions/` 目录，Direct Upload 同样支持 Functions）。

## 本地开发调试

```bash
cd favicon-tool
npx wrangler pages dev .
# 打开 http://localhost:8788 ，Functions 会随本地服务一起生效
```

## 说明

- `extract` 接口缓存 10 分钟，`icon` 转发缓存 24 小时（边缘自动命中）
- 内置防 SSRF 校验：仅允许公网 http/https 地址，拒绝内网/环回/链路本地地址
- HTML 抓取超时 12s，只截取前 500KB（favicon 声明基本都在 `<head>` 内）
