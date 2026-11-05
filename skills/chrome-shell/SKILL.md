---
name: chrome-shell
description: Token-efficient browser operation through the local chrome-shell executable and Semantic Shell DSL, reusing the user's real, logged-in Chrome. Use when an agent should inspect pages, click/fill, navigate tabs, read page data or call page APIs with the browser's login, take screenshots, verify UI/API behavior, capture operations, or call .webmcp page tools through shell commands — including requests like "use my Chrome", "the page I already opened/logged in", "看一下浏览器里的页面", "用 chrome-shell".
---

# Chrome Semantic Shell

Drive Chrome through one local command. `chrome-shell` sends a validated Semantic Shell program directly to the headless extension runtime. `chrome-shell help [command]` prints the syntax and accepted options without touching the browser.

## Operating Loop

Batch a complete, coherent operation into one invocation:

```powershell
chrome-shell 'fillform 邮箱=$email && query role=button name="登录" | click && wait text="仪表盘" timeout=10000 && assert text="仪表盘"' --tab 123 --var 'email=user@example.com'
```

Register cleanup immediately after allocating temporary browser state:

```powershell
chrome-shell 'tab new https://example.com active=false; defer { tab close }; inspect interactive limit=30'
```

Deferred blocks run in LIFO order after success, failure, or a command deadline. They guarantee cleanup but do not hide the original failure; the process still exits nonzero.

1. Resolve the target tab/workspace once. Start with the smallest `inspect` or `query` that answers the task; omit a fresh inspect when the last result already establishes the targets.
2. Pipe unique nodes into actions and batch ordinary fields with `fillform`.
3. Consume returned refs and the final actionable delta directly.
4. Verify with `assert`, API/network output, or a page tool.
5. Escalate to full text, screenshot, explicit JS, or human selection only when the semantic layer cannot answer.

The command exits `0` only when the complete program succeeds. Parser errors, unknown options, a `query` with no match, ambiguous targets, stale refs, failed assertions, HTTP errors, bridge failures, and timeouts exit nonzero; treat them as real failures. Every command validates its options before anything runs, so a typo never executes half a program.

## Shell Usage (Windows/PowerShell first)

- Single quotes around the DSL keep `$variables` for Chrome. Inside the DSL quote values with `"..."`; a quote must be followed by a space or the end of the value.
- Anything with nested quotes, JSON, or JS goes into a UTF-8 `.chrome` file (`chrome-shell --file job.chrome`, add `--fail-fast` so a failed line stops the file) or a `.js` file (`js file=extract.js`). Data goes into `--vars-file`. A parse error calls for corrected syntax, not rephrasing the same inline command.
- Do not trim output with `Select-Object`/`Select-String`, `2>&1`, or `| node -e`: that hides failure lines and exit codes. Narrow at the source (`limit=`, `name~=`, `pick=`, `match=`, `--quiet`) or write big results with `--out result.txt`.
- Non-ASCII output: the managed launcher (`chrome-shell-bridge shims`, state in `chrome-shell-bridge status`) decodes UTF-8 and switches the PowerShell session to UTF-8. PowerShell fixes its own output encoding at the first line it prints, so start the command with `chrome-shell`; when something must print earlier, begin with `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);`. Do not wrap calls in `cmd /c`; from Node/Python spawn `node <entry>` where `chrome-shell --print-entry` prints the entry.
- In loops check `$LASTEXITCODE` per call; redirecting to a file does not make a failure succeed.

## Choose the Fast Path

| Current task                                                 | Execution path                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Known API/data operation                                     | Existing page tool/captured operation; else `http` in the page context; reduce results at source |
| Known UI interaction                                         | One guarded DSL batch, using `&&` between dependent actions                                      |
| Repeated semantic choice among known actions                 | Optional Jev flow below; replace host reasoning turns                                            |
| Unknown workflow, missing evidence, new code/text generation | Host agent plans/collects facts, then returns to a fast path                                     |
| Forum research (linux.do / NodeSeek / V2EX)                  | The `ai-forum-research` skill                                                                    |

For **UI acceptance**, exercise the actual UI handlers: an API write or Vue-model assignment does not test required fields, dropdown linkage, permissions, or rendering. API setup and read-back are useful fixtures and oracles.

Batch until the next **unknown observation**, not an arbitrary step count. Stop after opening an unfamiliar dialog or navigating to an unknown page. Parallelize independent reads or separate tabs; keep mutations on one tab serial. After a write times out, read its actual status before any retry.

Use `wait text=...`, `wait selector=...` (`state=attached` for inputs hidden by rich editors) or `wait url~=...` for the expected condition — never a fixed `wait N` or `Start-Sleep`; `wait text` only proves something if that text was not already on the page. Use `watch` for an external change. `wait network` is only useful when network quiescence is the actual condition.

### Optional Jev fast loop

Read [references/jev-fast-loop.md](references/jev-fast-loop.md) when repeated browser decisions justify a local loop. Reuse the installed `jev`/`jev-ui` skill and `~/.agents/jev/config.json` (`api_url`, `api_key`, `model: "jev-latest"`). This skill's [config.json](config.json) holds `jev.enabled` and the shared config path; it does not duplicate the key.

```powershell
python "$HOME/.agents/skills/jev/scripts/jev.py" config-check
python "<skill-dir>/scripts/jev_flow.py" plan.json --tab 123 --workspace . --dry-run
python "<skill-dir>/scripts/jev_flow.py" plan.json --tab 123 --workspace .
```

Host-authored macros execute in one process with persistent browser/Jev connections and no host-model turn between nodes. Jev chooses eligible action IDs; deterministic nodes are fused without a model. Every macro has a guard and an independent assertion. URL drift, stale/ambiguous targets, low confidence, no progress and API errors stop explicitly. Disabling Jev returns `needs_review` before API/browser work for decision flows.

## Automatic Operation Memory

Learning is on by default. Successful asserted batches automatically become candidates; repeated verified templates with varied input are published as `.webmcp/learned/auto_*.tool.json`. Do not wait for the user to request script generation. At task start inspect the tool catalog once, then reuse applicable learned operations with their typed inputs and URL scope.

Use stable locators and keep a real final assertion in reusable batches. The background learner parameterizes input, tracks dependencies and versions, archives obsolete generated tools and removes them from the active catalog. `learn status` and `learn maintain` are diagnostics, not mandatory learning steps. Read [references/automatic-learning.md](references/automatic-learning.md) for limits and configuration.

## Perception and Stable Refs

```powershell
chrome-shell 'inspect interactive limit=30'
chrome-shell 'inspect dialog query="创建网站"'
chrome-shell 'query role=button name="保存"'
chrome-shell 'query role=link name~="下载" nth=0'
```

Views are `interactive`, `forms`, `tables`, `dialog`, `text`, and `full`. Default to a scoped view; `full` is an explicit content-heavy escalation, `text` returns readable text blocks once each.

`role=`, `name=` (exact), `name~=` (substring) and `css=` filter in the page before `limit`, so a crowded page cannot hide the target; a role filter also selects non-interactive roles such as `dialog`, `row` or `heading`. `query` fails when nothing matches. `inspect dialog` picks the dialog named by `query=`, else the one on top.

Semantic inspection merges the top document and all accessible frames; framed nodes include `frame=<id>`, and actions consume that frame identity. Refs remain stable while the same DOM node lives, also across invocations. Even an identical-looking node replacement invalidates the old ref. `STALE_REF` or multiple matches require another scoped query; use `nth=` only when the list order itself is the meaning.

## Compose and Batch

```powershell
chrome-shell 'inspect dialog query="创建网站" && fillform 域名=$domain && select role=combobox name="协议" value="https" && query "确认" | click && wait network && assert text="创建成功"' --var 'domain=example.com'
```

- `;` or newline: always continue (`--fail-fast` stops instead). `&&` / `||`: branch on the prior command result. `|`: pass semantic nodes.
- `scope=pipe`: require one piped container and query only inside it and its frame (`scope` accepts only `pipe` or a ref).
- `fillform`: fill ordinary fields in one action batch. `select`: open a component combobox, wait for the real option, click it. Never write its proxy input.

Use `&&` for dependent writes. Use `defer` for cleanup; a failed batch is not rolled back.

```text
click @ref_12
dblclick role=button name="编辑"
fill @ref_15 $value submit=true
type @ref_15 "search words" submit=true
fillform 邮箱=$email 密码=$password
select role=combobox name="状态" value="启用"
query role=row query="ORDER-001" | query role=button name="查看" scope=pipe | click
check role=checkbox name="启用" value=true
key "Ctrl+S"
scroll down 600
scroll bottom
scroll @ref_40
query role=list name="消息" | scroll down 300
hover role=button name="更多"
upload css="#file" file=$path
upload css="#files" file=["a.pdf","b.pdf"]
```

`type` and `key` send trusted keystrokes (they insert text and trigger default actions); `type` appends at the caret, `fill` replaces the value. `key` without a target goes to the last filled or typed field. `scroll` works in background tabs; `scroll @ref` brings a node into view and a piped container scrolls itself.

Read [references/semantic-shell.md](references/semantic-shell.md) for the complete grammar, CLI options, variables, page tools, capture, and escape hatches.

## Actionable Delta

A mutating program observes once around the whole operation and returns only meaningful changes:

```text
ok tab=123 steps=4 duration=214ms
delta v41->v42
~ ref_21 button "确认" disabled=false
+ ref_35 status "创建成功"
net POST /api/v2/websites 200 241ms
+tab 456 https://example.com/export (opened by the page)
```

Use new or updated refs directly. Run another inspect only after navigation, node replacement, ambiguity, or when the delta does not contain the next target. A navigation reports only its target URL and node count. `+tab` lines name tabs the page opened; pass that id with `--tab` next.

## Page Data and APIs

Prefer, in order: a declared/captured page tool, `http`/`storage`/`extract`, then `js`.

```text
tool ls
tool call submit_order input={"confirm":true} timeout=60000
http GET /api/orders?status=open pick=data.records as=$rows
storage get session key=workFlowSystem:accessToken as=$token
http POST /flow/save headers={"accessToken":"$token"} body={"id":1}
extract css=".post" fields={"title":"h2","href":"a@href","floor":".no"} as=$posts
```

- `http` runs in the page: same origin, cookies, certificates and CORS as the page; relative URLs resolve against it; non-2xx fails with the response snippet. `pick=` reduces the JSON in the page. `context=extension` sends from the extension instead.
- `storage get` stores a value without printing it; reference it in `headers=` as `"$token"`. Never echo credentials into the transcript.
- `js` is the narrow escape hatch: a single expression returns its value (`js "location.href"`); statements need `return` (`js code="const a=1; return a"`); `VARS` holds program variables; the value prints as `js: <value>`. Results above 50 KB are cut with a warning (`max=` raises it). Give `frame=<id>` to run in an iframe. Do not generate DOM-survey JavaScript when `inspect`/`query`/`extract` can answer.

WebMCP uses `document.modelContext`; `navigator.modelContext` is deprecated. `-C <workspace>` selects the `.webmcp` workspace; `tool ls` also lists files that failed to load and why. Mark read-only snippets `// readonly: true` (manifests: `"readOnly": true`); read-only-only programs skip change observation.

## Reusable Operation Capture

Keep capture in one invocation:

```powershell
chrome-shell 'capture begin && query "启用" | click && capture end name=enable_order && capture publish name=enable_order bindings={"requests.0.body.id":"id"} allowConstants'
```

Dynamic scalar paths must be bound before publish unless `allowConstants` explicitly accepts fixed values. Captured strings use `{{input}}` templates; number, boolean, and null bindings use typed placeholders and retain their JSON types during replay. Credentials, cookies, tokens, secrets, and passwords are never persisted. The manifest is written under `<workspace>/.webmcp/operations/` and becomes callable through `tool call`.

## Verification and Escalation

Judge success by data and errors, not appearance. A click or HTTP 200 alone does not prove persistence; read the backing list/detail API back or assert the resulting state.

```text
assert text="保存成功"
assert exists="#saved-row"
console buffer --errors
network start body=true url=/api/ ; ... ; network stop url=/api/
```

Escalation order:

1. Page tool, captured operation, or page-context `http`.
2. Scoped semantic query using native HTML/ARIA and framework adapters.
3. Page text (`inspect text`), `extract`, or `inspect full`.
4. Screenshot for Canvas, geometry, design, or genuinely unlabeled visual controls.
5. Narrow explicit JS/framework operation.
6. Human selection after roughly three deterministic failures.

`screenshot` captures the target tab through CDP, also in the background (a tab that renders nothing is activated briefly and the previous tab restored); `screenshot @ref` captures one element, `screenshot full=true` the whole page. Images never go through Chrome downloads, so no download prompt can block them; the CLI prints `artifact: <absolute-path>` — open it with the host's image viewer. A locked screen or minimized window is reported as such.

## Tabs and Long Programs

```powershell
chrome-shell 'tab list match=github'
chrome-shell 'inspect interactive' --tab 123
chrome-shell --file .webmcp/jobs/create-order.chrome --fail-fast
Get-Content -Raw .webmcp/jobs/create-order.chrome | chrome-shell --stdin
```

- Pass `--tab` for background work. Research and probing open their own tab (`tab new URL active=false; defer { tab close }`) instead of navigating a tab the user is working in. A closed tab id is gone: run `tab list` again rather than reusing it.
- `tab new` returns its tab id even when the page keeps loading (with a warning); wait for a page condition before acting.
- Single-page apps in a hidden background tab may not render (canvas designers, virtual lists); `tab switch <id>` first when the page stays empty.
- Navigation invalidates the prior semantic version; consume its delta before the next action. `navigate` fails on network error pages.
- `--timeout` bounds the whole program (max 280000 ms); `tool call ... timeout=` and `download timeout=` must fit inside it. `--dry-run` checks grammar and options only.

For latency checks use `--timing` plus a host wall clock. `durationMs` measures browser-runtime work; `roundtrip` adds transport; the host wall clock adds CLI startup.

## Boundaries

- This skill requires the `chrome-shell` executable and an updated connected extension/bridge (`chrome-shell-bridge status`). Do not silently replace it with another browser driver when the command is unavailable; report the missing bridge or extension.
- CAPTCHA, Cloudflare challenges, risk-control pages or login walls: stop and ask the user to resolve them in Chrome, then continue. Do not try to bypass them, and keep request rates low on shopping or social sites — repeated probes trigger blocks.
- The CLI discovers a custom bridge port from a local PID-validated state file unless `--endpoint` or `CHROME_SHELL_PORT` overrides it.
- Workspace JS entries and publish targets are checked by realpath; symlink escapes and symlinked publish directories fail fast.
- Do not persist sensitive variables in DSL files or operation manifests. Prefer a protected variables file or stdin when shell history exposure matters.
