# 自动操作记忆

默认开启。日常使用 `chrome-shell` 时自动学习，不需要用户额外要求生成脚本。

## 使用方式

1. 固定 `-C <workspace>` 和 `--tab`。任务开始时 `tool ls` 查看当前已有操作，优先复用适用的 `auto_*`。
2. 确定步骤用稳定的 role/name、CSS 或已有 page tool 组成批次，末尾加入真实 `assert`。`inspect` 可以放在批次末尾接收下一状态。
3. 相同操作模板达到两次成功、且有不同输入样例时，后台自动生成 `.webmcp/learned/auto_*.tool.json`。静态无输入操作要求重复成功。
4. 用普通 `call auto_... input={...}` 执行。生成文件包含 inputSchema、参数说明、精确 URL 作用域和依赖指纹；必要时按名字读取这一个小文件，不扫描全部源码。

## 学习范围

- 自动编译已成功的 Semantic Shell，保留管道与字段填写顺序；参数化变量、填写值、查询业务键和工具输入。
- 仅以执行成功加最终断言作为证据；不采纳模型自己宣布完成。
- 复杂分支、任意 JS、旧 refs、固定 sleep、凭据以及不能可靠参数化的内容不自动发布，原因计入 `skipped`。
- 首版绑定精确页面 URL（包括普通 query/hash），避免把一个业务记录的操作误用于另一记录。跨 URL 的泛化保守处理。带 token 等凭据的 URL 不入库。
- 不保存输入样本值；保存模板、schema、样本指纹和生命周期计数。断言应校验真正的结果，弱断言不会自动变成业务验收。

## 自更新与淘汰

`candidate → active → quarantined/retired`。结构性失效或依赖文件内容变化时，旧生成文件从活动目录移除；继续正常操作产生新成功证据后会发布新版本。默认 30 天未复用的生成工具归档删除，活动工具最多 32 个，按最近使用淘汰。

归档位于 `.chrome-shell/learning/archive/`，索引是 `.chrome-shell/learning/state.json`。只维护索引中登记、内容指纹仍匹配的生成文件；人工修改冲突会保留文件并显示 `conflict`。

学习走有界后台队列，前台不等待磁盘归档或学习判断。桥接存活期间对已访问 workspace 每分钟维护；重启后首次访问已有学习索引的 workspace 时，自动恢复维护，无需再次成功执行操作才能清理。

## 配置与诊断

全局开关在已安装 `chrome-shell/config.json` 的 `learning`；workspace 可用 `.chrome-shell/config.json` 覆盖：

```json
{ "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 } }
```

```powershell
chrome-shell 'learn status' -C <workspace>
chrome-shell 'learn maintain' -C <workspace>
```

这些命令用于查看/立即维护，普通学习不依赖手工调用。状态中的 `error`、`dropped`、`skipped` 和 `reason` 必须如实处理；不能把后台失败说成已经学会。
