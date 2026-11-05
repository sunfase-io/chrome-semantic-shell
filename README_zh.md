# Chrome Semantic Shell

[English](README.md) | 简体中文

Chrome Semantic Shell 是一个本地优先、CLI-first 的浏览器自动化运行时，直接操作用户正在使用的 Chrome
配置文件，因此可以复用现有登录态、扩展、证书和浏览器设置。

产品没有 popup、侧边栏、内置聊天 Agent、本地模型、向量库或可视化流程编辑器。Agent 和终端用户统一通过
`chrome-shell` 操作浏览器。

## 架构

```text
Agent / terminal
  → chrome-shell
  → loopback POST /chrome/shell
  → Native Messaging
  → headless Chrome extension runtime
```

- HTTP 服务只监听 loopback。
- 每次 CLI 调用对应一条独立请求；成功、失败或超时后立即关闭 HTTP 连接。
- Jev 流程运行器复用本地 HTTP 与 Jev HTTPS 连接，在同一进程中完成多步决策和执行。
- 扩展与 Native host 之间只保留一条常驻 Native Messaging 通道。
- 语义状态统一融合原生 HTML/ARIA、Vue 2、Vue 3、React、frame 和 WebMCP adapter。
- 自动操作记忆在 Native host 后台积累成功证据、发布可复用工具并维护版本。

## 主要能力

- 紧凑的 `inspect`、精确 `query` 与稳定 ref
- 批量点击、填写、下拉选择、键盘、滚动、拖拽、上传、导航和标签页操作
- `wait`、`assert`、`diff`、`watch`、网络、console、截图和下载验证
- 变量、条件、循环、管道及 LIFO `defer` 清理
- 自定义组件下拉按 label/value 精确选择，不使用模糊猜测
- 使用 `scope=pipe` 完成表格行内关系查询
- Workspace `.webmcp` 工具与页面标准 WebMCP 工具
- HTTP 操作捕获、类型化输入绑定和凭证清洗
- 歧义、陈旧 ref、非法输入、越界路径和超时全部 fail-fast
- 自动学习带断言的稳定操作，参数化后发布为 `.webmcp`，按使用反馈更新、归档和淘汰
- 可选 Jev 快速决策：闭集动作选择、持久连接、确定步骤合并和独立结果断言
- 根据真实会话建立功能覆盖表，提供离线回归、真实浏览器夹具和性能对照

## 环境要求

- Windows、macOS 或 Linux
- Node.js 20 或更高版本（`node -v` 查看）
- Google Chrome 或 Chromium（支持 Manifest V3 与 Native Messaging）
- 可选：Python 3.10+，用于 Jev 运行器和 Python 测试

## 安装

安装由三部分组成，缺一不可：**CLI**（npm 安装）、**扩展**（加载到 Chrome）、**Native Messaging 注册**（让 Chrome
能启动 CLI 的 bridge）。Agent Skill 可选。

### 1. 安装 CLI

```powershell
npm install -g chrome-semantic-shell
```

安装后得到两个命令：`chrome-shell`（执行 DSL）和 `chrome-shell-bridge`（注册与诊断）。npm 安装时会自动为当前用户注册
Native Messaging host。

pnpm 10 可能拦截全局包的生命周期脚本，需要手动注册：

```powershell
pnpm add -g chrome-semantic-shell
chrome-shell-bridge register
```

`chrome-shell-bridge register` 可以重复执行，不确定是否注册成功时直接再跑一次即可。

### 2. 加载扩展

1. 从 [最新 Release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) 下载
   `chrome-semantic-shell-extension-<version>.zip`，解压到一个固定目录（Chrome 每次启动都从这里加载，不要删除）。
2. 打开 `chrome://extensions`，打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择解压后的目录（包含 `manifest.json` 的那一层）。
4. 确认扩展 ID 为 `hnhimbinihlfejljamlgfniplabkaamk`，Native host 只接受这个 ID。

扩展刻意不提供工具栏按钮和弹窗，连接与配置全部在终端完成。

### 3. 注册并连接

```powershell
chrome-shell-bridge register
```

然后在 `chrome://extensions` 的扩展卡片上点一次“重新加载”，让扩展连接新注册的 host。验证：

```powershell
chrome-shell-bridge status
chrome-shell 'tab list'
```

`status` 显示 `bridge: connected on 127.0.0.1:12306`、`tab list` 列出当前打开的标签页，即安装成功。

### 4. 可选：安装 Agent Skill

如果要让 Claude Code、Codex、OpenCode 等编码 Agent 使用 CLI，从同一个 Release 下载 `chrome-shell-skill-<version>.zip`，
解压后让 `SKILL.md` 位于：

- `~/.agents/skills/chrome-shell/SKILL.md`（通用 Agent 技能目录），或
- `~/.claude/skills/chrome-shell/SKILL.md`（Claude Code）

仓库中的 [`skills/chrome-shell`](skills/chrome-shell) 是同一份文件。

### 升级与卸载

- **升级**：`npm install -g chrome-semantic-shell@latest`，执行 `chrome-shell-bridge register`，用新 Release 替换扩展目录后重新加载扩展。
- **卸载**：在 `chrome://extensions` 移除扩展，执行 `npm uninstall -g chrome-semantic-shell`，再删除 host 清单
  `com.chromesemanticshell.nativehost.json`：
  - Windows：`%APPDATA%\Google\Chrome\NativeMessagingHosts\`，以及注册表项
    `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromesemanticshell.nativehost`
  - macOS：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux：`~/.config/google-chrome/NativeMessagingHosts/`

### 常见问题

| 现象                                            | 处理                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `status` 显示 bridge 未连接                     | 执行 `chrome-shell-bridge register`，重新加载扩展，并确认 Chrome 正在运行                                                     |
| 扩展 ID 不是 `hnhimbinihlfejljamlgfniplabkaamk` | 加载的不是 Release 原包；请原样加载 Release 目录，或在 host 清单中放行你的 ID                                                 |
| 端口 12306 被占用                               | `chrome-shell-bridge config --port <端口>`，然后重新加载扩展                                                                  |
| Windows PowerShell 中文乱码或 JSON 断裂         | 先执行 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`，或执行一次 `chrome-shell-bridge shims` 安装 UTF-8 启动器 |
| pnpm 安装后找不到 `chrome-shell`                | 执行 `pnpm setup` 把 pnpm 全局 bin 加入 `PATH`，然后新开终端                                                                  |
| macOS/Linux 权限错误                            | `chrome-shell-bridge fix-permissions`                                                                                         |

日志位置：Windows `%LOCALAPPDATA%\chrome-semantic-shell\logs`，macOS `~/Library/Logs/chrome-semantic-shell`，
Linux `~/.local/state/chrome-semantic-shell/logs`。

## 从源码构建

```powershell
git clone https://github.com/sunfase-io/chrome-semantic-shell.git
cd chrome-semantic-shell
pnpm install
pnpm build
$release = Join-Path $PWD "release"
New-Item -ItemType Directory -Force $release | Out-Null
pnpm --dir packages/shared pack --pack-destination $release
pnpm --dir app/native-server pack --pack-destination $release
pnpm add -g "$release\chrome-semantic-shell-shared-1.0.0.tgz" "$release\chrome-semantic-shell-1.0.0.tgz" --ignore-scripts
chrome-shell-bridge register
```

以“加载已解压的扩展程序”方式加载 `dist-extension/chrome-mv3`，重新加载后用 `chrome-shell-bridge status` 验证。
内置的 manifest key 保证源码构建与 Release 版扩展 ID 一致。

## 基本使用

PowerShell 和 POSIX shell 中建议使用单引号包裹 DSL，避免 `$variables` 被 shell 提前展开。

```powershell
chrome-shell 'tab list'
chrome-shell 'inspect interactive limit=30'
chrome-shell 'fillform 邮箱=$email && query role=button name="登录" | click && wait text="仪表盘" timeout=10000 && assert text="仪表盘"' --tab 123 --var 'email=user@example.com'
```

精确选择组件下拉：

```powershell
chrome-shell 'select role=combobox name="所属系统" value="加工事业部贸易" && inspect forms query="所属系统"' --tab 123
```

唯一定位表格行，并把后续查询限制在该行：

```powershell
chrome-shell 'query role=row query="ROLE_003" | query role=button name="设置工作流角色" scope=pipe | click'
```

无论成功、失败或超时都执行清理：

```powershell
chrome-shell 'tab new https://example.com; defer { tab close }; inspect interactive; assert text="Example Domain"'
```

指定后台 tab：

```powershell
chrome-shell 'inspect forms' --tab 123
```

完整语法见
[`skills/chrome-shell/references/semantic-shell.md`](skills/chrome-shell/references/semantic-shell.md)。

依赖步骤使用 `&&`，其中一步失败就停止后续写入；`;` 会在失败后继续，不是 fail-fast 分隔符。
同一 tab 的写操作串行，在下一个未知弹窗或页面状态处重新观察。长 JSON/JS 使用 `--file` 与
`--vars-file`，先 `--dry-run` 校验语法；已成功的写入不会因后续失败而自动回滚。

## 无 UI 配置

```powershell
chrome-shell-bridge status
chrome-shell-bridge config
chrome-shell-bridge config --port 12307
chrome-shell-bridge config --timeout 45000
```

修改端口后重载扩展一次。单次调用可使用 `--timeout`、`--endpoint` 或 `CHROME_SHELL_PORT` 覆盖默认值。

持久配置文件位置：

```text
Windows: %LOCALAPPDATA%\chrome-semantic-shell\config.json
macOS:   ~/Library/Application Support/chrome-semantic-shell/config.json
Linux:   $XDG_CONFIG_HOME/chrome-semantic-shell/config.json
```

不需要手动关联客户端：扩展重载后会根据固定 extension ID 和 Native host 注册自动连接。

## Workspace page tools

使用 `-C` 从项目 `.webmcp` 目录发现片段和已捕获操作：

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project 'tool call lookup_order input={"id":"1001"}'
```

确定只读的片段使用 `// readonly: true`，manifest 使用 `"readOnly": true`。纯只读程序会跳过页面前后变化观察。

## 自动学习、复用与淘汰

自动操作记忆默认开启，普通 `chrome-shell` 使用就能积累证据，无需另发“生成脚本”的指令：

```text
成功且有最终断言的批次
  → 提取稳定操作、参数化输入
  → 重复成功验证
  → .webmcp/learned/auto_*.tool.json
  → 复用反馈、依赖检查、新版本或归档淘汰
```

有输入的模板默认需要两次成功且输入样例不同；静态无输入操作需要重复成功。
生成文件使用 `semantic-sequence`，带输入 schema、精确 URL 作用域和依赖指纹。任务开始可用
`tool ls` 查找已有操作，再按其 schema 调用：

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project --tab 123 'call auto_<实际名称> input={"arg1":"实际值"}'
chrome-shell -C D:\project 'learn status'
```

生命周期为 `candidate → active → quarantined/retired`，人工修改冲突记为 `conflict`：

- 结构性失效或依赖变化时，旧生成文件退出活动目录；新的成功证据能形成新版本。
- 默认最多 **32** 个活动工具，**30 天未复用**归档淘汰；只删除已登记且内容指纹匹配的生成文件。
- 索引与归档位于 `.chrome-shell/learning/`；不保存输入样本值。
- 学习和磁盘维护走后台队列；重启后首次访问已有索引的 workspace 会恢复维护。

全局配置位于已安装技能的 `chrome-shell/config.json`，workspace 可用 `.chrome-shell/config.json` 覆盖：

```json
{ "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 } }
```

首版保守处理跨 URL 泛化，不自动发布任意 JS、旧 ref、凭据或无可靠断言的片段。
`learn maintain` 可立即维护，但正常学习不依赖手工触发。
详见 [自动操作记忆](skills/chrome-shell/references/automatic-learning.md) 与[设计说明](docs/automatic-operation-memory.md)。

## Jev 快速决策：介绍与配置

Jev 是 TypeSafe 提供的类型化决策模型。在本项目中，它根据当前语义观察，从宿主事先定义的合法动作中
选择下一步；程序执行、前置检查和结果断言仍由本地运行器负责。

- **确定操作**直接执行 DSL、API 或已有工具，连续节点合并成一个批次。
- **语义分支**交给 Jev，选择动作后直接执行，不必每一步返回宿主大模型。
- **未知流程、缺失证据或低置信度**返回宿主处理，不猜测动作、不静默更换模型。

### 1. 安装客户端并配置 API

运行器复用已有 [Jev skill](https://github.com/wuyoscar/jev-skill) 的配置加载、请求校验和决策解释。
默认客户端路径为 `~/.agents/skills/jev/scripts/jev.py`。

在仓库之外创建 `~/.agents/jev/config.json`，填入自己的 API Key：

```json
{
  "api_url": "https://api.typesafe.ai/v1/systemone",
  "api_key": "<YOUR_JEV_API_KEY>",
  "model": "jev-latest"
}
```

`api_url` 使用兼容 `POST /v1/systemone` 的地址；实际请求始终以配置文件为准。
API Key 留在本机，不放入计划、README 或提交。

### 2. 配置开关、连接与预算

编辑 [`skills/chrome-shell/config.json`](skills/chrome-shell/config.json)，或已安装技能中的同名文件：

```json
{
  "jev": {
    "enabled": true,
    "keepalive": true,
    "config_file": "~/.agents/jev/config.json",
    "skill_script": "~/.agents/skills/jev/scripts/jev.py",
    "timeout_seconds": 8,
    "min_probability": 0.85,
    "min_margin": 0.2
  },
  "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 },
  "browser_timeout_ms": 10000,
  "max_steps": 8
}
```

`jev.enabled=false` 关闭 Jev 决策，普通 CLI 和自动学习仍可使用。
`keepalive=true` 使用直接持久 HTTPS 连接；需要系统代理时明确设为 `false`，使用原客户端的 urllib 路径。
概率阈值是停止判断的启发式，不是准确率保证。

### 3. 检查并运行

```powershell
python "$HOME/.agents/skills/jev/scripts/jev.py" config-check
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --dry-run
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --vars-file private-values.json
```

计划由宿主基于真实页面定义 `goal`、`acceptance`、`allowed_origins` 和节点，每个动作都有
`guard/program/verify`。运行器要求扩展协议 **3**，默认只把必要节点信息发送给 Jev；控件 value、
程序输入值及 URL 凭据/query/hash 不进入自动构造的模型证据。标题、候选名称和自定义 context 仍应按任务裁剪。

退出码：`0` 验证通过，`2` 需要宿主判断，`1` 配置或执行失败。`--dry-run` 检查语法，不执行浏览器动作或调用 Jev。
完整计划示例与边界见 [Jev 本地闭环](skills/chrome-shell/references/jev-fast-loop.md)。

## 实测结果与会话回归

2026-09-21，同一 localhost 表单夹具、每种路径三轮，交替顺序运行并核对服务端实际保存的数据：

| 执行方式                        | 浏览器请求数 |     中位耗时 |
| ------------------------------- | -----------: | -----------: |
| 逐条 CLI                        |            6 |     1457.9ms |
| CLI 批处理                      |            1 |      722.2ms |
| 持久 HTTP 批处理                |            1 |  **635.0ms** |
| 两次 Jev 决策 + 持久浏览器 HTTP |            3 | **2420.7ms** |

表单路径耗时降低约 **56.4%**，约 **2.30 倍快**。两次 Jev 决策的浏览器部分约 0.43s，其余主要为 API 调用。
这是执行路径对照，不是主模型 A/B，也不是所有网站或 p95/p99 的速度保证。

本次回执包括 **162 项离线/组件测试**和 **37 项真实 Chrome 合成回归**，覆盖定位、表单、iframe、导航、
等待、下载、捕获、Jev、自动学习与失败处理。`tests/browser-automation/coverage.json` 将功能映射到会话证据及测试；
`docs/analysis/session_inventory.py` 支持后续新会话、旧会话追加和已有消息修改的增量分析。

- [测试入口与依赖](tests/browser-automation/README.md)
- [性能原始数据](docs/browser-performance-keepalive-2026-09-21.json)
- [真实浏览器回归结果](docs/browser-regression-final-2026-09-21.json)

## 开发验证

```powershell
pnpm typecheck
pnpm lint
pnpm --filter chrome-semantic-shell-extension test
pnpm --filter chrome-semantic-shell test
pnpm --filter chrome-semantic-shell run test:coverage
python -m unittest discover -s skills/chrome-shell/evals -p "test_*.py" -v
python -m unittest discover -s tests/browser-automation -p "test_*.py" -v
pnpm audit --prod
pnpm build
```

构建产物：

- 扩展：`dist-extension/chrome-mv3`
- Native CLI：`app/native-server/dist`

## 发布

推送与 Native 包版本一致的 tag：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会完成校验和离线回归，打包扩展、Agent Skill、shared runtime 与 Native CLI，创建 GitHub Release，
再通过 [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)（GitHub OIDC，不存 token，自动附带 provenance）
依次发布 `chrome-semantic-shell-shared` 与 `chrome-semantic-shell` 到 npm。npm 上已存在的版本会跳过。

维护者一次性配置 npm：

1. 注册 npmjs.com 账号并开启两步验证。
2. 首个版本手动发布（Trusted Publisher 只能添加到已存在的包）：`npm login`、`pnpm build`，按[从源码构建](#从源码构建)打包两个 tgz，
   先 `npm publish <shared tgz> --access public`，再 `npm publish <cli tgz> --access public`。
3. 在 npmjs.com 两个包的 **Settings → Trusted publishing** 中选择 GitHub Actions，填写
   `sunfase-io` / `chrome-semantic-shell` / `build-release.yml`。

## 安全边界

- 命令 endpoint 只接受 loopback HTTP URL。
- Workspace 发现与发布会拒绝 realpath/symlink 越界。
- 捕获操作不会持久化 Authorization、Cookie、token、secret 或 password。
- Native host 只接受 allowlist 内的扩展 ID。
- CI 会执行生产依赖漏洞审计。

## 文档

- [Semantic Shell 总览](docs/SEMANTIC_SHELL.md)
- [Agent Skill](skills/chrome-shell/SKILL.md)
- [完整 CLI 参考](skills/chrome-shell/references/semantic-shell.md)
- [Jev 介绍、配置与计划契约](skills/chrome-shell/references/jev-fast-loop.md)
- [自动操作记忆](skills/chrome-shell/references/automatic-learning.md)
- [论文、开源项目与会话研究](docs/browser-automation-research-2026-09-21.md)
- [会话驱动测试](tests/browser-automation/README.md)

## 许可证

[MIT](LICENSE)
