# Chrome Semantic Shell

Chrome Semantic Shell 通过本地 `chrome-shell` 命令操作用户已经登录的 Chrome。系统只包含三层：

```text
Agent / terminal
  → chrome-shell
  → loopback POST /chrome/shell
  → Native Messaging
  → headless Chrome extension runtime
```

扩展没有 popup、side panel、welcome、options、内置 Agent、本地模型、向量库、元素标注或录制工作流。

## 基本用法

```powershell
chrome-shell 'tab list'
chrome-shell 'inspect forms query="邮箱"; fillform 邮箱=$email; query "登录" | click; wait network; assert text="仪表盘"' --var 'email=user@example.com'
```

Semantic Shell 提供 scoped `inspect/query`、稳定 ref、动作、等待/断言、网络与 console、actionable delta、
`defer` 清理、变量/条件/循环、截图/下载、窄 JS/HTTP 逃生口，以及 workspace page tools。

### 关系作用域

`scope=pipe` 要求管道前一命令恰好返回一个节点，并把后续查询限制在该节点及其 frame 内：

```text
query role=row query="ROLE_HDTC_YXBFJLJL"
| query role=button name="设置工作流角色" scope=pipe
| click
```

0 个或多个管道节点都会 fail-fast。

### 组件下拉

Vue 2 / Element UI、Vue 3 / Element Plus 等框架只作为内部 adapter。Agent 始终使用统一命令：

```text
inspect forms query="所属系统"
select role=combobox name="所属系统" value="加工事业部贸易"
```

选择操作等待真实 option 出现，按 label、value 或 `value:label` 精确匹配，歧义时失败并返回候选。

## Workspace page tools

项目 `.webmcp` 目录与浏览器标准 WebMCP 保持兼容。旧式单文件工具头部支持：

```javascript
// tool: lookup_order
// description: Read one order
// input: { id: string }
// readonly: true
```

manifest 工具使用 `"readOnly": true`。纯只读程序不会启动前后页面观察；未声明的工具一律按可能写入处理。

## 构建

```powershell
pnpm install
pnpm build
```

- Native 包提供 `chrome-shell-bridge` 和 `chrome-shell`。
- 扩展产物位于 `dist-extension/chrome-mv3`，以“加载已解压的扩展程序”方式安装。
- `chrome-shell-bridge register` 注册 Native Messaging host。

### 无 UI 配置

```powershell
chrome-shell-bridge status
chrome-shell-bridge config
chrome-shell-bridge config --port 12307
chrome-shell-bridge config --timeout 45000
```

端口与默认 deadline 保存在用户配置目录。端口变更后重载一次扩展；每条命令仍可用 `--timeout` 或
`--endpoint` 临时覆盖。CLI 没有持久客户端 session：请求完成或超时后 HTTP 连接立即关闭，常驻的只有扩展与
Native host 通道。

## 设计约束

- local first：服务只监听 loopback，浏览器数据默认不离开本机。
- semantic first：结构与状态优先，截图只用于视觉/Canvas fallback。
- fail-fast：歧义、stale ref、超时、缺失输入和越界均返回非零。
- progressive disclosure：默认输出紧凑视图，必要时才升级到 full、截图或 JS。
- API/UI 双通道：稳定重复操作沉淀为 page tool，UI 用于真实行为验证。
