/*
 * zimuquan VIP 解锁脚本 (Surge http-response)
 * ------------------------------------------------------------------
 * 适用: https://zimuquan.top/index.php/vod/play/id/<vod_id>/sid/<n>/nid/<n>.html
 *       https://zimuquan.top/index.php/vod/detail/id/<vod_id>.html
 *
 * 原理:
 *   1. 站点播放页响应体是 <script>atob(...)</script> + document.write 双层混淆,
 *      服务端无法直接正则匹配播放信息, 故脚本先解码还原明文 HTML。
 *   2. 在明文 HTML 中原地注入客户端脚本, 劫持 VIP 遮罩(.popup)上的原「登录」按钮,
 *      改写成「直接播放」, 点击后移除遮罩并挂载播放器。
 *   3. 播放地址取自站点自身的未授权采集接口:
 *      /api.php/provide/vod/?ac=detail&ids=<vod_id>  ->  vod_play_url
 *      该接口与页面封面图同源一致, 对存活 CDN 线路直接 200。
 *   4. AES-128 加密的 HLS 由 hls.js / Safari 原生 HLS 自动取 key.key 解密,
 *      无需额外处理。
 *
 * 已知限制:
 *   zhuanma14.aeondigit.com 整条 CDN 线路回源 502(已枯死),
 *   命中该线路的视频无法播放, 页面会给出明确失败提示。
 */

var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* base64 解码, 不依赖 Surge 引擎的 atob */
function b64decode(input) {
  var str = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
  var out = [];
  var i = 0;
  while (i < str.length) {
    var e1 = B64CHARS.indexOf(str.charAt(i++));
    var e2 = B64CHARS.indexOf(str.charAt(i++));
    var e3 = B64CHARS.indexOf(str.charAt(i++));
    var e4 = B64CHARS.indexOf(str.charAt(i++));
    if (e1 < 0 || e2 < 0) break;
    out.push((e1 << 2) | (e2 >> 4));
    if (e3 >= 0 && str.charAt(i - 2) !== '=') out.push(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 >= 0 && str.charAt(i - 1) !== '=') out.push(((e3 & 3) << 6) | e4);
  }
  var bytes = out;
  var s = '';
  for (var k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
  /* latin1 -> utf8 */
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}

/* 逐层剥掉 URL 编码, 出现 HTML 标记即停 */
function unescapeAll(str) {
  var cur = str;
  for (var i = 0; i < 6; i++) {
    if (cur.indexOf('<') === 0 || cur.indexOf('<html') !== -1 || cur.indexOf('<!DOCTYPE') !== -1) break;
    var next;
    try { next = decodeURIComponent(cur); } catch (e) { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/* ---------------- 客户端注入代码 ---------------- */
var CLIENT = [
"(function () {",
"  'use strict';",
"  var m = location.pathname.match(/\\/vod\\/(?:play|detail)\\/id\\/(\\d+)/);",
"  var VOD = m ? m[1] : '';",
"  if (!VOD) return;",
"",
"  function q(s) { return document.querySelector(s); }",
"",
"  function killMask() {",
"    var list = document.querySelectorAll('.popup');",
"    for (var i = 0; i < list.length; i++) {",
"      if (list[i].parentNode) list[i].parentNode.removeChild(list[i]);",
"    }",
"  }",
"",
"  /* 苹果CMS vod_play_url 可能是 线路$$$线路 / 集数#集数 / 标题$地址 */",
"  function pickUrl(raw) {",
"    if (!raw) return '';",
"    var line = String(raw).split('$$$')[0];",
"    var ep = line.split('#')[0];",
"    var parts = ep.split('$');",
"    return String(parts[parts.length - 1]).trim();",
"  }",
"",
"  function fromApi(cb) {",
"    var xhr = new XMLHttpRequest();",
"    xhr.open('GET', '/api.php/provide/vod/?ac=detail&ids=' + VOD, true);",
"    xhr.onload = function () {",
"      try {",
"        var d = JSON.parse(xhr.responseText);",
"        var u = d && d.list && d.list[0] && d.list[0].vod_play_url;",
"        var p = pickUrl(u);",
"        if (p) { cb(p); return; }",
"      } catch (e) {}",
"      fromCover(cb);",
"    };",
"    xhr.onerror = function () { fromCover(cb); };",
"    xhr.send();",
"  }",
"",
"  /* 兜底: 遮罩背景图与播放源同目录, vod.jpg -> index.m3u8 */",
"  function fromCover(cb) {",
"    var p = q('.popup');",
"    if (!p) { cb(''); return; }",
"    var bg = p.style.backgroundImage || getComputedStyle(p).backgroundImage || '';",
"    var mm = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);",
"    if (mm) cb(mm[1].replace(/vod\\.jpg.*$/i, 'index.m3u8'));",
"    else cb('');",
"  }",
"",
"  function ensureHls(cb) {",
"    if (window.Hls) { cb(); return; }",
"    var probe = document.createElement('video');",
"    if (probe.canPlayType('application/vnd.apple.mpegurl')) { cb(); return; }",
"    var s = document.createElement('script');",
"    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';",
"    s.onload = cb;",
"    s.onerror = cb;",
"    document.head.appendChild(s);",
"  }",
"",
"  function mountPlayer(url) {",
"    var host = q('.container') || q('.detail .box') || q('.detail') || document.body;",
"    host.innerHTML = '';",
"    var box = document.createElement('div');",
"    box.style.cssText = 'background:#000;border-radius:8px;overflow:hidden';",
"    var v = document.createElement('video');",
"    v.controls = true;",
"    v.autoplay = true;",
"    v.setAttribute('playsinline', '');",
"    v.style.cssText = 'width:100%;max-height:76vh;display:block;background:#000';",
"    box.appendChild(v);",
"    host.appendChild(box);",
"    var tip = document.createElement('div');",
"    tip.style.cssText = 'font-size:12px;color:#888;margin:10px 0;word-break:break-all;line-height:1.6';",
"    tip.textContent = '直连源: ' + url;",
"    host.appendChild(tip);",
"    if (window.Hls && window.Hls.isSupported()) {",
"      var h = new window.Hls({ maxBufferLength: 30 });",
"      h.on(window.Hls.Events.ERROR, function (_e, data) {",
"        if (data && data.fatal) {",
"          tip.style.color = '#e74c3c';",
"          tip.textContent = '拉流失败(' + data.details + ') — 该 CDN 线路可能已失效: ' + url;",
"        }",
"      });",
"      h.loadSource(url);",
"      h.attachMedia(v);",
"    } else {",
"      v.src = url;",
"    }",
"    var pr = v.play();",
"    if (pr && pr.catch) pr.catch(function () {});",
"  }",
"",
"  function start(btn) {",
"    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = '解析中…'; }",
"    fromApi(function (u) {",
"      if (!u) {",
"        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '未取到播放地址'; }",
"        return;",
"      }",
"      killMask();",
"      ensureHls(function () { mountPlayer(u); });",
"    });",
"  }",
"",
"  function bind() {",
"    var mask = q('.popup');",
"    if (!mask) return false;",
"    var btn = mask.querySelector('.el-login-btn') || mask.querySelector('button');",
"    if (btn) {",
"      /* 只改文案, 事件统一交给下方委托处理, 避免双触发 */",
"      btn.textContent = '▶ 直接播放（免 VIP）';",
"      return true;",
"    }",
"    /* 遮罩存在但无按钮: 自建一个, 沿用同一 class 以复用委托 */",
"    var nb = document.createElement('button');",
"    nb.type = 'button';",
"    nb.className = 'el-login-btn';",
"    nb.textContent = '▶ 直接播放（免 VIP）';",
"    nb.style.cssText = 'display:block;margin:14px auto;padding:12px 26px;font-size:16px;font-weight:600;'",
"      + 'color:#1a1a1a;background:linear-gradient(135deg,#ffd76e,#ffb300);border:0;border-radius:26px;cursor:pointer';",
"    mask.appendChild(nb);",
"    return true;",
"  }",
"",
"  /* 事件委托: 即便页面自身 JS 重建了遮罩, 点击仍能被捕获 */",
"  document.addEventListener('click', function (ev) {",
"    var el = ev.target;",
"    while (el && el !== document) {",
"      if (el.classList && el.classList.contains('el-login-btn')) {",
"        ev.preventDefault();",
"        ev.stopPropagation();",
"        start(el);",
"        return false;",
"      }",
"      el = el.parentNode;",
"    }",
"  }, true);",
"",
"  /* 播放页 DOM 由 document.write 构建, 可能晚于 DOMContentLoaded, 故重试 */",
"  var tries = 0;",
"  function boot() {",
"    if (bind()) return;",
"    if (++tries > 40) return;",
"    setTimeout(boot, 250);",
"  }",
"  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);",
"  else boot();",
"})();"
].join('\n');

/* ---------------- 主流程 ---------------- */
(function () {
  var body = ($response && $response.body) || '';
  if (!body) { $done({}); return; }

  var html = body;
  var m = body.match(/atob\(\s*["']([A-Za-z0-9+/=\s]{40,})["']\s*\)/);

  if (m) {
    var dec = unescapeAll(b64decode(m[1]));
    if (dec.indexOf('<') !== -1 && /<\/body>|<\/html>|<div/i.test(dec)) html = dec;
  }

  var script = '<script>' + CLIENT + '<' + '/script>';

  /* 注意: 必须用函数式替换。若直接传字符串, 其内部的 $$ / $' / $& 会被
     String.replace 当作特殊模式解释, 注入代码里的 split('$$$') 会被破坏。 */
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, function () { return script + '</body>'; });
  } else {
    html = html + script;
  }

  $done({ body: html });
})();
