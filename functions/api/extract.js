/**
 * GET /api/extract?url=<目标网址>
 *
 * 服务端（Cloudflare 边缘）抓取目标页面 HTML，按优先级解析 favicon 地址，
 * 依次兜底：站点根目录 /favicon.ico → DuckDuckGo 图标服务。
 * 前端不再调用任何外部公共代理，也不直连被墙域名。
 *
 * 返回 JSON：{ ok: true, url: 真实图标地址, preview: 同域预览地址, source: 来源说明 }
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
    const { searchParams } = new URL(context.request.url);

    let target;
    try {
        const raw = (searchParams.get('url') || '').trim();
        if (!raw) return json({ ok: false, error: '缺少 url 参数' }, 400);
        target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    } catch (e) {
        return json({ ok: false, error: '网址格式不正确' }, 400);
    }
    if (!isPublicHttpUrl(target)) {
        return json({ ok: false, error: '仅支持公网 http/https 网址' }, 400);
    }

    /* 1. 抓取页面 HTML，解析 <link rel> */
    try {
        const res = await fetch(target.href, {
            headers: {
                'user-agent': UA,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(12000)
        });
        if (res.ok) {
            const finalUrl = res.url || target.href; /* 以重定向后的地址解析相对路径 */
            let html = await res.text();
            if (html.length > 500000) html = html.slice(0, 500000); /* 只需 head 区，截断防超大页面 */
            const found = pickIcon(parseLinks(html), finalUrl);
            if (found) {
                return json({
                    ok: true,
                    url: found.url,
                    preview: previewFor(found.url),
                    source: '页面解析 rel="' + found.rel + '"'
                });
            }
        }
    } catch (e) { /* 超时或网络错误，继续兜底 */ }

    /* 2. 站点根目录 /favicon.ico */
    const guess = new URL('/favicon.ico', target.origin).href;
    if (await imageOk(guess)) {
        return json({
            ok: true,
            url: guess,
            preview: previewFor(guess),
            source: '站点默认路径 /favicon.ico'
        });
    }

    /* 3. DuckDuckGo 图标服务（后端探测转发，前端不直连） */
    const ddg = 'https://icons.duckduckgo.com/ip3/' + target.hostname + '.ico';
    if (await imageOk(ddg)) {
        return json({
            ok: true,
            url: ddg,
            preview: previewFor(ddg),
            source: 'DuckDuckGo 图标服务（兜底）'
        });
    }

    return json({ ok: false, error: '未找到图标，请检查网址是否正确' }, 404);
}

/* ==================== 工具函数 ==================== */

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=600'
        }
    });
}

function previewFor(url) {
    /* 图标预览/打开走同域图片代理，被墙域名也能正常显示 */
    return '/api/icon?url=' + encodeURIComponent(url);
}

async function imageOk(url) {
    try {
        const res = await fetch(url, {
            headers: { 'user-agent': UA, 'accept': 'image/*,*/*;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000)
        });
        const ok = res.ok && !/text\/html/i.test(res.headers.get('content-type') || '');
        if (res.body) res.body.cancel().catch(function() {}); /* 只探测不下载 */
        return ok;
    } catch (e) {
        return false;
    }
}

/* 防 SSRF：仅允许公网 http/https 地址 */
function isPublicHttpUrl(u) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return false;
    return true;
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

/* Worker 环境无 DOMParser，用正则提取 <link> 的 rel/href 属性 */
function getAttr(tag, name) {
    const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    const m = tag.match(re);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

function parseLinks(html) {
    const out = [];
    const re = /<link\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const rel = getAttr(m[0], 'rel');
        const href = getAttr(m[0], 'href');
        if (rel && href) {
            out.push({
                rel: decodeEntities(rel).toLowerCase().trim(),
                href: decodeEntities(href).trim()
            });
        }
    }
    return out;
}

/* 优先级：rel="icon"(1) → rel="shortcut icon"(2) → rel="apple-touch-icon"(3)，相对路径转绝对 */
function pickIcon(links, base) {
    let best = null, bestPri = Infinity;
    for (const item of links) {
        if (item.href.startsWith('data:')) continue; /* 内联 data URI 不是可复制的地址，跳过 */
        const tokens = item.rel.split(/\s+/);
        let pri = null;
        if (tokens.indexOf('icon') !== -1) {
            pri = tokens.indexOf('shortcut') !== -1 ? 2 : 1;
        } else if (tokens.indexOf('apple-touch-icon') !== -1 ||
                   tokens.indexOf('apple-touch-icon-precomposed') !== -1) {
            pri = 3;
        }
        if (pri !== null && pri < bestPri) {
            try {
                best = { url: new URL(item.href, base).href, rel: item.rel };
                bestPri = pri;
            } catch (e) { /* 非法 href，跳过 */ }
        }
    }
    return best;
}
