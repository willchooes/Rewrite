/**
 * zimuquan VIP 解锁 — Egern 版  (v4, 降温优化)
 * ------------------------------------------------------------------
 * 类型: http_response
 * 匹配: ^https?://(?:www\.)?zimuquan\.top/index\.php/vod/(?:play|detail)/
 *
 * 站点真实结构 (Vant UI):
 *   <div class="play_video">
 *     <i class="back"></i>
 *     <div class="show_poster" style="background-image:url(.../vod.jpg)">
 *       <div class="show_poster_title">此影片为VIP专享…</div>
 *       <a href="/index.php/user/login.html" class="show_poster_btn van-button">
 *         <span class="van-button__text">登录</span>
 *       </a>
 *     </div>
 *   </div>
 *
 * v4 相比 v3 的降温改动 (按功耗占比排序):
 *   1. 掐掉并行解码: Vant 遮罩只是覆盖层, 站点模板自带的播放器往往已在遮罩
 *      底下建好 video 并拉流; 我们再加一个播放器就是两路解码同时跑,
 *      iOS 上这是最直接的发热源。挂载前 pause + 清 src + load() 停掉它们。
 *   2. 硬解路径绝对优先: v3 的 ensureHls 把 window.Hls 检查排在原生探测之前,
 *      模板自带 hls.js 且浏览器 MSE 可用时会走 MSE + JS 软解 —— 逐帧 demux
 *      + 软解, 持续高温。v4 先探 canPlayType('application/vnd.apple.mpegurl'),
 *      原生可用则完全不下载/不解析 300KB 的 hls.js, 直接交 VideoToolbox 硬解。
 *   3. 软解兜底路径按播放器尺寸封顶码率 (capLevelToPlayerSize) 并回收后向缓冲
 *      (backBufferLength), 前向缓冲 20/40 → 12/24, 长播不再持续涨内存。
 *   4. 重挂载前真正释放旧播放器: pause + 清 src + load() + hls.destroy(),
 *      否则旧 video 的解码器与网络缓冲不会立刻归还。
 *   5. MutationObserver 观察根从 documentElement 收窄到 #app, head 里的
 *      样式/脚本插入不再唤醒回调。
 *   6. 点击委托在播放器挂载成功后注销, 播放期间拖进度条不再触发向上遍历。
 *   7. getComputedStyle 仅在 inline 样式为空时调用一次并缓存, 避免强制同步布局。
 *   8. 服务端: 定位 atob( 后用 indexOf 手工取载荷, 消除超长混淆体上的正则
 *      回溯, 也没有窗口长度上限; 注入脚本常量在模块顶层预拼, 不再每次响应拼接;
 *      超大 body 直接透传。UTF-8 解码改为分块批量转换, 减少大 body 的 CPU 尖峰。
 */

/* ---------- 纯手写 UTF-8 编解码, 不依赖 TextDecoder ---------- */
function utf8Decode(bytes) {
  const n = bytes.length;
  const CH = 8192;
  const buf = new Array(CH);
  let p = 0;
  let out = '';
  let i = 0;
  while (i < n) {
    /* 分块批量转换: 比逐字符字符串拼接快一个量级, 大 body 时 CPU 尖峰更小 */
    if (p >= CH - 2) {
      out += String.fromCharCode.apply(null, buf.slice(0, p));
      p = 0;
    }
    const c = bytes[i++];
    if (c < 0x80) {
      buf[p++] = c;
    } else if (c < 0xC0) {
      /* 非法续字节, 丢弃 */
    } else if (c < 0xE0) {
      buf[p++] = ((c & 0x1F) << 6) | (bytes[i++] & 0x3F);
    } else if (c < 0xF0) {
      buf[p++] = ((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
    } else {
      let cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
      cp -= 0x10000;
      buf[p++] = 0xD800 + (cp >> 10);
      buf[p++] = 0xDC00 + (cp & 0x3FF);
    }
  }
  if (p > 0) out += String.fromCharCode.apply(null, buf.slice(0, p));
  return out;
}

function utf8Encode(str) {
  const n = str.length;
  const out = new Uint8Array(n * 3);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      out[p++] = c;
    } else if (c < 0x800) {
      out[p++] = 0xC0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3F);
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
      out[p++] = 0xF0 | (cp >> 18);
      out[p++] = 0x80 | ((cp >> 12) & 0x3F);
      out[p++] = 0x80 | ((cp >> 6) & 0x3F);
      out[p++] = 0x80 | (cp & 0x3F);
    } else {
      out[p++] = 0xE0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3F);
      out[p++] = 0x80 | (c & 0x3F);
    }
  }
  return out.subarray(0, p);
}

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* base64 -> latin1 字符串(每字符即一字节) */
function b64decode(input) {
  const str = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
  const n = str.length;
  const bytes = new Uint8Array((n >> 2) * 3);
  let p = 0;
  let i = 0;
  while (i < n) {
    const e1 = B64CHARS.indexOf(str.charAt(i++));
    const e2 = B64CHARS.indexOf(str.charAt(i++));
    const e3 = B64CHARS.indexOf(str.charAt(i++));
    const e4 = B64CHARS.indexOf(str.charAt(i++));
    if (e1 < 0 || e2 < 0) break;
    bytes[p++] = (e1 << 2) | (e2 >> 4);
    if (e3 >= 0 && str.charAt(i - 2) !== '=') bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (e4 >= 0 && str.charAt(i - 1) !== '=') bytes[p++] = ((e3 & 3) << 6) | e4;
  }
  return utf8Decode(bytes.subarray(0, p));
}

/* 手工提取 atob("...") 的载荷。
   不用正则: [A-Za-z0-9+/=\s]{40,} 在畸形页面上的回溯虽然是一次性的线性扫描,
   但配合窗口截断会漏掉长载荷(真实播放页混淆体可达 30-80KB)。这里用
   indexOf 定位引号 + 单次字符类校验, 既没有长度上限也没有回溯风险。 */
function extractB64(s, from) {
  const n = s.length;
  let i = from;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    break;
  }
  const quote = s.charAt(i);
  if (quote !== '"' && quote !== "'") return '';
  const end = s.indexOf(quote, i + 1);
  if (end < 0) return '';
  const payload = s.slice(i + 1, end);
  if (payload.length < 40) return '';
  return /^[A-Za-z0-9+/=\s]+$/.test(payload) ? payload : '';
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
  if (window.__zqInjected) return;
  window.__zqInjected = true;

  var m = location.pathname.match(/\\/vod\\/(?:play|detail)\\/id\\/(\\d+)/);
  var VOD = m ? m[1] : '';
  if (!VOD) return;

  var DEBUG = /[?&]zqdebug/.test(location.search);
  function q(s) { return document.querySelector(s); }

  /* 一次性探测原生 HLS: 结果决定之后走硬解还是软解, 不再重复创建 video 探针 */
  var NATIVE_HLS = (function () {
    var p = document.createElement('video');
    return !!(p.canPlayType && p.canPlayType('application/vnd.apple.mpegurl'));
  })();

  /* 诊断条: 默认不创建, 只在 ?zqdebug 下启用, 避免任何常驻 DOM 开销 */
  var diag = null;
  function report(extra) {
    if (!DEBUG) return;
    if (!diag) {
      diag = document.createElement('div');
      diag.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;'
        + 'background:#ffb300;color:#111;font:12px/1.6 -apple-system,sans-serif;'
        + 'padding:5px 8px;text-align:center';
      if (document.body) document.body.appendChild(diag);
    }
    var poster = q('.show_poster');
    var btn = q('.show_poster_btn');
    diag.textContent = 'zimuquan v4 | vod=' + VOD
      + ' | 遮罩=' + (poster ? '有' : '无')
      + ' | 按钮=' + (btn ? '有' : '无')
      + ' | 解码=' + (NATIVE_HLS ? '原生硬解' : 'hls.js')
      + (extra ? ' | ' + extra : '');
  }

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

  /* 兜底: 封面图与索引文件同目录, .../vod.jpg -> .../index.m3u8 */
  var coverCache = '';
  function fromCover() {
    if (coverCache) return coverCache;
    var p = q('.show_poster');
    if (!p) return '';
    /* inline 样式优先; 只有为空时才碰 getComputedStyle, 它会强制同步布局 */
    var bg = p.style.backgroundImage;
    if (!bg) {
      try { bg = getComputedStyle(p).backgroundImage || ''; } catch (e) { bg = ''; }
    }
    var mm = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
    if (!mm) return '';
    coverCache = mm[1].replace(/vod\\.jpg.*$/i, 'index.m3u8');
    return coverCache;
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

  /* ---- 解码路径选择 ----
     原生 HLS 可用就绝不加载 hls.js: 省掉 300KB JS 的下载与解析, 且交给
     VideoToolbox 硬解。只有浏览器明确不支持原生 HLS 时才回落软解。 */
  var hlsState = 0; /* 0=未加载 1=加载中 2=可用 3=不可用 */
  function ensureHls(cb) {
    if (NATIVE_HLS) { cb(false); return; }
    if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) { cb(true); return; }
    if (hlsState !== 0) { cb(hlsState === 2); return; }
    hlsState = 1;
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    s.onload = function () {
      hlsState = (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) ? 2 : 3;
      cb(hlsState === 2);
    };
    s.onerror = function () { hlsState = 3; cb(false); };
    document.head.appendChild(s);
  }

  var hlsInst = null;

  /* 真正释放解码器与网络缓冲: 仅从 DOM 摘除 video 不会立刻归还资源 */
  function teardown() {
    if (hlsInst) {
      try { hlsInst.destroy(); } catch (e) {}
      hlsInst = null;
    }
    var v = document.getElementById('zq-video');
    if (v) {
      try { v.pause(); } catch (e) {}
      v.removeAttribute('src');
      try { v.load(); } catch (e) {}
    }
  }

  /* iOS 上多路解码并行是发热主因: Vant 遮罩只是一层覆盖, 站点模板自带的
     播放器通常已经在遮罩底下建好 video 并拉流。挂载前把它们逐个掐掉,
     只保留我们这一个解码器。元素本身不动, 避免模板 JS 拿到 null 报错。

     无条件释放而非判断 src 是否存在: 站点可能用 video.src 属性赋值,
     也可能由 hls.js 挂在 srcObject(ManagedMediaSource) 上, 两种都要断。 */
  function quiesce() {
    var vs = document.querySelectorAll('video');
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].id === 'zq-video') continue;
      try { vs[i].pause(); } catch (e) {}
      try {
        vs[i].removeAttribute('src');
        vs[i].srcObject = null;
        vs[i].load();
      } catch (e) {}
    }
  }

  function mountPlayer(url, useHls) {
    teardown();
    quiesce();

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
    box.style.cssText = 'background:#000;border-radius:8px;overflow:hidden;margin:0 auto;'
      + 'contain:content';
    var v = document.createElement('video');
    v.id = 'zq-video';
    v.controls = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('preload', 'metadata');
    v.style.cssText = 'width:100%;max-height:76vh;display:block;background:#000';
    box.appendChild(v);
    host.appendChild(box);

    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:12px;color:#888;margin:10px 12px;word-break:break-all;line-height:1.6';
    tip.textContent = '直连源: ' + url
      + (NATIVE_HLS ? ' — iOS 上全屏播放走系统播放器, 比内联更省电' : '');
    host.appendChild(tip);

    if (useHls && window.Hls) {
      /* 移动端省电配置: 按播放器实际尺寸封顶码率(4K 源缩到手机屏上解码量骤降),
         前向缓冲收紧, 后向缓冲回收(默认 Infinity 会让内存与 GC 压力持续增长) */
      hlsInst = new window.Hls({
        capLevelToPlayerSize: true,
        maxBufferLength: 12,
        maxMaxBufferLength: 24,
        backBufferLength: 30,
        enableWorker: true
      });
      hlsInst.on(window.Hls.Events.ERROR, function (_e, data) {
        if (data && data.fatal) {
          tip.style.color = '#e74c3c';
          tip.textContent = '拉流失败(' + data.details + ') — 该 CDN 线路可能已失效: ' + url;
        }
      });
      hlsInst.loadSource(url);
      hlsInst.attachMedia(v);
    } else {
      /* 原生路径: 交给系统硬解, 最省电 */
      v.src = url;
    }
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {});

    /* 播放器已就位, 撤掉全局捕获监听: 之后拖进度条/点控制条不再触发遍历 */
    document.removeEventListener('click', onDocClick, true);
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
      ensureHls(function (useHls) { mountPlayer(u, useHls); });
    });
  }

  /* 事件委托: 拦掉 .show_poster_btn 原本跳登录页的行为 */
  function isPosterBtn(el) {
    while (el && el !== document) {
      if (el.classList && (el.classList.contains('show_poster_btn') || el.classList.contains('zq-play-btn'))) return el;
      el = el.parentNode;
    }
    return null;
  }

  function onDocClick(ev) {
    var btn = isPosterBtn(ev.target);
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    start(btn);
  }
  document.addEventListener('click', onDocClick, true);

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
    /* 少一次查询: 按钮命中即返回, 海报层只在按钮缺席时才查 */
    var btn = q('.show_poster_btn');
    if (btn) {
      var t = btn.querySelector('.van-button__text') || btn;
      if (t.textContent !== '▶ 直接播放（免 VIP）') t.textContent = '▶ 直接播放（免 VIP）';
      btn.setAttribute('href', 'javascript:void(0)');
      report();
      return true;
    }
    if (q('.show_poster')) {
      makeFallback();
      report();
      return true;
    }
    return false;
  }

  /* 事件驱动: 只在 DOM 真的变化时检查一次, 不再做定时轮询空转 */
  if (bind()) return;

  var done = false;
  var mo = new MutationObserver(function () {
    if (done) return;
    if (bind()) {
      done = true;
      stopWatch();
    }
  });

  function stopWatch() {
    try { mo.disconnect(); } catch (e) {}
    clearTimeout(timer);
  }

  /* 观察根收窄到 Vant 挂载点: 不再因 head 里的样式/脚本插入而唤醒回调 */
  var root = document.getElementById('app') || document.body || document.documentElement;
  if (root) mo.observe(root, { childList: true, subtree: true });

  /* 一次性兜底: 2.5 秒后仍未出现 VIP 层就给出按钮并彻底停止观察 */
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    stopWatch();
    makeFallback();
    report('兜底按钮');
  }, 2500);
})();
`;

/* 模块顶层预拼一次, 避免每次响应都拼接 11KB 字符串 */
const INJECTED = '<script>' + CLIENT + '<' + '/script>';

/* 播放页混淆体约 30KB; 超出阈值说明不是目标页面形态, 直接透传省掉全量解码 */
const MAX_BODY = 2 * 1024 * 1024;

export default async function (ctx) {
  let bytes;
  try {
    bytes = new Uint8Array(await ctx.response.arrayBuffer());
  } catch (e) {
    return;
  }

  /* 长度预检: 详情页跳转壳约 264B, 播放页混淆体 >30KB */
  if (bytes.length < 400 || bytes.length > MAX_BODY) return;

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

  /* 内容预检: 只有 atob + document.write 的混淆页才需要改写, 其余原样放行 */
  const at = raw.indexOf('atob(');
  if (at < 0 || raw.indexOf('document.write') < 0) return;

  let html = raw;

  const payload = extractB64(raw, at + 5);
  if (payload) {
    const dec = unescapeAll(b64decode(payload));
    if (dec.includes('<') && /<\/body>|<\/html>|<div/i.test(dec)) html = dec;
  }

  if (html.indexOf('show_poster') < 0 && html.indexOf('play_video') < 0) return;

  /* 必须用函数式替换: 字符串形式下 $$ / $' / $& 会被 String.replace 特殊解释,
     注入代码里的 split('$$$') 会被破坏。 */
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, () => INJECTED + '</body>');
  } else {
    html = html + INJECTED;
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
