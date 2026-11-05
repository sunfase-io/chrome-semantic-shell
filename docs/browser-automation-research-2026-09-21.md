# 浏览器自动化研究：速度、准确性与可复用执行

研究日期：2026-09-21。目标：为 `chrome-shell` 及下游业务 E2E 页面工具提供可验证的优化依据。

## 结论摘要

最值得投入的顺序是：

1. **把重复任务变成经过验证的业务操作**：保留输入契约、前置条件、实际动作和独立验收；熟悉的任务直接执行。
2. **减少串行往返**：确定步骤批处理，在需要新信息的边界暂停；浏览器端就近执行、条件满足立即返回。
3. **让观察与当前任务对齐**：局部语义观察、目标周边关系、delta、按需获取工具 schema，减少无关内容。
4. **有条件地使用快速决策模型**：Jev 等模型选择已经观察、已经实现的候选动作，替代主模型决策轮次。
5. **以真实结果衡量速度**：同时测正确完成率、错误动作率、整任务 p50/p90、恢复次数和准备成本。

这里最有价值的是 WALT / AWM / Agent JIT 的流程与工具复用思路，以及 AgentOccam / FocusAgent 的观察设计。工程参考重点是 Playwright CLI、agent-browser、browser-use、Stagehand、BrowserGym/AgentLab。

本报告是研究结论和实施建议。论文数字属于作者的实验，GitHub 能力属于查阅时的版本；本项目尚未复现这些速度/成功率。先前产生的技能和 Jev flow 修改仍是未完成验证的本地草稿。

## 目录

- [证据范围与分级](#证据范围与分级)
- [本机会话与当前实现](#本机会话与当前实现)
- [论文和期刊](#论文和期刊)
- [GitHub 与工程实现](#github-与工程实现)
- [建议架构](#建议架构)
- [采用优先级](#采用优先级)
- [对照验证方案](#对照验证方案)
- [来源索引](#来源索引)

## 证据范围与分级

本轮选取 16 项论文/期刊研究、9 个 GitHub 项目，以及 Chrome WebMCP、Playwright 官方文档。通过 Grok 搜索发现候选，然后查阅论文原文、正式会议/期刊页面、作者仓库与关键源码。

证据分三层：

- **论文报告**：记录具体数据集、基线、测量边界、是否同行评审；不直接外推到企业后台业务。
- **实现证据**：实际读取 README/源码中的机制；没有安装运行的项目不声称已复现性能。
- **本项目推断**：结合本机会话与代码给出建议；收益留给本机对照实验确认。

期刊方面核对了 JAIR 2026 综述、BrowserGym 的 TMLR 2025 作者引用，以及 FocusAgent 的 TMLR 2026 作者引用和 arXiv 版本注记。OpenReview 页面在本次访问中出现浏览器验证，未声称读取其评审全文。会议论文与期刊分开标注；arXiv 不自动代表正式发表。

## 本机会话与当前实现

会话统计（原始记录不公开）：扫描了本机 99 个 Codex 会话文件与 38 个 OpenCode 会话；排除本次研究及子会话后，识别 17 个使用会话、982 条包含 CLI 的 shell 请求、984 次 CLI 调用表达式。

主要痛点是临时 JS、重复探查、固定等待、旧 ref、引号错误，以及批次中前一步失败后继续执行。历史样本中有开发调试和不同版本，不能当作当前系统成功率测试。

### 已有能力应充分利用

当前 `chrome-shell` 已经提供 scoped inspect、稳定 ref、frame 身份、scope=pipe、fillform、组件 select、delta、watch、条件 wait、readonly page tools、capture/publish、defer 和 CLI 文件输入。

因此很多第一阶段改进属于**使用规范和业务工具复用**，不是重新实现一套浏览器驱动。

源码核对：

- `app/native-server/src/command/semantic-exec.ts:118–150`：每次请求获取 workspace tools 并随请求交给扩展。
- `app/native-server/src/command/workspace-tools.ts:159–209`：已有进程级目录发现缓存，TTL 为 **2 秒**。后续研究应测缓存命中率、工具 payload 大小和发布耗时，而不是笼统声称“没有缓存”。
- `app/chrome-extension/entrypoints/background/tools/browser/semantic-shell.ts`：已有语义等待、组合命令和动作执行。
- `skills/chrome-shell/references/semantic-shell.md`：`&&` 为依赖链；`;` 和换行是无条件继续，不能混淆。

## 论文和期刊

### 1. 学术期刊：用于建立评测与设计框架

| 研究                                                        | 发表与已核对证据                                                       | 主要发现                                                                      | 对本项目的意义与限制                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A Comprehensive Survey of Agents for Computer Use** [P01] | **JAIR 85，2026-03-26**；期刊官网及 DOI `10.1613/jair.1.19490`         | 综述 87 项研究和 33 个数据集；强调泛化、规划、现实复杂度、评测标准和部署差距  | 用于选择评测维度。其视觉/低层控制建议面向通用计算机操作，不能直接推出固定企业网站应默认截图驱动   |
| **The BrowserGym Ecosystem for Web Agent Research** [P02]   | **TMLR 2025**；论文与 ServiceNow 作者仓库 citation；正文框架与评测章节 | 统一 observation/action/task 接口、跨基准测试、AgentLab 轨迹分析与可复现性    | 建立独立验收、分层计时和可回放失败证据。它是研究框架，接入本项目仍要适配测试环境                  |
| **FocusAgent** [P03]                                        | **TMLR 2026-08**；arXiv v2 注记和作者仓库相符；读方法与附录 D          | 用小模型筛选 AxTree 行，观察内容减少 50% 以上；全文指出部分设置有轻微性能下降 | 筛选方法有价值，但默认每步增加模型不符合速度优先。应先做确定性 scope/去重，超大观察才评估模型筛选 |

**FocusAgent 的重要负结果**：附录 D 在 33 个 WorkArena L1 任务上测 LLM API wall time，包含步骤内重试。GenericAgent 每步均值 **2.5s**，FocusAgent 的主模型仍为 **2.5s**，额外 GPT-4.1-mini 检索为 **7.6s**，合计 **10.1s**；总 p95 分别 **4.8s / 17.4s**。这是每步模型调用耗时，不是整任务浏览器耗时。不能因为观察缩短就宣布任务更快。[P03，Appendix D/Table 11]

### 2. 已发表会议研究：复用、表示与功能验收

| 研究                                        | 发表                             | 已核对的结果/机制                                                                                                                          | 采用判断                                                                                                    |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **WebArena** [P04]                          | ICLR 2024                        | 用实际网站状态、URL、数据等评估功能完成；原始 GPT-4 基线 14.41%，人类 78.24%                                                               | 借鉴独立结果验收；历史基线不是今天模型的水平                                                                |
| **WorkArena** [P05]                         | ICML 2024                        | ServiceNow 上 33 类企业工作任务；菜单、列表、表单等更接近企业后台                                                                          | 用它的任务分类补充企业后台业务用例，不能只测登录/单按钮                                                     |
| **Mind2Web** [P06]                          | NeurIPS 2023 Spotlight           | 137 个网站、31 个领域、2,000+ 任务；先筛 HTML 候选再决策有助于效果和效率                                                                   | 借鉴候选筛选；离线快照上的定位成功不等于实时 SPA 整任务成功                                                 |
| **AgentOccam** [P07]                        | ICLR 2025                        | 简化动作和观察空间、合并重复内容、表格转紧凑表示、保留关键节点附近信息、用 branch/prune 管理子任务                                         | 优先吸收表示与上下文裁剪。原方法移除 scroll/tab 等动作的实验设定不宜原样搬入无限滚动、弹窗、多 tab 企业任务 |
| **Agent Workflow Memory（AWM）** [P08]      | ICML 2025                        | 从成功轨迹归纳可复用 workflow；论文摘要报告 Mind2Web/WebArena 相对成功率提升 24.6% / 51.1%，并减少成功任务步骤                             | 最适合重复业务流程；缓存的是流程/契约，不是跨页面重用 DOM ref。注意相对提升不是百分点                       |
| **WALT: Web Agents that Learn Tools** [P09] | **ICLR 2026**，已核对会议 poster | 将网站搜索/筛选/创建等功能发现、构造、验证为工具；验证输入 schema、selector、URL 参数优化；WebArena 50.1%、VisualWebArena 52.9% 是作者报告 | 与 `.webmcp` 和 capture 最匹配。应只发布通过验证的工具，避免把一次成功点击未经校验固化                      |
| **WebAgent-R1** [P10]                       | EMNLP 2025                       | 在线多轮 RL 以真实任务完成奖励训练，WebArena-Lite 上 Qwen-2.5-3B 6.1%→33.9%、LLaMA-3.1-8B 8.5%→44.8%                                       | 支持“小模型也能胜任特定任务”，但需要训练环境/数据，不能把修改技能描述等同于复现该效果；近期优先级低         |

WALT 原文优化目标同时考虑 `FailRate + StepCount + AgenticRatio`；最后一个指标是需要模型判断的步骤占比。比起只换快模型，更直接的办法是让熟悉任务的模型步骤比例下降。[P09，§3.2]

### 3. 直接关注延迟和执行结构的研究

| 研究                                                                                     | 证据状态                                                       | 原文结果与限制                                                                                                                                                      | 本项目结论                                                                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Agent JIT Compilation for Latency-Optimizing Web Agent Planning and Scheduling** [P11] | arXiv v2 明确标注 **ICML 2026 accepted**；已读方法、评测、限制 | 将任务编译为含工具调用/条件/并行的程序；工具有 pre/postconditions。作者报告 JIT-Planner 平均 11.7s vs Browser-Use 122.1s（10.4×），37 个任务、5 个应用、每配置 3 次 | 优先吸收“规划一次、程序执行、前后置条件验证”。不直接导入整个 Monte Carlo 调度器                                                |
| **ActionEngine** [P12]                                                                   | 2026-02 预印本；已读 §6 和表格                                 | 离线构建状态机，在线生成程序并做局部验证。Reddit 子集 106 任务；表 1 均值 **1.8 次** LLM 调用、237s→118s、66%→95%                                                   | 借鉴有效路由/状态转移图。摘要“一次调用”的说法不能替代表格均值；基线 GPT-4-Turbo 与方法 Claude 4.5 不同，收益不能全部归因于结构 |
| **Beyond Browsing: API-Based Web Agents** [P13]                                          | arXiv v3，2025-06；本次未独立确认正式 venue                    | UI/API 混合 agent 在 WebArena 达 38.9%，较浏览器-only 高逾 24 个百分点（作者报告）                                                                                  | 支持业务操作 API + UI 的混合路径；需要 UI 验收时仍保留真实点击/事件链                                                          |
| **What Limits Agentic Systems Efficiency? / SpecCache** [P14]                            | 2025 预印本；已读 §2–4、限制                                   | LLM 与环境延迟都重要，环境最高占 53.7%；推测性预取使环境开销最多降低 3.2×。加速评测从两个检索型基准各取 10 题、每题 5 次                                            | 有界预取适合文档/只读查询。这里主要是抓网页，不能把 3.2×当成业务整任务收益，也不能推测执行提交审批                             |
| **Speculative Macro Commit（SMC）** [P15]                                                | arXiv 2026-09，作者注记 MLSP2026 accepted                      | 快模型在隔离快照预执行多动作，主模型匹配后提交；Telecom 子集较顺序执行降延迟 18.59%，AppWorld 降 44.9%但任务完成有小幅下降                                          | 真实业务没有廉价快照/回滚；近期只借鉴宏识别和依赖分析，不采用真实副作用的推测执行                                              |
| **Cognitive Duality / CogniWeb** [P16]                                                   | 2025-08 预印本                                                 | 快反应/慢推理分层，WebArena 作者报告 43.96% 成功率、token 减少 75%                                                                                                  | 支持按任务难度选执行层；没有独立证明 Jev 在本机能达到相同速度/准确率                                                           |

**Agent JIT 的准备成本必须纳入决策**：原文 §6 给出每应用工具合成 **25–90 分钟**，调度器轨迹采集 **25–45 分钟**，并行可降低到约 20–30 分钟量级。其评测中的 27 个 REAL 任务包含人工设计、分别适合串行/并行/hedge 的任务；另外 10 个 WebArena 任务主要顺序执行，仅测 planner。这里的 10.4×不是“任意网站开箱即得”的数字。[P11，§4.1/§6]

### 4. 研究之间的共识与冲突

- **共识**：减少不必要模型轮次、改善观察表示、复用验证过的操作、保留真实结果验收。
- **观察范围有冲突**：AgentOccam 在实验中去掉滚动并读完整页面；FocusAgent 再用模型筛选；本项目已有 scoped inspect/delta，优先使用无需额外模型的结构化范围选择。
- **缓存对象必须分清**：稳定的流程/工具代码、页面工具目录、业务字典、实时业务结果、DOM refs 的失效条件完全不同，不能统一一个 TTL。
- **效果与速度可能冲突**：多角色、多 evaluator、MCTS、每步检索模型，可能提高部分任务成功率，却增加尾延迟。只在有歧义/失败证据时升级。
- **自动修复不应覆盖原错误**：保留失败回执并局部补证据；新定位必须经过唯一性和业务键核对，重新写入前确认上次结果。

## GitHub 与工程实现

### 1. 生产工具的具体可借鉴点

| 项目                                | 本轮查阅                                                               | 可借鉴                                                                             | 本地采用边界                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **microsoft/playwright-cli** [G01]  | README、命令、会话/快照/attach/WebMCP                                  | CLI + 技能入口、快照落盘按需读、局部 snapshot/find、录制生成代码、可附着现有浏览器 | 适合作对照驱动和回归参考；当前 Chrome 会话与业务工具可继续复用，换驱动收益需实测                                                                    |
| **vercel-labs/agent-browser** [G02] | README 的 batch、wait、snapshot、pin-tab、WebMCP                       | `batch --bail`、目标 tab 固定、条件等待；工具目录变化才输出简述，需要时取 schema   | 工具 discovery 事件缓存值得借鉴。README 的快性能描述不是本机 benchmark                                                                              |
| **browser-use/browser-use** [G03]   | `browser_use/agent/service.py` 的 `multi_act`、loop detection          | 批次在错误、done、声明会换页的动作、URL/focus 变化后终止；检测重复动作和页面停滞   | 借鉴观察边界与无进展检测。不要把其固定动作间等待直接抄进速度优先路径                                                                                |
| **browserbase/stagehand** [G04]     | v4 README、observe 文档、`packages/extension/services/cacheService.ts` | 自然语言观察和确定性 locator 执行分离；执行靠近浏览器；缓存命中/失效可观测         | 当前源码缓存依赖 API key + Browserbase session，并将 AxTree 发往服务端；不是无依赖的本地缓存。最佳努力 fallback 与本项目 fail-fast 策略也要区别处理 |

关键实现细节：

- `browser-use` 的 `multi_act` 在每一步读取动作前后的 URL 和 focus target，并检查 `terminates_sequence`。**它不是任意长批次执行到底**；这些检查本身也有成本。我们的语义版本和目标身份信息可用于更精确的局部失效判断。
- `agent-browser` README 描述：WebMCP 使用 CDP 事件订阅缓存，不在每次动作后轮询发现；初次发现与目录改变时发简述，完整 schema 延迟加载。这是减少上下文和协议开销的具体设计。
- Stagehand `cacheService.ts` 对显式 locator scope 绕过缓存，因为现有服务端 cache key 无法安全表达该范围；说明缓存键不完整会直接影响正确性。
- Playwright 官方 actionability 要求 click 目标唯一、可见、稳定、能接收事件且 enabled；存在节点并不等于现在可点击。[D01]

### 2. 研究实现与评测工具

| 项目                                    | 已核对内容                                                                                      | 建议用途                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **SalesforceAIResearch/WALT** [G05]     | README 的 discover/generate/record、工具 JSON、输入 schema、确定性/agentic 步骤、benchmark 入口 | 参考将已验证业务操作整理成工具；已知目标用定向 generate 思路，避免全站漫游 |
| **ServiceNow/BrowserGym** [G06]         | README、论文、任务 setup/validate、多个基准                                                     | 参考测试夹具和独立完成断言                                                 |
| **ServiceNow/AgentLab** [G07]           | README 的 study、并行任务依赖、AgentXRay、可复现元数据                                          | 参考轨迹、分阶段计时、失败定位；并行实验要避免共享数据互相污染             |
| **imenelydiaker/focus_agent** [G08]     | README、论文、`scripts/latency_analysis.py`                                                     | 借鉴把检索模型和执行模型分别计时的方法；包含 BM25/embedding/规则等对照组   |
| **zorazrw/agent-workflow-memory** [G09] | README、offline/online 两条 pipeline、正式论文                                                  | 借鉴成功轨迹抽象和按网站/任务检索 workflow                                 |

### 3. 查阅时的版本

2026-09-21 查询 GitHub `main` 得到以下 commit；源码研究结论可用这些版本定位，后续实现应重新核对。

| 项目           | commit                                     |
| -------------- | ------------------------------------------ |
| playwright-cli | `74354ecc7a43da16d91a9bc54fa8db8283a3fcf5` |
| agent-browser  | `44583ac8385d814ab98cbf40feec97620376b50e` |
| browser-use    | `d8110c5ff87ccba887aaa726cdb780f2f84bef8d` |
| stagehand      | `ea2789ca56e8a7ee154850de37657823c98604f8` |

### 4. WebMCP 标准

Chrome 官方文档（2026-08-07 更新）称 WebMCP 为 proposed standard，并提供 Chrome 149 起的 origin trial；可声明 JavaScript 工具或 HTML 表单工具。[D02]

这与本项目 `.webmcp` 方向一致，但本地注入工具、捕获 API 操作和网站原生 WebMCP 不是同一来源。执行器应明确工具来源、适用 origin/frame 和当前可用性。网站未提供原生工具时，已有本地经过验证的业务工具仍有价值。

## 建议架构

```text
任务 + 验收条件
  ↓
选择业务 API / 真实 UI / 页面工具
  ↓
最小充分观察（tab + frame + 页面身份 + 业务实体 + 当前子目标）
  ↓
匹配已验证操作 → 前置检查 → 本地批处理 → 条件等待 → 后置断言
  ↓ 未知语义分支
Jev/小模型选择已知候选，或主模型规划新路径
  ↓
独立读回/UI验收 → 保存成功操作契约与失败证据
```

### 操作契约

每个可复用操作至少记录：

- 名称、输入类型、用途、适用页面/版本。
- 前置条件：环境、组织、权限/菜单、页面状态、唯一业务键。
- 执行程序与依赖顺序；哪些变化要求中断当前批次。
- 后置条件和独立验证方式：字段回填、列表/详情、实际流程状态、导出内容。
- 成功样例、最近验证时间、失败原因、失效规则。

缓存稳定定位规则和经过验证的业务动作；DOM ref 只属于当前存活节点。不能把一次记录的 ref 当成跨会话可复用定位器。

### 快速路径与慢速路径

- **确定性热路径**：已验证工具/宏 + 检查，省去逐步模型调用。
- **轻量语义路径**：候选已知、观察新鲜、输入值已准备时，Jev 在本地闭环内选择。
- **复杂路径**：新页面、不确定业务意图、证据冲突、定位失效时，由主模型定位问题并生成新方案。

一次观察尽量回答当前独立问题；依赖前一步结果的问题等待新观察。业务单据的 ID、金额、日期、幂等判断放代码与服务端规则。

## 采用优先级

| 优先级 | 改进                                              | 对应痛点/依据                         | 预计涉及                             | 验证要求                                                        |
| ------ | ------------------------------------------------- | ------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| **P0** | `&&` 依赖链、未知页面边界、固定 tab、超时先查状态 | 历史失败与 browser-use 批次保护       | 两个技能文档、示例                   | 前一步失败不能执行后续写入；无重复提交                          |
| **P0** | 有界条件等待；唯一弹窗/行/确认按钮                | 固定 sleep、默认首行匹配              | 业务 E2E page tools                  | 重名行拒绝、已选状态不反转、满足条件立即返回、超时明确失败      |
| **P0** | 独立验收与分层计时                                | WebArena/BrowserGym/SpecCache         | 回归夹具、receipt                    | 假成功/业务码失败被检出；区分模型/浏览器/整任务耗时             |
| **P1** | 定向固化 5–10 个高频操作及契约                    | WALT/AWM/JIT                          | `.webmcp`、操作库、参数化示例        | 冷启动/复用分别测；页面/实体变更使错误缓存失效                  |
| **P1** | 更精确局部观察和按需工具 schema                   | AgentOccam/FocusAgent/agent-browser   | 技能策略，必要时语义层               | 减少输出的同时不丢失候选、表格列含义和错误提示                  |
| **P1** | 工具目录版本缓存与变化通知                        | 本地 2 秒 TTL、agent-browser 事件缓存 | bridge/workspace tools，先 profiling | 修改/发布/删除工具能及时失效；比较有无工具时启动和 payload 成本 |
| **P1** | 可选 Jev 短循环                                   | 用户速度目标、快慢分层                | 复用共享 API 配置与现有 Jev 客户端   | 相对主模型逐步决策确实减少整任务时间，错误动作不增加            |
| **P2** | 只读预取与状态键缓存                              | SpecCache                             | 文档/字典/菜单读取                   | key 含环境/组织/查询条件；写后失效，避免扩大请求量得不偿失      |
| **P2** | 失败节点的局部重新定位与重规划                    | ActionEngine/AgentOccam               | 失败回执与运行器                     | 保留原错，禁止换到相似但不对应业务键的记录                      |

### 暂不优先投入

- 全站自动探索并生成所有操作：准备成本高；先选择历史中真正重复的路径。
- 每步模型检索/多层 reviewer：FocusAgent 给出了明确额外延迟，需按场景验证。
- 真实业务副作用的推测执行、盲目并行点击：缺少论文里的隔离快照/可回滚环境。
- 为这次技能优化训练专用模型：WebAgent-R1 是训练研究，与当前工程投入范围不同。
- 整体替换浏览器驱动：现有驱动已具备重要能力，先测量并补齐缺口更容易判断收益。

### 对此前草稿的影响

此前的 Jev flow 方案需要重新评估：每次都重新观察会增加 CLI 开销，整个 snapshot 的严格相等可能把无关区域变化也当成失效。下一阶段应比较“受影响目标/文档身份/业务前置条件”的局部校验与全状态校验，而不是先把草稿当作最终架构。

登录态摘要和弹窗唯一性方向值得保留，但异步事件时序、零菜单账号、Vue 重渲染、多弹窗、禁用状态均需验证。正确性不能由文档措辞代替。

## 对照验证方案

### 测试矩阵

用本地夹具和已授权测试环境组织 6 组任务，每组至少 5 个变体：

1. 表单填写、required、disabled、业务错误与成功回填。
2. Element UI combobox、表格选择弹窗、同名项、分页和重渲染。
3. 多 tab、iframe、导航后 ref 失效和菜单权限差异。
4. 异步加载、局部刷新、持续轮询页面、短暂 toast。
5. UI 保存后的列表/详情回查、流程状态、导出核对。
6. 已知工具复用、schema/版本变化、未知分支和 API 错误。

基线组与候选组分层比较：

- A：当前技能的主模型逐步操作。
- B：确定性批处理与条件等待。
- C：经过验证的业务工具/宏复用。
- D：C + 可选 Jev 处理语义分支。
- E：仅对大观察增加候选筛选实验。

固定页面初态、账号/组织、断言、浏览器/扩展版本和模型版本；交替运行次序。每配置至少 3 次作为初步比较，尾延迟结论需要更多样本。先合成数据，不用正式业务写入做随机基准。

### 指标

```text
total = 规划与模型往返 + CLI/桥接 + 浏览器执行 + 条件等待 + 验证 + 恢复
```

报告：正确完成率、错误业务目标/重复写次数、false completion、p50/p90、超时/交回率、浏览器调用数、模型调用数、输出字节数、模型用量、冷/热路径准备成本。

只比较成功样本时间会掩盖快速失败，必须同时报告所有尝试的成本和失败原因。模型最新别名可以日常使用；实验记录响应实际版本，以便升级前后比较。

**通过标准由测试结果决定**：优先要求现有确定性用例不回退、关键误操作为零，再评价整任务速度改善。Jev 的单次 API 很快不是单独通过标准。

## 来源索引

### 论文/期刊

- [P01] JAIR 2026：<https://www.jair.org/index.php/jair/article/view/19490>
- [P02] BrowserGym：<https://arxiv.org/html/2412.05467>；作者期刊 citation：<https://github.com/ServiceNow/BrowserGym#-citing-this-work>
- [P03] FocusAgent v2：<https://arxiv.org/html/2510.03204v2>，尤其 Appendix D/Table 11；<https://arxiv.org/abs/2510.03204>
- [P04] WebArena ICLR 2024：<https://proceedings.iclr.cc/paper_files/paper/2024/hash/4410c0711e9154a7a2d26f9b3816d1ef-Abstract-Conference.html>
- [P05] WorkArena ICML 2024：<https://proceedings.mlr.press/v235/drouin24a.html>
- [P06] Mind2Web：<https://arxiv.org/abs/2306.06070>
- [P07] AgentOccam ICLR 2025：<https://proceedings.iclr.cc/paper_files/paper/2025/hash/f2c6e459b95694a24ac69c469a4ee746-Abstract-Conference.html>；方法 §4：<https://arxiv.org/html/2410.13825>
- [P08] AWM ICML 2025：<https://proceedings.mlr.press/v267/wang25bx.html>
- [P09] WALT ICLR 2026：<https://iclr.cc/virtual/2026/poster/10008481>；方法 §3：<https://arxiv.org/html/2510.01524v1>
- [P10] WebAgent-R1 EMNLP 2025：<https://aclanthology.org/2025.emnlp-main.401/>
- [P11] Agent JIT：<https://arxiv.org/html/2605.21470v2>；录用注记：<https://arxiv.org/abs/2605.21470>
- [P12] ActionEngine：<https://arxiv.org/html/2602.20502v1>
- [P13] Beyond Browsing：<https://arxiv.org/abs/2410.16464>
- [P14] SpecCache：<https://arxiv.org/html/2510.16276>
- [P15] SMC：<https://arxiv.org/abs/2609.03236>
- [P16] CogniWeb：<https://arxiv.org/abs/2508.05081>

### GitHub 与官方文档

- [G01] <https://github.com/microsoft/playwright-cli>
- [G02] <https://github.com/vercel-labs/agent-browser>，README 的 Batch Execution / WebMCP / Tab pinning
- [G03] <https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/agent/service.py>，`multi_act`、loop detection
- [G04] <https://github.com/browserbase/stagehand/blob/ea2789ca56e8a7ee154850de37657823c98604f8/packages/extension/services/cacheService.ts>
- [G05] <https://github.com/SalesforceAIResearch/WALT>
- [G06] <https://github.com/ServiceNow/BrowserGym>
- [G07] <https://github.com/ServiceNow/AgentLab>
- [G08] <https://github.com/imenelydiaker/focus_agent>；计时实现：<https://github.com/imenelydiaker/focus_agent/blob/main/scripts/latency_analysis.py>
- [G09] <https://github.com/zorazrw/agent-workflow-memory>
- [D01] Playwright actionability：<https://playwright.dev/docs/actionability>
- [D02] Chrome WebMCP：<https://developer.chrome.com/docs/ai/webmcp>
- Jev 官方接口与已知局限：<https://docs.typesafe.ai/api>、<https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- 用户指定的 Jev 技能：<https://github.com/wuyoscar/jev-skill>
