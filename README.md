# Rewrite

代理客户端重写脚本集合。

## zimuquan VIP 解锁

解除 `zimuquan.top`（苹果CMS V10）视频播放页的 VIP 遮罩：进入播放页后，遮罩上的「登录」按钮会被改写为「▶ 直接播放（免 VIP）」，点击即在原地挂载播放器播放。

提供 Egern 与 Surge 两套实现。两者的脚本运行时 API 完全不同，请勿混用。

### 目录结构

```
.
├── egern/
│   ├── zimuquan.yaml         # Egern 模块（远程脚本版，引用本仓库 raw）
│   ├── zimuquan.local.yaml   # Egern 模块（本地脚本版，引用同目录 zimuquan.js）
│   └── zimuquan.js           # Egern http_response 脚本
└── surge/
    ├── zimuquan.sgmodule        # Surge 模块（远程脚本版）
    ├── zimuquan.local.sgmodule  # Surge 模块（本地脚本版）
    └── zimuquan.js              # Surge http_response 脚本
```

### Egern 使用

在线模块地址：

```
https://raw.githubusercontent.com/willchooes/Rewrite/refs/heads/main/egern/zimuquan.yaml
```

在主配置里引用，或在 Egern 界面添加该模块 URL：

```yaml
modules:
  - url: "https://raw.githubusercontent.com/willchooes/Rewrite/refs/heads/main/egern/zimuquan.yaml"
    enabled: true
    update_interval: 86400
```

纯本地用法：把 `egern/zimuquan.local.yaml` 与 `egern/zimuquan.js` 下载到同一个目录，模块内 `script_url` 写的是同目录文件名 `zimuquan.js`，无需任何远程托管。

模块自带 MITM 声明，启用后确认 Egern 根证书已信任（`工具 → 证书 → 生成并安装`），否则 HTTPS 无法解密改写。

### Surge 使用

远程版（推荐，加一条模块链接即可，脚本自动从本仓库加载）：

```
https://raw.githubusercontent.com/willchooes/Rewrite/refs/heads/main/surge/zimuquan.sgmodule
```

本地版：下载 `surge/zimuquan.local.sgmodule` 与 `surge/zimuquan.js` 放进 Surge 配置目录，再引用模块。此时模块内 `script-path=zimuquan.js` 走相对路径。

### 工作原理

站点播放页的响应体不是明文 HTML，而是：

```html
<script>window.addEventListener("load", function () {
  document.write(decodeURIComponent(atob("...")));document.close();
}, false);</script>
```

即 `base64 → URL 编码` 双层混淆，只有浏览器里才还原成页面。因此代理侧无法直接正则匹配播放信息，脚本处理顺序为：

1. 解码响应体，还原明文 HTML，并把混淆整体替换为明文。
2. 在明文 HTML 的 `</body>` 前注入一段客户端脚本。
3. 客户端脚本劫持 `.popup`（VIP 遮罩）上的 `.el-login-btn`（原「登录」按钮），改写文案。
4. 点击后请求站点自身的未授权采集接口 `/api.php/provide/vod/?ac=detail&ids=<vod_id>` 取 `vod_play_url`。
5. 若接口取不到，回退到遮罩背景图 URL，把 `vod.jpg` 换成 `index.m3u8`（封面与播放源同目录，已实测一致）。
6. 播放交给 hls.js 或 Safari 原生 HLS；HLS 的 `EXT-X-KEY:METHOD=AES-128,URI="key.key"` 由播放器自动拉取同目录密钥解密。

MITM 只需覆盖 `zimuquan.top`，媒体 CDN 直连不拦截。

### 实现中规避的坑

- **`String.replace` 的特殊模式**：替换串里的 `$$` 会折叠成 `$`，`$'` 会展开为「匹配之后的文本」。注入代码含 `split('$$$')`，若用字符串形式替换会被静默破坏，故两版都改用函数式替换 `() => injected + '</body>'`。
- **双触发**：按钮事件统一由 capture 阶段的事件委托处理，`bind()` 只负责改文案，避免直接绑定与委托同时命中。
- **编码头**：Egern 版把 body 改为未压缩明文后，显式删掉 `content-encoding` / `content-length`，否则客户端按 gzip 解压会失败。
- **DOM 时序**：播放页 DOM 由 `document.write` 构建，客户端脚本带重试（40 × 250ms）等待遮罩出现。

### 已知限制

- `zhuanma14.aeondigit.com` 整条 CDN 线路回源 502（已枯死），命中该线路的视频无法播放，页面会红字提示线路失效。抽样 5 条线路中其余 4 条（`shipin2.52zsj.com`、`shipin3.yiqiwancm.com`、`zhuanma5.moorehjgijo.com`）正常。
- 取源依赖站点采集接口处于未鉴权状态；若站点日后加固，会退回封面推导这条兜底路径。
- 播放页若改动 `.popup` / `.el-login-btn` 的类名，需要同步更新脚本选择器。
