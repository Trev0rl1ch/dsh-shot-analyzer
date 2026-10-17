# dsh-shot-analyzer

DSH 截图分析插件：**输入框右边多一个 📷 按钮**。按一下 → 抓取整个桌面（多显示器整块虚拟屏）→ 把这张 PNG 作为**用户消息的图片附件**发进当前会话 → Agent（也就是当前这个会话的模型）直接看着这张图回答。

用一句话概括链路：

```
[📷 按钮] --POST /dsh-shot/capture--> [宿主半侧]
                                          ├─ PowerShell 截全屏 → PNG
                                          ├─ 存一份到 $DSH_HOME/screenshots/
                                          └─ ctx.sessionController.prompt(request, signal)
                                                 content = [image, text]
                                                     ↓
                                       会话里出现一条带图的消息 → Agent 分析
```

## 目录

- [安装 / 卸载](#安装--卸载) ← **先看这个：只解压文件是不会生效的**
- 装了什么
- 按钮在哪 / 怎么用
- 配置
- 图片存到哪 / 会不会越攒越多
- 它怎么工作
- 已知限制

## 装了什么

一个 DSH bundle 插件包，含两个半侧：

| 文件 | 角色 |
|---|---|
| `lib/host.js` | **宿主半侧**：注册 3 条本机 HTTP 路由，调 PowerShell 截图，把图送进会话 |
| `lib/client.js` | **浏览器半侧**：往 `conversation.input.right` 槽位注册一个按钮（纯 JS，无构建步骤） |
| `lib/capture.ps1` | 截图脚本：DPI 感知 + 整块虚拟屏 + 可选等比缩放，输出 PNG |
| `cordis.patch.yml` | bundle 挂载声明（把插件本体插进 profile 配置树） |

## 按钮在哪 / 怎么用

在**输入框工具行**的右侧、发送按钮前面，有一个 📷。

- 悬停：`截图分析：抓取当前屏幕并让本会话的 Agent 分析这张图`
- 点一下：按钮变成 `⏳ 截图…`，成功后变 `✓ 已发送`（几秒后自动恢复静音状态）
- 之后会话里会出现一条**带图片的用户消息**，Agent 会就这张图作答
- 失败时按钮变红显示 `失败`，悬停可看到完整原因

## 配置

在 `$DSH_PROFILE_DIR/cordis.patch.yml` 里给这一行加 `config`（不用改插件代码）：

```yaml
- id: dsh-shot-analyzer
  config:
    # 是否自动把截图发进会话；false = 只截图存盘
    autoSend: true
    # 截图长边上限（像素）。0 = 用内置阶梯 1600→1280→1024→800
    maxLongSide: 1600
    # 随图片一起发出去的那段提示词
    prompt: "分析这张截图。"
    # PowerShell 截图超时（毫秒）
    captureTimeoutMs: 30000
    # $DSH_HOME/screenshots/ 里保留多少张本地副本（最新的在前）。
    # 0 或负数 = 不清理。默认 10。
    keepLocalCopies: 10
```

> `keepLocalCopies` 由 `lib/capture.ps1` 执行，而该脚本每次截图都是**重新读盘执行**的，
> 所以改这个值（或直接改脚本里的默认值）**不需要重启 DSH**。
> 反之，改 `lib/host.js` 里的 JS 逻辑必须重启 —— 见「已知限制」。

## 图片存到哪 / 会不会越攒越多

一次截图产生**两份**，用途不同：

| 位置 | 性质 | 会不会自动清理 |
|---|---|---|
| `$DSH_HOME/screenshots/shot-<时间戳>.png` | 插件自己留的**便利副本**，跟聊天无关 | ✅ 保留最新 `keepLocalCopies` 张（默认 10），其余删掉 |
| `$DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>` | **会话持久附件**，内容寻址、自动去重；聊天里那张图、模型后续还能看到的那张图，都是它 | ❌ 由 DSH 附件服务自己管，插件不碰 |

所以：**手动删掉 `screenshots/` 里的文件不会影响聊天记录**（会话靠的是附件库那一份）；
反过来，附件库那一份删了聊天里的图才真的没了。

清理只匹配本插件自己的 `shot-*.png` 命名，同目录下的其它文件不会被误删；
刚写出来的那一张永远不删；清理本身出错也不会影响本次截图结果。

## 它怎么工作

### 宿主半侧

三条路由（全部只接受回环 Host，并委托宿主的信任栅栏；跨站请求一律 403）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/dsh-shot/capture` | 截图 +（默认）投递进会话。body：`{ "sessionId": "session-…" }` |
| `GET` | `/dsh-shot/last.png` | 最近一次截图的 PNG 字节 |
| `GET` | `/dsh-shot/state.json` | 最近一次截图的元数据 |

`POST /dsh-shot/capture` 返回：

```json
{
  "ok": true,
  "file": "C:\\Users\\…\\.dsh\\screenshots\\shot-20261017-001946-102.png",
  "width": 1600, "height": 900, "bytes": 685089,
  "capturedAt": "2026-10-16T16:19:47.598Z",
  "delivered": true
}
```

也可以脱离界面直接用它（自动化、脚本）：

```powershell
curl.exe -X POST http://127.0.0.1:19387/dsh-shot/capture `
  -H "Content-Type: application/json" `
  -d '{\"sessionId\":\"session-xxxx\"}'
```

不带 `sessionId` 时就只截图存盘，返回 `delivered:false` + `warning`。

**投递**：`ctx.sessionController.prompt(request, signal)`，content 为
`[{type:'image', mediaType:'image/png', data:<base64>}, {type:'text', text:<提示词>}]`。
注意这个宿主方法的签名是 `(request, signal)` —— 它第一件事就是 `signal.throwIfAborted()`，
**不传 signal 会直接抛 TypeError**（这一条是踩过的坑，见「已知限制」）。

会话当前模型必须声明支持图片输入；`deepseek-flash` 的目录声明就是 `["text","image"]`，
所以默认模型可以直接用。若换成纯文本模型，宿主会返回可读的原因而不是静默失败。

**截图**：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/capture.ps1 -Out <png> -MaxLongSide <n>`。
脚本先 `SetProcessDPIAware()`（否则在缩放显示器上会截出被裁掉的一块），再
`SystemInformation.VirtualScreen` + `CopyFromScreen` 取整块虚拟屏，超过长边上限就用
HighQualityBicubic 等比缩小，最后存 PNG。截图失败时会按尺寸阶梯重试（1600/1280/1024/800），
以适配 `attachments` 的图片上限。

### 浏览器半侧

纯 JavaScript 的 DSH client bundle（`window.__ModuleLoader__.load({ id, factory })` 形式，
不需要 `pnpm run build`），只依赖平台共享模块表里的 `react`。它 `inject: ['slots']`，
把按钮注册进 `conversation.input.right`（会话作用域，组件直接拿到 `sessionId` 属性）。
点击时就是一次同源 `fetch('/dsh-shot/capture', …)`。

## 已知限制

- **只有 Windows 有截图实现。** 其它平台 `POST /dsh-shot/capture` 返回明确错误；
  接口本身（路由、投递、按钮）是平台无关的。
- **需要交互式桌面会话。** 服务/无人登录的会话拿不到 virtual screen，脚本会抛错。
- **宿主半侧改动需要重启 DSH。** Cordis 按「包名」缓存已导入的模块，热重载只重跑
  `apply()`、不会重新 `import()` 插件源码；改 `lib/host.js` 后请重启 DSH。
  （浏览器半侧不用重启，页面刷新即可。）本次代码路径已经实测通过：
  `prompt(request, signal)` 返回 `{"accepted":true}`，`delivered:true`。
  **唯一例外是 `lib/capture.ps1`** —— 它是每次截图 fork 出来的独立进程，改完立刻生效。
- **`lib/capture.ps1` 只能写 ASCII。** Windows PowerShell 5.1 在没有 BOM 时用系统 ANSI
  代码页解码 `.ps1`，中文注释会被读成乱码甚至触发语法错误。
- **投递走 `sessionController`。** 若宿主组合里没有这个服务，截图仍会存盘，
  接口会返回 `delivered:false` 与原因。
- **默认会把图发进会话**，也就是会**消耗一次模型轮次**。只想截图时把 `autoSend` 设为 `false`。
- **兼容性**：在 DSH 桌面版 `0.2.1-rc.2` 上实测通过。包内**没有**声明 `engines.dsh`，
  所以版本不匹配时不会被安装器挡住，但也不会提前报错。它依赖宿主签名
  `ctx.sessionController.prompt(request, signal)`；若该签名将来变了，投递会失败并返回
  `delivered:false` + 原因，**截图本身仍然会存盘**，不会静默丢东西。

## 安装 / 卸载

> ⚠️ **只把仓库解压到磁盘是不会生效的。** DSH 不会去扫描目录，必须用下面的命令把它登记成一个 bundle；
> 少这一步，界面上永远不会有按钮，而日志里也不会有任何报错。

### 安装

**1. 放到一个长期保留的位置**（别留在"下载"文件夹里）。
`link:` 装的是**软链接**，之后删掉 / 移动 / 重命名这个目录，插件就会变成断链。

```powershell
git clone https://github.com/Trev0rl1ch/dsh-shot-analyzer C:\Tools\dsh-shot-analyzer
# 下载 ZIP 的，解压到同样固定、不带中文和空格的位置即可
```

**2. 装到「你正在用的那个 profile」**。`<profile>` 换成你的 profile 名 ——
Windows 桌面客户端一般叫 `desktop`，用 `dsh web` 起的通常是 `web`。不确定就先看一眼：

```powershell
dir "$env:USERPROFILE\.dsh\profiles"
```

```powershell
dsh plugin --profile <profile> add link:C:/Tools/dsh-shot-analyzer
```

如果提示 `dsh` 不是可识别的命令（桌面版不一定会把它加进 PATH），用完整路径：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile <profile> add link:C:/Tools/dsh-shot-analyzer
```

**3. 重启 DSH。** 宿主半侧的代码只在启动时加载，不重启看不到效果。

**4. 验证。** 随便打开一个会话，输入框右侧出现 📷 就说明好了；也可以直接问宿主
（端口看你地址栏里的那个）：

```powershell
curl.exe http://127.0.0.1:<端口>/dsh-shot/state.json
```

返回 `{"ok":true,"last":null}` 说明宿主路由已经就位。

### 卸载

```powershell
dsh plugin --profile <profile> remove dsh-shot-analyzer
```

`remove` 会同时清掉 `dependencies` 和 `dsh.profile.bundles` 里的条目（已实测），
再重启 DSH 即可。也可以改用 DSH 界面的「设置 → 插件」。

## 许可

MIT
