/**
 * GET /api/resolve?url=<跳转链接>
 *
 * 服务端（Cloudflare 边缘）跟随重定向，解析出最终可加速的真实下载直链。
 * 适用场景：central.github.com 等版本分发「latest」跳转链接、无扩展名的动态直链——
 * 这类链接本身 302 跳转，gh-proxy 系列加速通道无法直接拼接，需先解析成
 * GitHub 系域名下的真实资产地址再交给前端生成加速链接。
 *
 * 解析策略：
 *   逐跳手动跟随重定向（最多 8 跳），每跳校验仍为公网地址（防 SSRF）；
 *   一旦落在 GitHub 系域名（github.com / *.githubusercontent.com 等）即提前截停返回，
 *   避免跟到带签名的 CDN 临时地址（如 objects.githubusercontent.com 的过期直链）。
 *
 * 返回 JSON：{ ok, url, status, contentType, hops, error }
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 8;

/* GitHub 系域名：到达即视为可加速直链，无需继续跟随（这些域名 gh-proxy 系列均可拼接） */
const GH_FAMILY = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$|(^|\.)github\.io$|(^|\.)githubassets\.com$/i;

export async function onRequestGet(context) {
    const reqUrl = new URL(context.request.url);

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

    const hops = [];
    let current = target.href;
    let status = 0;
    let contentType = '';

    try {
        for (let i = 0; i <= MAX_REDIRECTS; i++) {
            /* 已落在 GitHub 系域名：本身就是可加速直链，直接返回 */
            const curUrl = new URL(current);
            if (GH_FAMILY.test(curUrl.hostname)) {
                return json({ ok: true, url: current, status, contentType, hops });
            }
            if (i === MAX_REDIRECTS) {
                /* 跳数用尽仍未到达 GitHub 系域名：返回最后落点，由前端校验是否可用 */
                return json({ ok: true, url: current, status, contentType, hops, note: 'max-hops' });
            }

            const res = await fetch(current, {
                headers: { 'user-agent': UA, 'accept': '*/*' },
                redirect: 'manual',
                signal: AbortSignal.timeout(15000)
            });
            status = res.status;
            contentType = res.headers.get('content-type') || '';
            if (res.body) res.body.cancel().catch(function() {}); /* 只看跳转不下载内容 */

            const loc = res.headers.get('location');
            if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && loc) {
                let next;
                try { next = new URL(loc, current); } catch (e) { break; }
                if (!isPublicHttpUrl(next)) {
                    return json({ ok: false, error: '重定向指向内网地址，已中止', hops }, 400);
                }
                current = next.href;
                hops.push(current);
                continue;
            }

            /* 非重定向响应：当前地址即最终地址 */
            return json({ ok: true, url: current, status, contentType, hops });
        }
        return json({ ok: false, error: '重定向次数过多', hops }, 502);
    } catch (e) {
        const msg = e && e.name === 'TimeoutError' ? '解析超时' : '解析失败（网络错误）';
        return json({ ok: false, error: msg, hops }, 502);
    }
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

/* 防 SSRF：仅允许公网 http/https 地址（与 extract.js 同一套规则） */
function isPublicHttpUrl(u) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return false;
    return true;
}
