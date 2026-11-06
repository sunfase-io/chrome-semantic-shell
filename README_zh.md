# Chrome Semantic Shell

[![npm](https://img.shields.io/npm/v/chrome-semantic-shell)](https://www.npmjs.com/package/chrome-semantic-shell)
[![release](https://img.shields.io/github/v/release/sunfase-io/chrome-semantic-shell)](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest)
[![license](https://img.shields.io/github/license/sunfase-io/chrome-semantic-shell)](LICENSE)

[English](README.md) | 简体中文

**让 AI Agent（或你自己）用一条命令操作你正在用的那个 Chrome。**

登录状态、公司内网单点登录、已装的扩展和证书都原样可用，不用另开浏览器、不用重新登录、不用开远程调试端口。
一条命令里可以连续完成“填表 → 点保存 → 等结果 → 检查是否成功”，失败就明确报错。

```powershell
npm install -g chrome-semantic-shell

# 看看浏览器里开着哪些标签页
chrome-shell 'tab list'

# 在 123 号标签页里：填邮箱、点登录、等首页出现、确认登录成功——一次调用完成
chrome-shell 'fillform 邮箱=$email && query role=button name="登录" | click && wait text="仪表盘" && assert text="仪表盘"' --tab 123 --var 'email=user@example.com'
```

## 目录

- [它解决什么问题](#它解决什么问题)
- [优势](#优势)
- [与同类工具对比](#与同类工具对比)
- [安装](#安装)
- [上手：五个常见场景](#上手五个常见场景)
- [命令速查](#命令速查)
- [进阶：页面工具、自动学习、Jev](#进阶页面工具自动学习jev)
- [实测数据](#实测数据)
- [工作原理与安全边界](#工作原理与安全边界)
- [开发与发布](#开发与发布)

## 它解决什么问题

让大模型操作浏览器，常见的麻烦是：

- **登录态没了**：自动化工具通常另起一个干净的浏览器，公司后台、内网 SSO、需要证书或扫码的网站全都要重新登录。
- **慢、费 token**：每点一下都要回到模型、再看一次完整页面，一个表单来回十几轮。
- **点错了不知道**：页面上有两个“保存”按钮，工具默默点了第一个；下拉框是 Vue/React 组件，填进去的值页面根本不认。
- **假成功**：命令都返回 OK，但数据其实没保存。

Chrome Semantic Shell 的做法是：一个装在你 Chrome 里的扩展 + 一个本地命令行 `chrome-shell`。Agent 写一小段脚本（DSL），
扩展在你的浏览器里执行，返回精简的页面信息和“这次操作改变了什么”。

## 优势

### 1. 直接用你自己的 Chrome

- 用的是你日常的 Chrome 配置：登录态、Cookie、已装扩展、客户端证书、公司 SSO 都在。
- **不需要**用 `--remote-debugging-port` 重启 Chrome，**不需要**另建 profile，也不需要每次连接都点授权。
- 可以操作后台标签页（`--tab <id>`），不打断你在前台的工作；截图也能截后台标签页。

### 2. 一次调用干完一整段活

- 一段脚本里可以写多步：`&&`（上一步成功才继续）、`||`（失败时补救）、`|`（把找到的元素传给下一步）、变量、`if`、`for`。
- `defer { ... }` 保证收尾：不管成功、失败还是超时，都会执行清理（例如关掉临时打开的标签页）。
- 实测同一个表单：分 6 次调用要 1458ms，合成 1 次调用只要 722ms（见[实测数据](#实测数据)）。

### 3. 省 token

- `inspect` 输出紧凑：只列可交互元素、表单、表格或弹窗，并按 `limit=`、`role=`、`name~=` 在页面里先过滤再返回。
- 每次写操作后只返回**变化**（新出现的提示、变成可点的按钮、发出的接口请求），不重复整页内容。
- 纯只读的操作自动跳过“前后对比”，更快。

### 4. 准：找不准就报错，绝不瞎猜

- 匹配到多个元素时直接失败并列出候选，而不是默默点第一个。
- 页面刷新后旧的元素引用（ref）失效会被识别出来，不会点到错的东西。
- `select` 会真正打开下拉组件、等真实选项出现再点击，Element UI、Ant Design 这类组件下拉也能选对。
- `scope=pipe` 把查找限定在某一行或某个弹窗里，例如“订单 ORDER-001 那一行的‘查看’按钮”。

### 5. 懂前端框架

语义层同时读取原生 HTML/ARIA 和 Vue 2、Vue 3、React 组件信息，并识别 Element UI / Ant / Fusion 等组件库的弹窗；
iframe 里的元素也会合并进来，操作时自动进入对应 frame。

### 6. 失败就是失败

- 整个脚本全部成功才返回退出码 0；找不到元素、断言失败、接口返回非 2xx、超时，都返回非 0。
- `assert`、`wait text=`、接口回读用来确认“真的保存了”，而不是只看命令有没有跑完。
- 未知命令、拼错的参数在执行前就报错，不会只执行一半。

### 7. 在页面里直接调接口

- `http GET /api/orders` 在页面上下文里发请求，自动带上页面的 Cookie 和证书，结果可以用 `pick=` 只取需要的字段。
- `storage get ... as=$token` 读取令牌但**不打印**，再传给后续请求。
- `extract` 按选择器批量提取结构化数据（标题、链接、价格……）。

### 8. 越用越快：自动把重复操作变成工具

- 带断言、重复成功的操作会被自动参数化，生成 `.webmcp/learned/auto_*.tool.json`，下次一条 `call` 就能完成。
- `capture` 可以把一次界面操作背后的 HTTP 请求录下来，变成带类型参数的可调用工具（不会保存 Cookie、令牌、密码）。
- 页面改版导致工具失效时会自动下线；30 天没用的会归档。

### 9. 项目级页面工具 + WebMCP

- 在项目的 `.webmcp` 目录放 JS 片段或 JSON 清单，就成了 `tool call` 可调用的页面工具，跟着项目走、可以提交到仓库。
- 页面自己通过标准 WebMCP 注册的工具也能直接列出和调用。

### 10. 本地、无账号、为 Agent 准备好

- 不需要任何云服务、账号或模型 API Key；本地服务只监听 `127.0.0.1`，扩展 ID 白名单校验。
- 附带现成的 [Agent Skill](skills/chrome-shell/SKILL.md)，Claude Code、Codex、OpenCode 等编码 Agent 装上就会用。
- 可选接入 Jev 快速决策模型，把“在几个已知动作里选一个”的小决策从大模型手里接过来（见[进阶](#进阶页面工具自动学习jev)）。

## 与同类工具对比

下表依据各项目 2026 年 11 月的官方 README / 文档整理，只写文档里能查到的事实；没有做跨工具的速度评测。

|                             | Chrome Semantic Shell                                  | Playwright MCP / playwright-cli          | Chrome DevTools MCP                                  | agent-browser（Vercel） | browser-use                                                         | Stagehand                                    | Claude in Chrome / Gemini in Chrome      |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| 形态                        | CLI + Chrome 扩展                                      | MCP 服务 / CLI                           | MCP 服务 + CLI                                       | CLI（Rust）+ MCP        | Python 库 / CLI / MCP                                               | SDK（TS/Python/Go）                          | 浏览器内置侧栏 / 扩展                    |
| 用你正在用、已登录的 Chrome | ✅ 装扩展即可，不用远程调试、不用重启                  | 需装 Playwright 扩展，或开远程调试接入   | 需开远程调试（Chrome 144+ 可自动连接，连接时要确认） | 需开远程调试 / CDP      | CLI 通过 CDP 接入（需允许远程调试）；Python 方式可能要先退出 Chrome | 需自己提供 CDP 地址                          | ✅                                       |
| 一次调用多步 + 断言         | ✅ DSL：`&&`、管道、变量、`defer` 清理                 | 一次一个动作；可运行 Playwright 代码片段 | 一次一个工具调用                                     | 有 `batch`              | Agent 模式每步问模型                                                | `act` 每次走模型；也可写 Playwright 风格代码 | 由模型逐步操作                           |
| 给模型看的页面              | 语义视图（HTML/ARIA + Vue/React 组件），操作后只回变化 | 无障碍快照                               | 无障碍快照                                           | 无障碍快照              | 可交互元素列表 + 截图                                               | 裁剪后的无障碍树                             | 截图 + 页面文字（Claude）；Gemini 未公开 |
| 需要模型 Key / 云           | 不需要（Jev 可选）                                     | 不需要                                   | 不需要（默认上报使用统计，可关）                     | 本地不需要              | Agent 需要模型 Key                                                  | `act`/`extract`/`observe` 需要模型           | 需要付费订阅，模型在云端                 |
| 操作复用                    | ✅ 自动学习重复操作 + 录制 HTTP 请求成工具             | 录制成 Playwright 代码                   | 未找到                                               | 录制、会话恢复          | 云端有录制                                                          | 操作缓存仅限 Browserbase 云                  | 可录制快捷操作（Claude 经典侧栏）        |
| WebMCP                      | ✅ 页面标准 + 项目 `.webmcp` 目录                      | ✅                                       | 实验性                                               | 实验性                  | 未找到                                                              | ✅                                           | 未找到（Gemini 已宣布计划支持）          |
| 浏览器                      | Chrome / Chromium                                      | Chromium / Firefox / WebKit              | Chrome                                               | Chrome / Chromium       | Chromium                                                            | Chromium                                     | Chrome（Claude 企业版也支持 Edge）       |
| 许可                        | MIT                                                    | Apache-2.0                               | Apache-2.0                                           | Apache-2.0              | MIT                                                                 | MIT                                          | 商业产品                                 |

**什么时候该选别的：**

- 做跨浏览器的自动化测试、在 CI 里无头运行 → **Playwright**。
- 排查性能、内存、网络等调试问题 → **Chrome DevTools MCP**。
- 想要“一句话交给 AI 自己完成”、不写任何脚本 → **browser-use**、**Stagehand** 或 **Claude in Chrome / Gemini in Chrome**。
- 需要云端大规模并发浏览器 → Browserbase / browser-use Cloud 等云服务。

**本项目最适合：** 让编码 Agent 在你已登录的真实 Chrome 里操作内部系统、后台管理页、需要证书或 SSO 的网站，
要求快、省 token、出错立刻知道，并希望重复的操作越用越快。

参考：[Playwright MCP](https://playwright.dev/mcp/introduction) ·
[playwright-cli](https://github.com/microsoft/playwright-cli) ·
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) ·
[agent-browser](https://github.com/vercel-labs/agent-browser) ·
[browser-use](https://github.com/browser-use/browser-use) ·
[Stagehand](https://github.com/browserbase/stagehand) ·
[Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) ·
[Gemini in Chrome](https://support.google.com/gemini/answer/16821166)

## 安装

需要：Windows / macOS / Linux，Node.js 20+，Google Chrome 或 Chromium。Python 3.10+ 只在使用 Jev 或跑 Python 测试时需要。

安装分三步，缺一不可：**命令行工具**、**Chrome 扩展**、**注册本地连接**（让 Chrome 能启动命令行工具的桥接进程）。

### 1. 安装命令行工具

```powershell
npm install -g chrome-semantic-shell
chrome-shell --version
```

国内网络慢可以用镜像（新版本通常几分钟后同步）：

```powershell
npm install -g chrome-semantic-shell --registry=https://registry.npmmirror.com
```

装好后有两个命令：`chrome-shell`（执行操作）和 `chrome-shell-bridge`（注册与诊断）。npm 安装时会自动注册。

用 pnpm 10 安装时，全局安装脚本可能被拦截，需要手动注册一次：

```powershell
pnpm add -g chrome-semantic-shell
chrome-shell-bridge register
```

没法访问 npm 时，从 [Release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) 下载两个 `.tgz`，
用一条命令一起装：`npm install -g .\chrome-semantic-shell-shared-<版本>.tgz .\chrome-semantic-shell-<版本>.tgz`。

### 2. 加载 Chrome 扩展

1. 从 [最新 Release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) 下载 `chrome-semantic-shell-extension-<版本>.zip`，
   解压到一个**固定目录**（Chrome 每次启动都从这里加载，别删）。
2. 打开 `chrome://extensions`，打开右上角“开发者模式”。
3. 点“加载已解压的扩展程序”，选择解压后包含 `manifest.json` 的那一层目录。
4. 确认扩展 ID 是 `hnhimbinihlfejljamlgfniplabkaamk`（本地连接只认这个 ID）。

扩展没有工具栏按钮和弹窗，这是有意的，所有操作都在终端完成。

### 3. 注册并验证

```powershell
chrome-shell-bridge register
```

在 `chrome://extensions` 里点一下扩展卡片上的“重新加载”，然后：

```powershell
chrome-shell-bridge status   # 应显示 bridge: connected on 127.0.0.1:12306
chrome-shell 'tab list'      # 应列出你打开的标签页
```

### 4. 可选：给 Agent 装技能

从同一个 Release 下载 `chrome-shell-skill-<版本>.zip`，解压后让 `SKILL.md` 位于
`~/.agents/skills/chrome-shell/SKILL.md`（通用）或 `~/.claude/skills/chrome-shell/SKILL.md`（Claude Code）。
内容与仓库里的 [`skills/chrome-shell`](skills/chrome-shell) 相同。

### 升级、卸载与常见问题

- **升级**：`npm install -g chrome-semantic-shell@latest` → `chrome-shell-bridge register` → 用新 Release 替换扩展目录 → 重新加载扩展。
  命令行工具和扩展请保持同一个主版本。
- **卸载**：在 `chrome://extensions` 移除扩展，`npm uninstall -g chrome-semantic-shell`，再删除 `com.chromesemanticshell.nativehost.json`：
  - Windows：`%APPDATA%\Google\Chrome\NativeMessagingHosts\` 和注册表项 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromesemanticshell.nativehost`
  - macOS：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux：`~/.config/google-chrome/NativeMessagingHosts/`

| 现象                                   | 处理                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `status` 显示未连接                    | 执行 `chrome-shell-bridge register`，重新加载扩展，确认 Chrome 在运行                                                         |
| 扩展 ID 不对                           | 加载的不是 Release 原包；原样加载 Release 目录                                                                                |
| 端口 12306 被占用                      | `chrome-shell-bridge config --port <端口>`，然后重新加载扩展                                                                  |
| Windows PowerShell 中文乱码、JSON 断裂 | 执行一次 `chrome-shell-bridge shims` 安装 UTF-8 启动器，或先执行 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)` |
| pnpm 装完找不到命令                    | `pnpm setup` 把全局 bin 加入 `PATH`，新开终端                                                                                 |
| macOS / Linux 权限错误                 | `chrome-shell-bridge fix-permissions`                                                                                         |

日志：Windows `%LOCALAPPDATA%\chrome-semantic-shell\logs`，macOS `~/Library/Logs/chrome-semantic-shell`，
Linux `~/.local/state/chrome-semantic-shell/logs`。

## 上手：五个常见场景

在 PowerShell 和 bash 里请用**单引号**包住脚本，避免 `$变量` 被 shell 提前替换。

**1. 看页面上有什么可以操作**

```powershell
chrome-shell 'tab list match=github'
chrome-shell 'inspect interactive limit=30' --tab 123
chrome-shell 'inspect forms' --tab 123
```

输出里每个元素都有 `ref_12` 这样的编号，后续可以直接用 `@ref_12` 操作。

**2. 填表并确认保存成功**

```powershell
chrome-shell 'fillform 名称=$name 邮箱=$email && select role=combobox name="类型" value="企业" && query role=button name="保存" | click && wait text="保存成功" && assert text="保存成功"' --tab 123 --var 'name=测试' --var 'email=a@example.com'
```

**3. 在表格的某一行里点按钮**

```powershell
chrome-shell 'query role=row query="ORDER-001" | query role=button name="查看" scope=pipe | click' --tab 123
```

**4. 打开临时页面取数据，结束后自动关闭**

```powershell
chrome-shell 'tab new https://example.com active=false; defer { tab close }; extract css="h1" ; inspect text'
```

**5. 用页面的登录态直接调接口**

```powershell
chrome-shell 'http GET /api/orders?status=open pick=data.records' --tab 123
chrome-shell 'storage get session key=accessToken as=$token && http POST /api/flow/save headers={"accessToken":"$token"} body={"id":1}' --tab 123
```

长脚本、带 JSON 或 JS 的内容放到文件里执行：`chrome-shell --file job.chrome --fail-fast`；先用 `--dry-run` 只检查语法。

## 命令速查

`chrome-shell help` 离线列出全部命令，`chrome-shell help <命令>` 查看某个命令的完整参数。
完整语法、选项和输出格式见 [CLI 参考](skills/chrome-shell/references/semantic-shell.md)。

**组合方式**：`;` 或换行——无论成败都继续；`&&`——上一步成功才继续；`||`——上一步失败才执行；`|`——把找到的元素传给下一步。

**定位元素**：`@ref_12`、`role=button name="保存"`（精确）、`name~="保存"`（包含）、`text="保存"`、`css="#save"`、`xpath="..."`。

### 观察页面

| 命令      | 作用                                                                                                     | 示例                                        |
| --------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `inspect` | 查看页面：`interactive` 可交互元素、`forms` 表单、`tables` 表格、`dialog` 弹窗、`text` 文字、`full` 全部 | `inspect forms query="供应商" limit=50`     |
| `query`   | 精确查找元素，找不到就失败                                                                               | `query role=button name="保存"`             |
| `diff`    | 显示本次脚本中上一次 `inspect` 之后的变化                                                                | `inspect interactive ; click @ref_3 ; diff` |
| `watch`   | 等待页面发生变化，返回新出现的可操作元素                                                                 | `watch timeout=5000`                        |

### 操作元素

| 命令       | 作用                                   | 示例                                            |
| ---------- | -------------------------------------- | ----------------------------------------------- |
| `click`    | 点击                                   | `query "确定" \| click`                         |
| `dblclick` | 双击                                   | `dblclick text="编辑"`                          |
| `fill`     | 替换输入框内容，`submit=true` 回车提交 | `fill @ref_2 $value`                            |
| `type`     | 模拟真实键盘逐字输入（富文本、搜索框） | `type @ref_2 "hello" submit=true`               |
| `fillform` | 按字段名一次填多个输入框               | `fillform 邮箱=$email 密码=$pwd`                |
| `select`   | 打开下拉组件并点真实选项               | `select role=combobox name="状态" value="启用"` |
| `check`    | 勾选 / 取消勾选                        | `check role=checkbox name="启用" value=true`    |
| `key`      | 按键或组合键                           | `key "Ctrl+S"`                                  |
| `hover`    | 鼠标悬停                               | `hover role=button name="更多"`                 |
| `drag`     | 拖拽                                   | `drag @ref_5 @ref_8`                            |
| `scroll`   | 滚动页面、滚到元素或滚动某个容器       | `scroll down 600`、`scroll @ref_40`             |
| `upload`   | 上传文件                               | `upload css="#file" file=$path`                 |

### 导航、标签页、等待与断言

| 命令       | 作用                                           | 示例                                       |
| ---------- | ---------------------------------------------- | ------------------------------------------ |
| `navigate` | 打开网址，遇到网络错误页会失败                 | `navigate https://example.com`             |
| `back`     | 后退                                           | `back`                                     |
| `forward`  | 前进                                           | `forward`                                  |
| `reload`   | 刷新                                           | `reload`                                   |
| `tab`      | 列出 / 新建 / 切换 / 关闭标签页                | `tab new https://example.com active=false` |
| `window`   | 列出窗口及其标签页                             | `window`                                   |
| `wait`     | 等待文字、元素、网址变化、导航或网络空闲       | `wait text="完成" timeout=10000`           |
| `assert`   | 断言文字存在 / 元素存在 / 元素可见             | `assert text="保存成功"`                   |
| `dialog`   | 处理浏览器原生弹窗（alert / confirm / prompt） | `dialog accept`                            |

### 数据与接口

| 命令      | 作用                                                | 示例                                                      |
| --------- | --------------------------------------------------- | --------------------------------------------------------- |
| `http`    | 用页面登录态发请求，`pick=` 只取需要的字段          | `http GET /api/items pick=data.records as=$rows`          |
| `extract` | 按选择器提取结构化数据                              | `extract css=".row" fields={"title":"a","href":"a@href"}` |
| `storage` | 读 localStorage / sessionStorage / Cookie，值不打印 | `storage get session key=token as=$token`                 |
| `js`      | 执行一段 JavaScript（最后手段）                     | `js "location.href"`                                      |

### 诊断与产物

| 命令         | 作用                                           | 示例                                           |
| ------------ | ---------------------------------------------- | ---------------------------------------------- |
| `screenshot` | 截图（整页、元素或后台标签页），不走浏览器下载 | `screenshot full=true`                         |
| `console`    | 读取页面控制台消息                             | `console buffer --errors`                      |
| `network`    | 抓取接口请求和响应                             | `network start url=/api/ ; ... ; network stop` |
| `download`   | 等待并确认下载完成                             | `click @ref_9 && download timeout=30000`       |

### 流程控制

| 命令    | 作用                           | 示例                                          |
| ------- | ------------------------------ | --------------------------------------------- |
| `set`   | 设置变量                       | `set $ids=["1","2"]`                          |
| `if`    | 按上一步结果或变量分支         | `if failure { screenshot }`                   |
| `for`   | 循环（最多 100 次）            | `for $id in $ids { query text=$id \| click }` |
| `defer` | 收尾：成功、失败、超时都会执行 | `defer { tab close }`                         |

### 工具与学习

| 命令      | 作用                                                | 示例                                                                |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `tool`    | 列出 / 调用页面工具（项目 `.webmcp` 与页面 WebMCP） | `tool ls`                                                           |
| `call`    | `tool call` 的简写                                  | `call lookup_order input={"id":"1001"}`                             |
| `capture` | 把一次操作背后的 HTTP 请求录成可调用工具            | `capture begin ; ... ; capture end name=x ; capture publish name=x` |
| `learn`   | 查看 / 立即维护自动学习的工具（单独执行）           | `learn status`                                                      |

### 命令行选项

| 选项                                      | 作用                               |
| ----------------------------------------- | ---------------------------------- |
| `--tab <id>` / `--window <id>`            | 指定目标标签页 / 窗口              |
| `--var k=v`、`--vars-file`、`--vars-json` | 传入变量（`--var` 优先）           |
| `--file <path>` / `--stdin`               | 从文件 / 标准输入读取脚本          |
| `--fail-fast`                             | 任一步失败立即停止（`;` 分隔也停） |
| `--dry-run`                               | 只检查语法和参数，不操作页面       |
| `--timeout <ms>`                          | 整个脚本的超时（最大 280000）      |
| `--output compact\|json\|debug`           | 输出格式；`--out <file>` 写入文件  |
| `--quiet`                                 | 不输出变化报告                     |
| `-C, --workspace <path>`                  | 指定 `.webmcp` 工具所在的项目目录  |
| `--timing`                                | 打印往返耗时                       |

`chrome-shell-bridge` 子命令：`register`（注册）、`status`（连接状态）、`config`（端口与默认超时）、
`shims`（安装 UTF-8 启动器）、`fix-permissions`（修复权限）。

## 进阶：页面工具、自动学习、Jev

**项目页面工具**：在项目的 `.webmcp` 目录放 JS 片段（开头写 `// tool: 名称`）或 JSON 清单，即可 `tool call` 调用；
只读工具加 `// readonly: true`。用 `-C <项目目录>` 指定位置。

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project 'tool call lookup_order input={"id":"1001"}'
```

**自动学习**（默认开启）：带最终断言、重复成功的操作会生成 `.webmcp/learned/auto_*.tool.json`，带输入参数、
网址范围和依赖指纹；默认最多 32 个活动工具，30 天未用归档，只删除自己生成且未被人工修改的文件。
配置在技能的 `config.json` 或项目的 `.chrome-shell/config.json`：

```json
{ "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 } }
```

详见 [自动操作记忆](skills/chrome-shell/references/automatic-learning.md) 与 [设计说明](docs/automatic-operation-memory.md)。

**Jev 快速决策**（可选）：Jev 是 TypeSafe 的类型化决策模型。对于“在几个已知动作里选下一步”这类小决策，
本地运行器把当前页面的精简信息交给 Jev 选择，然后直接执行并断言，不必每一步都回到大模型；
没把握时交回大模型，不猜。需要自备 API Key，配置见 [Jev 本地闭环](skills/chrome-shell/references/jev-fast-loop.md)。

```powershell
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --dry-run
```

## 实测数据

2026-09-21，本机同一个 localhost 表单页面，每种方式跑三轮、交替顺序，并回读服务端确认数据真的保存了：

| 执行方式                  | 浏览器请求次数 |    中位耗时 |
| ------------------------- | -------------: | ----------: |
| 分 6 次 CLI 调用          |              6 |    1457.9ms |
| 合成 1 次 CLI 调用        |              1 |     722.2ms |
| 1 次持久 HTTP 连接批处理  |              1 | **635.0ms** |
| 两次 Jev 决策 + 持久 HTTP |              3 |    2420.7ms |

合并成一次调用后耗时减少约 **56%**。这是本项目不同执行方式之间的对比，不是与其他工具的对比，也不代表所有网站。

测试覆盖：离线/组件测试和 37 项真实 Chrome 回归，涵盖定位、表单、iframe、导航、等待、下载、录制、Jev、自动学习和失败处理。
见 [测试说明](tests/browser-automation/README.md)、[性能原始数据](docs/browser-performance-keepalive-2026-09-21.json)、
[回归结果](docs/browser-regression-final-2026-09-21.json)。

## 工作原理与安全边界

```text
Agent / 终端
  → chrome-shell（命令行）
  → 本机 127.0.0.1 HTTP
  → Native Messaging（Chrome 官方的本地程序通信机制）
  → 你 Chrome 里的扩展，在页面中执行
```

- 本地服务只监听 `127.0.0.1`，命令行只接受回环地址。
- Native host 只接受白名单内的扩展 ID。
- 录制的操作不保存 Authorization、Cookie、token、secret、password。
- 项目工具目录按真实路径校验，拒绝符号链接越界。
- CI 每次运行生产依赖漏洞审计。

更多：[Semantic Shell 总览](docs/SEMANTIC_SHELL.md) ·
[论文与开源项目研究](docs/browser-automation-research-2026-09-21.md)

## 开发与发布

从源码构建：

```powershell
git clone https://github.com/sunfase-io/chrome-semantic-shell.git
cd chrome-semantic-shell
pnpm install
pnpm build
$release = Join-Path $PWD "release"
New-Item -ItemType Directory -Force $release | Out-Null
pnpm --dir packages/shared pack --pack-destination $release
pnpm --dir app/native-server pack --pack-destination $release
$v = node -p "require('./app/native-server/package.json').version"
pnpm add -g "$release\chrome-semantic-shell-shared-$v.tgz" "$release\chrome-semantic-shell-$v.tgz" --ignore-scripts
chrome-shell-bridge register
```

然后以“加载已解压的扩展程序”加载 `dist-extension/chrome-mv3`。内置的 manifest key 保证扩展 ID 与 Release 版一致。

验证：

```powershell
pnpm typecheck
pnpm lint
pnpm --filter chrome-semantic-shell-extension test
pnpm --filter chrome-semantic-shell test
python -m unittest discover -s skills/chrome-shell/evals -p "test_*.py" -v
python -m unittest discover -s tests/browser-automation -p "test_*.py" -v
```

新增或修改命令时，同步更新 `chrome-shell help`、本 README 两个语言版本的“命令速查”和
[CLI 参考](skills/chrome-shell/references/semantic-shell.md)；测试会检查三处是否覆盖全部命令，漏了 CI 会失败。

**发布是自动的**：把 `app/native-server`、`packages/shared`、`app/chrome-extension` 三个 `package.json` 的 `version`
改成同一个新版本号，推送到 `master`。CI 校验通过后会自动：

1. 打上 `v<版本>` 标签并创建 GitHub Release，附带扩展 zip、技能 zip 和两个 npm 包；
2. 通过 npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 发布到 npm（不存 token，自动附带来源证明）。

版本号没变的推送只跑校验，不发版；npm 上已存在的版本会跳过。

## 许可证

[MIT](LICENSE)。本项目基于 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) 演进而来。
