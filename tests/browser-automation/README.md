# 会话驱动的浏览器回归

`coverage.json` 把实际会话故障、公开 DSL 功能和新增能力映射到测试。会话没有出现过的功能明确标注为契约补充，不伪造历史证据。

## 三层证据

前置依赖：在主仓库执行 `pnpm install` 并构建 shared/native；Python 3.10+。夹具使用系统临时目录下的 `opencode` 子目录，请先创建该目录（不写业务目录）：

```powershell
python -c "from pathlib import Path; import tempfile; Path(tempfile.gettempdir(), 'opencode').mkdir(exist_ok=True)"
```

真实浏览器测试还需要连通的扩展/bridge，`--jev` 需要现有 Jev skill 与共享 API 配置。

1. **离线回归**：解析、状态/定位、失败传播、工具输入、自动学习生命周期、Jev 分支、会话水位。
2. **真实浏览器**：`run_live.py` 驱动 localhost 合成页面，以 DOM/服务端状态作独立 oracle；每项正反向结果写入 JSON。
3. **真实 Jev 和速度对照**：`skills/chrome-shell/evals/live_benchmark.py`，相同夹具比较逐条 CLI、批处理、持久 HTTP、Jev+CLI 与 Jev+HTTP。需要共享 Jev 配置。

覆盖表表示需要验证的范围，不表示所有项目已通过；以回执里的 `passed/failed/skipped` 为准。扩展重新构建后，由 agent 在扩展上下文执行自动重载并验证协议，再执行 live 测试。失败用例保留原因，独立用例可以继续执行；失败业务动作不重试。

```powershell
pnpm --filter chrome-semantic-shell test
pnpm --filter chrome-semantic-shell-extension test
python -m unittest discover -s skills/chrome-shell/evals -p "test_*.py" -v
python -m unittest discover -s tests/browser-automation -p "test_*.py" -v
```

真实浏览器用例和基准运行前，确认本次 `dist-extension/chrome-mv3` 已重载且返回协议版本 3。运行器不会在用例中途重载扩展，避免打断测试。

```powershell
python tests/browser-automation/run_live.py --out docs/browser-regression-results.json --jev --downloads
python skills/chrome-shell/evals/live_benchmark.py --repeats 3 --out docs/browser-performance-results.json
```

下载用例只生成本地夹具文件；`--jev` 使用共享配置进行真实 API 调用。省略开关的用例明确记录为 skipped，不计为通过。

捕获用例以服务端实际收到的 POST 内容和发布文件中的 URL、方法、动态绑定为独立验收，不重复读取同一条“保存成功”提示。Chrome 在部分含 `srcdoc` 的页面上可能拒绝额外的 CDP attach；原始错误保留在第一轮回执中，不通过静默切换执行引擎来伪装通过。
