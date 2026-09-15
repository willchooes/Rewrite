/**
 * zimuquan VIP 解锁 — Egern 版  (v2, 选择器已按真实 DOM 校正)
 * ------------------------------------------------------------------
 * 类型: http_response
 * 匹配: ^https?://(?:www\.)?zimuquan\.top/index\.php/vod/(?:play|detail)/
 *
 * 站点真实结构 (Vant UI, 非 Element UI):
 *   <div class="play_video">
 *     <i class="back" onClick="history.back(-1)"></i>
 *     <div class="show_poster" style="background-image:url(.../vod.jpg)">
 *       <div class="show_poster_title">此影片为VIP专享…</div>
 *       <a href="/index.php/user/login.html" class="show_poster_btn van-button …">
 *         <span class="van-button__text">登录</span>
 *       </a>
 *     </div>
 *   </div>
 *
 * 流程:
 *   1. 响应可能带 content-encoding: gzip, Egern 交给脚本的是原始字节,
 *      故按 gzip 魔数(1f 8b)判断并解压, 再还原 atob+decodeURIComponent 混淆。
 *   2. 在明文 HTML 中注入客户端脚本: 把 .show_poster_btn 改写为
 *      「▶ 直接播放（免 VIP）」并劫持其跳转, 点击后就地挂载播放器。
 *   3. 播放地址取自未授权采集接口
 *      /api.php/provide/vod/?ac=detail&ids=<vod_id> 的 vod_play_url;
 *      失败则回退到封面图同目录: .../vod.jpg -> .../index.m3u8。
 *   4. 输出时按原编码压回, 不改动 content-encoding 头。
 */

/* ---------- 纯手写 UTF-8 编解码, 不依赖 TextDecoder ---------- */
function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xC0) {
      /* 非法续字节, 丢弃 */
    } else if (c < 0xE0) {
      out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
    } else if (c < 0xF0) {
      out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
    } else {
      let cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return out;
}

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  return new Uint8Array(out);
}

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* base64 -> latin1 字符串(每字符即一字节) */
function b64decode(input) {
  const str = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  let i = 0;
  while (i < str.length) {
    const e1 = B64CHARS.indexOf(str.charAt(i++));
    const e2 = B64CHARS.indexOf(str.charAt(i++));
    const e3 = B64CHARS.indexOf(str.charAt(i++));
    const e4 = B64CHARS.indexOf(str.charAt(i++));
    if (e1 < 0 || e2 < 0) break;
    bytes.push((e1 << 2) | (e2 >> 4));
    if (e3 >= 0 && str.charAt(i - 2) !== '=') bytes.push(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 >= 0 && str.charAt(i - 1) !== '=') bytes.push(((e3 & 3) << 6) | e4);
  }
  let s = '';
  for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
  return s;
}

/* 逐层剥离 URL 编码, 出现 HTML 标记即停 */
function unescapeAll(str) {
  let cur = str;
  for (let i = 0; i < 6; i++) {
    if (cur.indexOf('<') === 0 || cur.includes('<html') || cur.includes('<!DOCTYPE')) break;
    let next;
    try { next = decodeURIComponent(cur); } catch (e) { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/* ---------------- 客户端注入代码 ---------------- */
const CLIENT = `
(function () {
  'use strict';
  var m = location.pathname.match(/\\/vod\\/(?:play|detail)\\/id\\/(\\d+)/);
  var VOD = m ? m[1] : '';
  if (!VOD) return;

  function q(s) { return document.querySelector(s); }

  /* ---- 诊断条: 确认脚本是否真的执行到浏览器 ---- */
  var diag = null;
  function makeDiag() {
    if (diag) return diag;
    diag = document.createElement('div');
    diag.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;'
      + 'background:#ffb300;color:#111;font:12px/1.6 -apple-system,sans-serif;'
      + 'padding:5px 8px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)';
    var x = document.createElement('span');
    x.textContent = ' ✕';
    x.style.cssText = 'position:absolute;right:10px;top:4px;cursor:pointer;font-weight:700';
    x.onclick = function () { if (diag && diag.parentNode) diag.parentNode.removeChild(diag); diag = null; };
    diag.appendChild(x);
    if (document.body) document.body.appendChild(diag);
    return diag;
  }

  function report(extra) {
    var d = makeDiag();
    if (!d) return;
    var poster = q('.show_poster');
    var btn = q('.show_poster_btn');
    var txt = 'zimuquan v2 | vod=' + VOD
      + ' | 遮罩=' + (poster ? '有' : '无')
      + ' | 按钮=' + (btn ? '有' : '无');
    if (extra) txt += ' | ' + extra;
    var back = d.lastChild;
    d.textContent = txt;
    if (back && back.parentNode === d) d.appendChild(back);
  }

  /* ---- 取源 ---- */
  /* 苹果CMS vod_play_url 形态: 线路A$$$线路B / 集1#集2 / 标题$地址 */
  function pickUrl(raw) {
    if (!raw) return '';
    var lines = String(raw).split('$$$');
    for (var i = 0; i < lines.length; i++) {
      var ep = lines[i].split('#')[0];
      var parts = ep.split('$');
      var u = String(parts[parts.length - 1]).trim();
      if (/^https?:\\/\\//.test(u)) return u;
    }
    return '';
  }

  function fromCover() {
    var p = q('.show_poster');
    if (!p) return '';
    var bg = p.style.backgroundImage || getComputedStyle(p).backgroundImage || '';
    var mm = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
    if (!mm) return '';
    /* 封面图与索引文件同目录: .../vod.jpg -> .../index.m3u8 */
    return mm[1].replace(/vod\\.jpg.*$/i, 'index.m3u8');
  }

  function fromApi(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api.php/provide/vod/?ac=detail&ids=' + VOD, true);
    xhr.onload = function () {
      try {
        var d = JSON.parse(xhr.responseText);
        var u = d && d.list && d.list[0] && d.list[0].vod_play_url;
        var p = pickUrl(u);
        if (p) { cb(p); return; }
      } catch (e) {}
      cb(fromCover());
    };
    xhr.onerror = function () { cb(fromCover()); };
    xhr.send();
  }

  /* ---- 播放器 ---- */
  function ensureHls(cb) {
    if (window.Hls) { cb(); return; }
    var probe = document.createElement('video');
    if (probe.canPlayType('application/vnd.apple.mpegurl')) { cb(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    s.onload = cb;
    s.onerror = cb;
    document.head.appendChild(s);
  }

  function mountPlayer(url) {
    /* 只摘掉 VIP 海报层, 保留 .back 返回按钮 */
    var posters = document.querySelectorAll('.show_poster');
    for (var i = 0; i < posters.length; i++) {
      if (posters[i].parentNode) posters[i].parentNode.removeChild(posters[i]);
    }
    var host = q('.play_video') || q('.video') || q('#app') || document.body;

    var old = q('#zq-player-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.id = 'zq-player-box';
    box.style.cssText = 'background:#000;border-radius:8px;overflow:hidden;margin:0 auto';

    var v = document.createElement('video');
    v.id = 'zq-video';
    v.controls = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.style.cssText = 'width:100%;max-height:76vh;display:block;background:#000';
    box.appendChild(v);
    host.appendChild(box);

    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:12px;color:#888;margin:10px 12px;word-break:break-all;line-height:1.6';
    tip.textContent = '直连源: ' + url;
    host.appendChild(tip);

    if (window.Hls && window.Hls.isSupported()) {
      var h = new window.Hls({ maxBufferLength: 30 });
      h.on(window.Hls.Events.ERROR, function (_e, data) {
        if (data && data.fatal) {
          tip.style.color = '#e74c3c';
          tip.textContent = '拉流失败(' + data.details + ') — 该 CDN 线路可能已失效: ' + url;
        }
      });
      h.loadSource(url);
      h.attachMedia(v);
    } else {
      v.src = url;
    }
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {});
  }

  var busy = false;
  function start(btn) {
    if (busy) return;
    busy = true;
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '.6';
      var t = btn.querySelector('.van-button__text') || btn;
      t.textContent = '解析中…';
    }
    report('解析中');
    fromApi(function (u) {
      if (!u) {
        busy = false;
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        report('未取到地址');
        return;
      }
      report('已取源, 挂载播放器');
      ensureHls(function () { mountPlayer(u); });
    });
  }

  /* ---- 事件委托: 拦掉 .show_poster_btn 原本跳登录页的行为 ---- */
  function isPosterBtn(el) {
    while (el && el !== document) {
      if (el.classList && (el.classList.contains('show_poster_btn') || el.classList.contains('zq-play-btn'))) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener('click', function (ev) {
    var btn = isPosterBtn(ev.target);
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    start(btn);
    return false;
  }, true);

  /* ---- 改写按钮 / 兜底注入 ---- */
  var fallback = null;
  function makeFallback() {
    if (fallback && fallback.parentNode) return fallback;
    fallback = document.createElement('button');
    fallback.type = 'button';
    fallback.className = 'zq-play-btn';
    fallback.textContent = '▶ 直接播放（免 VIP）';
    fallback.style.cssText = 'display:block;margin:14px auto;padding:12px 26px;font-size:16px;'
      + 'font-weight:600;color:#1a1a1a;border:0;border-radius:26px;cursor:pointer;'
      + 'background:linear-gradient(135deg,#ffd76e,#ffb300);position:relative;z-index:99999';
    var host = q('.play_video') || q('.video') || q('#app') || document.body;
    if (host) host.appendChild(fallback);
    return fallback;
  }

  function bind() {
    var poster = q('.show_poster');
    var btn = q('.show_poster_btn');
    if (btn) {
      var t = btn.querySelector('.van-button__text') || btn;
      if (t.textContent !== '▶ 直接播放（免 VIP）') t.textContent = '▶ 直接播放（免 VIP）';
      btn.setAttribute('href', 'javascript:void(0)');
      report();
      return true;
    }
    if (poster) {
      /* 有遮罩但没按钮: 补一个 */
      makeFallback();
      report();
      return true;
    }
    return false;
  }

  var tries = 0;
  function boot() {
    if (bind()) return;
    if (++tries > 40) {
      /* 10 秒仍未出现 VIP 层: 直接给兜底按钮, 保证一定有入口 */
      makeFallback();
      report('兜底按钮');
      return;
    }
    setTimeout(boot, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;

export default async function (ctx) {
  let bytes;
  try {
    bytes = new Uint8Array(await ctx.response.arrayBuffer());
  } catch (e) {
    return;
  }
  if (!bytes.length) return;

  /* 按 gzip 魔数判断: 1f 8b */
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let raw;
  if (isGzip) {
    let un = null;
    try { un = await ctx.compress.gunzip(bytes); } catch (e) { un = null; }
    if (!un) return; /* 解压失败则原样透传, 不做破坏性改写 */
    raw = utf8Decode(un);
  } else {
    raw = utf8Decode(bytes);
  }

  let html = raw;
  const m = raw.match(/atob\(\s*["']([A-Za-z0-9+/=\s]{40,})["']\s*\)/);

  if (m) {
    const dec = unescapeAll(b64decode(m[1]));
    if (dec.includes('<') && /<\/body>|<\/html>|<div/i.test(dec)) html = dec;
  }

  const injected = '<script>' + CLIENT + '<' + '/script>';

  /* 必须用函数式替换: 字符串形式下 $$ / $' / $& 会被 String.replace 特殊解释,
     注入代码里的 split('$$$') 会被破坏。 */
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, () => injected + '</body>');
  } else {
    html = html + injected;
  }

  /* 原编码压回, 不动 content-encoding 头, 避免客户端解压失败 */
  if (isGzip) {
    try {
      const gz = await ctx.compress.gzip(utf8Encode(html));
      if (gz) return { body: gz };
    } catch (e) {}
    return { body: html };
  }
  return { body: html };
}
