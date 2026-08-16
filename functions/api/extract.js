/**
 * GET /api/extract?url=<目标网址>
 *
 * 服务端（Cloudflare 边缘）按以下顺序解析 favicon，命中即停：
 *   1. 抓取目标页 HTML，解析 <link rel> 原生图标地址
 *   2. 并行探测站点原生路径：完整域名 + 主域名 × /favicon.ico|.png|.svg、/apple-touch-icon.png
 *   3. Google S2 → DuckDuckGo 图标缓存（最后兜底）
 *
 * 关键约束：返回给用户复制的 url 永远「国内可达」——
 *   原生命中 → 站点自己域名下的地址；
 *   图标服务兜底 → 改写为本站 /api/icon 绝对代理地址（不再输出 Google 直链）。
 *
 * 返回 JSON：{ ok, url, preview, source, fallback, trace }
 *   fallback=true 表示来自图标缓存且地址已代理化；前端可据此再尝试浏览器直探原生路径。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
    const reqUrl = new URL(context.request.url);
    const myOrigin = reqUrl.origin; /* 用于构造本站绝对代理地址 */
    const trace = [];

    let target;
    try {
        const raw = (reqUrl.searchParams.get('url') || '').trim();
        if (!raw) return json({ ok: false, error: '缺少 url 参数' }, 400);
        target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    } catch (e) {
        return json({ ok: false, error: '网址格式不正确' }, 400);
    }
    if (!isPublicHttpUrl(target)) {
        return json({ ok: false, error: '仅支持公网 http/https 网址' }, 400);
    }

    const hosts = dedupe([target.hostname, rootDomain(target.hostname)]);

    /* 1. 抓取页面 HTML，解析 <link rel> 原生图标 */
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
            if (html.length > 500000) html = html.slice(0, 500000);
            const found = pickIcon(parseLinks(html), finalUrl);
            if (found) {
                return json({
                    ok: true,
                    url: found.url,
                    preview: proxyUrl(myOrigin, found.url),
                    source: '页面解析 rel="' + found.rel + '"',
                    fallback: false,
                    trace: trace.concat('页面解析成功 rel=' + found.rel)
                });
            }
            trace.push('页面已获取(' + html.length + '字节)但未发现 favicon 声明');
        } else {
            trace.push('页面请求被拒 HTTP ' + res.status + '（目标站可能拦截数据中心 IP）');
        }
    } catch (e) {
        trace.push('页面请求失败: ' + (e && e.name === 'TimeoutError' ? '超时' : '网络错误'));
    }

    /* 2. 并行探测站点原生路径（完整域名 + 主域名），命中即为站点自己的地址 */
    const paths = ['/favicon.ico', '/favicon.png', '/favicon.svg', '/apple-touch-icon.png'];
    const natives = [];
    for (const h of hosts) for (const p of paths) natives.push('https://' + h + p);
    const probes = await Promise.all(natives.map(function(u) { return imageOk(u, 5000); }));
    for (let i = 0; i < natives.length; i++) {
        if (probes[i].ok) {
            trace.push('原生路径命中: ' + natives[i]);
            return json({
                ok: true,
                url: natives[i],
                preview: proxyUrl(myOrigin, natives[i]),
                source: '站点原生路径 ' + natives[i].replace(/^https?:\/\//, ''),
                fallback: false,
                trace: trace
            });
        }
    }
    trace.push('原生路径(' + natives.length + '个)探测均未命中');

    /* 3. 图标缓存服务兜底：地址一律改写为本站代理，保证复制出去可打开 */
    const services = [
        { name: 'Google 图标缓存', make: function(h) { return 'https://www.google.com/s2/favicons?domain=' + h + '&sz=64'; } },
        { name: 'DuckDuckGo 图标缓存', make: function(h) { return 'https://icons.duckduckgo.com/ip3/' + h + '.ico'; } }
    ];
    for (const svc of services) {
        for (const h of hosts) {
            const cand = svc.make(h);
            const r = await imageOk(cand, 6000);
            if (r.ok) {
                trace.push(svc.name + '命中(' + h + ')，地址已代理化');
                const via = proxyUrl(myOrigin, cand);
                return json({
                    ok: true,
                    url: via,
                    preview: via,
                    source: svc.name + ' · ' + h + '（经本站代理）',
                    fallback: true,
                    trace: trace
                });
            }
            trace.push(svc.name + '(' + h + '): ' + r.msg);
        }
    }

    return json({ ok: false, error: '未找到图标，请检查网址是否正确', trace }, 404);
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

/* 构造本站 /api/icon 绝对代理地址 */
function proxyUrl(origin, url) {
    return origin + '/api/icon?url=' + encodeURIComponent(url);
}

/* 探测候选地址是否为可用图片，返回 { ok, msg } 便于轨迹记录 */
async function imageOk(url, timeoutMs) {
    try {
        const res = await fetch(url, {
            headers: { 'user-agent': UA, 'accept': 'image/*,*/*;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs || 8000)
        });
        const ct = res.headers.get('content-type') || '';
        let msg;
        if (!res.ok) { msg = 'HTTP ' + res.status; }
        else if (/text\/html/i.test(ct)) { msg = '返回的是HTML而非图片'; }
        else { msg = 'OK'; }
        if (res.body) res.body.cancel().catch(function() {}); /* 只探测不下载 */
        return { ok: res.ok && !/text\/html/i.test(ct), msg };
    } catch (e) {
        return { ok: false, msg: e && e.name === 'TimeoutError' ? '超时' : '网络错误' };
    }
}

function dedupe(arr) {
    const seen = {};
    const out = [];
    for (const x of arr) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } }
    return out;
}

/* 提取主域名：platform.deepseek.com → deepseek.com，xxx.com.cn → xxx.com.cn */
function rootDomain(hostname) {
    const h = hostname.toLowerCase();
    let m = h.match(/([a-z0-9-]+\.(?:com|net|org|gov|edu|ac|co)\.[a-z]{2})$/);
    if (m) return m[1];
    m = h.match(/([a-z0-9-]+\.[a-z]{2,})$/);
    return m ? m[1] : h;
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

/* 优先级：rel="icon"(1) → rel="shortcut icon"(2) → rel="apple-touch-icon"(3) → rel="alternate icon"(4)，相对路径转绝对 */
function pickIcon(links, base) {
    let best = null, bestPri = Infinity;
    for (const item of links) {
        if (item.href.startsWith('data:')) continue; /* 内联 data URI 不是可复制的地址，跳过 */
        const tokens = item.rel.split(/\s+/);
        let pri = null;
        if (tokens.indexOf('icon') !== -1) {
            if (tokens.indexOf('shortcut') !== -1) pri = 2;
            else if (tokens.indexOf('alternate') !== -1) pri = 4;
            else pri = 1;
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
