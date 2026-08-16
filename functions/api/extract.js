/**
 * GET /api/extract?url=<目标网址>
 *
 * 服务端（Cloudflare 边缘）抓取目标页面 HTML，按优先级解析 favicon 地址。
 * 抓取失败（如目标站 WAF 拦截数据中心 IP、SPA 无声明）时逐级兜底：
 *   站点根目录 /favicon.ico → Google S2 图标服务 → DuckDuckGo 图标服务
 *   （图标服务均尝试「完整域名 → 主域名」两级，覆盖子域名站点）
 * 前端不调用任何外部公共代理，也不直连被墙域名。
 *
 * 返回 JSON：{ ok, url, preview, source, trace }
 *   trace 为各步骤执行轨迹，便于排查失败原因。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
    const { searchParams } = new URL(context.request.url);
    const trace = [];

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
                    source: '页面解析 rel="' + found.rel + '"',
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

    /* 2. 站点根目录 /favicon.ico */
    const guess = new URL('/favicon.ico', target.origin).href;
    const guessResult = await imageOk(guess);
    trace.push('/favicon.ico: ' + guessResult.msg);
    if (guessResult.ok) {
        return json({ ok: true, url: guess, preview: previewFor(guess), source: '站点默认路径 /favicon.ico', trace });
    }

    /* 3. 公共图标服务兜底：完整域名 → 主域名，Google S2 → DuckDuckGo */
    const hosts = dedupe([target.hostname, rootDomain(target.hostname)]);
    const services = [
        { name: 'Google 图标服务', make: function(h) { return 'https://www.google.com/s2/favicons?domain=' + h + '&sz=64'; } },
        { name: 'DuckDuckGo 图标服务', make: function(h) { return 'https://icons.duckduckgo.com/ip3/' + h + '.ico'; } }
    ];
    for (const svc of services) {
        for (const h of hosts) {
            const cand = svc.make(h);
            const r = await imageOk(cand);
            if (r.ok) {
                return json({
                    ok: true,
                    url: cand,
                    preview: previewFor(cand),
                    source: svc.name + ' · ' + h + '（兜底）',
                    trace: trace.concat(svc.name + '命中: ' + cand)
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

function previewFor(url) {
    /* 图标预览/打开走同域图片代理，被墙域名也能正常显示 */
    return '/api/icon?url=' + encodeURIComponent(url);
}

/* 探测候选地址是否为可用图片，返回 { ok, msg } 便于轨迹记录 */
async function imageOk(url) {
    try {
        const res = await fetch(url, {
            headers: { 'user-agent': UA, 'accept': 'image/*,*/*;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000)
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
