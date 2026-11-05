# Jev：用快速选择替代大模型逐步往返

## 配置与入口

- 开关：本技能 `config.json` 的 `jev.enabled`。`true` 允许显式启动决策循环，不会拦截普通 `chrome-shell` 命令。
- API 唯一来源：`~/.agents/jev/config.json`。Windows 为 `%USERPROFILE%\.agents\jev\config.json`。
- 复用 `~/.agents/skills/jev/scripts/jev.py` 的配置加载、请求校验、API 调用及概率解释；不安装另一份客户端。
- 模型跟随共享配置的 `jev-latest`；计划文件没有 model 覆盖项。
- 官方兼容协议为 `POST /v1/systemone`，官方直连地址 `https://api.typesafe.ai/v1/systemone`。实际地址始终以共享配置为准；不根据旧聊天中的 key 重写它。
- `config-check` 只回显地址、模型、key 是否存在。不要读取或回显 secret-bearing 配置正文。

```powershell
python "$HOME/.agents/skills/jev/scripts/jev.py" config-check
python "<skill-dir>/scripts/jev_flow.py" plan.json --tab 123 --workspace . --dry-run
python "<skill-dir>/scripts/jev_flow.py" plan.json --tab 123 --workspace .
```

退出码：`0` 所有宏通过断言；`2` 停止并交回宿主判断；`1` 配置、协议或执行错误。失败不自动重试，也不把失败伪装成模拟结果。每个已通过节点即时输出 JSONL receipt，最后给出 decision/browser/total 毫秒数。

## 适用范围

最快的确定操作仍是代码。需要已知规则精确匹配、算数、比日期或选择唯一业务编码时，直接执行 DSL/API。Jev 用在当前状态存在**语义分支**、而可执行操作已经明确的短流程：菜单意图映射、页面分支、重复表单的下一组字段、已知错误恢复路径。

宿主规划 → 最小观察 → Jev 选宏 → guard/执行/verify/下一节点观察合并执行，全部在一个本地进程内运行。浏览器使用持久本地 HTTP 连接；Jev 默认保持 HTTPS 连接。这样省去宿主逐步推理、反复启动 CLI、重复 TLS 握手和额外快照请求。

运行器要求扩展协议版本 **3**。`--endpoint` 可显式选择 loopback `/chrome/shell`；省略时只启动一次 `chrome-shell-bridge status --json` 发现当前端口。`--vars-file` 的输入值仅交给本地浏览器。

`jev.keepalive=true` 使用直接持久连接，复用现有 Jev 客户端的配置、请求校验与决策解释。系统代理生效时须明确设为 `false` 使用现有 urllib 路径；不会在失败后悄悄换传输或模型。

## 计划契约

计划由宿主根据实际页面编写并审阅，不从页面内容或 Jev 输出生成代码。先在目标 tab 观察元素，再提供精确 role/name 候选。一个计划最多 32 节点，默认最多执行 8 步，单浏览器调用默认 10 秒，单 Jev 请求默认 8 秒。

```json
{
  "goal": "查看退款办理规则，不提交申请",
  "acceptance": "规则正文可见，未创建退款申请",
  "allowed_origins": ["https://example.com"],
  "start": "policy",
  "nodes": {
    "policy": {
      "observe": "inspect interactive limit=30",
      "instructions": "选择用于阅读规则的入口；不要申请退款。",
      "choices": {
        "read_policy": {
          "description": "阅读售后与退款规则，不发起交易",
          "requires": [{ "role": "link", "name": "售后须知" }],
          "guard": "assert visible=\"#policy-link\"",
          "program": "query role=link name=\"售后须知\" | click && wait text=\"退款办理规则\" timeout=5000",
          "verify": "assert text=\"退款办理规则\"",
          "next": "done"
        }
      }
    }
  }
}
```

这是格式示例；域名、目标、guard、断言都要替换为真实观察。即使只剩一个候选，仍可能“不适用”，因此保留 `unknown` 分支。真正无需判断的节点直接写 `guard/program/verify/next`，不写 `choices`，会跳过 Jev。

- `observe`：单条 scoped `inspect interactive/forms/dialog/tables`；不接收 JS 或任意 shell。
- `requires`：每个 role/name 在观察中必须唯一且 enabled，歧义或缺失则剔除候选。frame 身份仍来自真实观察；同名多框架目标交回宿主处理。
- `context`：可选、已裁剪且脱敏的事实（当前子目标、业务前置条件、前次错误等）。宿主负责充分证据。每次 Jev 请求不自动继承聊天记录。
- 默认只发送节点 `ref/role/name/states/frameId` 和页面 title/version、去掉凭据/query/hash 的 URL；**不发送控件 value、locatorHints、完整 DOM、token、实际程序/输入值**。title/name/context 仍需选择合适的范围。
- `guard` 和 `verify` 必须以 `assert` 开始；`program` 支持单行管道和 `&&`，不支持 `;`、换行、`||`。程序失败会终止，已成功写入不会自动撤销。
- `next=done` 只由通过断言的动作抵达，不让模型自己宣布 DONE。读回持久化结果/业务状态仍按任务验收要求安排。
- 执行请求携带 `expectedUrl`，扩展在动作之前核对；实际动作重新验证定位唯一性、节点存活和输入状态。业务 `guard` 与写入在同一请求内执行。省去整页 snapshot 再读取，不把无关页面动画当作任务失效。
- 不缓存动作决策，不用旧 refs 预计算依赖点击；同节点/同状态再出现会停止。只有同一快照上的独立问题才适合打包。

## 与现有 Jev 技能配合

若只需对已收集证据做一次判断，直接用 `jev`/`jev-ui` 的原生请求文件和 `jev.py decide`，无须构建 flow。多个互不依赖的问题共享一个 state、一个请求；依赖动作结果的问题等新观察后再问。

阈值 `min_probability=0.85`、`min_margin=0.2` 是可调启发式，不是准确率保证。`unknown` 或低分停止并给宿主补证据/重新规划；不要降低阈值来强迫动作。API 错误保留错误类型，禁用开关时不悄悄改模型。

## 测量与论文依据

分别记录 API 延迟、CLI wall time、动作/验证时间、整任务时间、成功率、错误动作率和交回率。轮流运行确定单步、确定批处理、Jev 闭环，以相同页面初始状态和断言比较。不能把 provider 的 200ms 或单个 demo 当成全任务提速。

研究见仓库 `docs/browser-automation-research-2026-09-21.md`，真实基准入口为仓库内 `skills/chrome-shell/evals/live_benchmark.py`。确定性步骤连续合并；两个语义决策只需一次初始观察和两次执行/观察请求，共三次浏览器请求。
