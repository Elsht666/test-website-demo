/**
 * GET /api/icon?url=<图标地址>
 *
 * 同域图片转发代理：前端 <img> 与"在新标签页打开"均经由此接口加载图标，
 * 避免浏览器直连被墙域名（如 DuckDuckGo 图标服务）或触发目标站防盗链。
 * 响应带长缓存，边缘节点自动命中。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
    const { searchParams } = new URL(context.request.url);

    let target;
    try {
        const raw = (searchParams.get('url') || '').trim();
        if (!raw) return text('缺少 url 参数', 400);
        target = new URL(raw);
    } catch (e) {
        return text('网址格式不正确', 400);
    }

    /* 防 SSRF：仅允许公网 http/https */
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return text('仅支持 http/https', 400);
    const h = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return text('不允许的地址', 400);
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return text('不允许的地址', 400);
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return text('不允许的地址', 400);
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return text('不允许的地址', 400);

    let upstream;
    try {
        upstream = await fetch(target.href, {
            headers: { 'user-agent': UA, 'accept': 'image/*,*/*;q=0.8', 'referer': target.origin + '/' },
            redirect: 'follow',
            signal: AbortSignal.timeout(10000)
        });
    } catch (e) {
        return text('上游请求失败', 504);
    }
    if (!upstream.ok) return text('上游返回 ' + upstream.status, 502);

    const ct = upstream.headers.get('content-type') || 'image/png';
    if (!/^(image\/|application\/octet-stream)/i.test(ct)) return text('目标不是图片', 415);

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': ct,
            'cache-control': 'public, max-age=86400',
            'access-control-allow-origin': '*'
        }
    });
}

function text(msg, status) {
    return new Response(msg, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
}
