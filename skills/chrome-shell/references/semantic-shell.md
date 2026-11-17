# Chrome Semantic Shell CLI Reference

Read this when composing a non-trivial `chrome-shell` program or diagnosing a parser, target, bridge, or quoting error. `chrome-shell help <command>` prints one command's syntax and accepted options offline.

## CLI Input

```powershell
chrome-shell 'inspect interactive' --tab 123 --timeout 30000
chrome-shell 'fill @ref_2 $value' --var 'value=demo'
chrome-shell --file workflow.chrome --vars-file vars.json --fail-fast
chrome-shell --stdin --dry-run
chrome-shell 'inspect text' --tab 123 --out page.txt
```

| Option                          | Meaning                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `--tab <id>` / `--window <id>`  | Explicit Chrome target                                                                       |
| `--timeout <ms>`                | Whole-program deadline, 1–280000                                                             |
| `--output compact\|json\|debug` | Result detail (not a file path; use `--out`)                                                 |
| `--out <file>`                  | Write the result as UTF-8 to a file, print a one-line summary                                |
| `--quiet`                       | Omit the change/delta report                                                                 |
| `--fail-fast`                   | Stop at the first failed statement even across `;`/newlines                                  |
| `--dry-run`                     | Parse and validate options without page effects                                              |
| `--var key=value`               | Repeatable typed variable; JSON literals are decoded                                         |
| `--vars-json` / `--vars-file`   | Merge a JSON object; `--var` wins                                                            |
| `-C, --workspace <path>`        | Root for `.webmcp` discovery and publish; base of `js file=` paths when no `--file` is given |
| `--no-project-tools`            | Disable workspace page tools                                                                 |
| `--artifact-dir <path>`         | Stable parent; each run gets a unique child directory                                        |
| `--result-json`                 | Print the full local result envelope                                                         |
| `--timing`                      | Print HTTP round-trip time to stderr                                                         |
| `--expected-url <url>`          | Refuse effects if the target URL changed                                                     |
| `--print-entry`                 | Print the CLI entry script path (for `node <entry>` from scripts)                            |

The script limit is 64 KiB (`js file=` contents travel as variables and do not count). The endpoint is restricted to loopback HTTP.

Bridge and setup commands (`chrome-shell-bridge <command> --help` for options):

| Command                                 | Meaning                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chrome-shell-bridge register`          | Register the Native Messaging host (`--system`, `--browser chrome\|chromium\|all`, `--detect`)           |
| `chrome-shell-bridge status`            | Ports, bridge state and whether the launchers are the UTF-8 managed ones; exit code 1 when not connected |
| `chrome-shell-bridge config`            | Show or set persistent settings (`--port`, `--timeout`)                                                  |
| `chrome-shell-bridge shims`             | Install the UTF-8 managed `chrome-shell` launchers                                                       |
| `chrome-shell-bridge install-extension` | Copy the bundled extension to `~/.chrome-semantic-shell/extension` (or `--dir`), replacing the old files |
| `chrome-shell-bridge skill-path`        | Print the bundled skill folder (holds `SKILL.md`); `--json` adds the version                             |
| `chrome-shell-bridge fix-permissions`   | Restore execute permissions of the native host files                                                     |

## Composition and Quoting

```text
command ; command
command
command && command
command || recovery
query "保存" | click
```

- `;` and newline always continue (unless `--fail-fast`). `&&` runs only after success, `||` only after failure, `|` passes semantic nodes.
- Strings use single or double quotes; JSON objects/arrays and `{ blocks }` remain one token. Inside quotes, escape the same quote with a backslash. A closing quote must be followed by whitespace or the end of the value: `code="a"b` is an error instead of a silent concatenation.
- `key=value` is an option only when `key` is a plain word; a quoted argument is never an option, so `js "const a = 1; return a"` keeps its `=`.
- Quoted values are strings (a quoted `{...}`/`[...]` is still accepted as JSON when it parses); unquoted values decode numbers, booleans, `null` and JSON. Selectors such as `selector="[role=dialog]"` stay strings.
- `$name` substitutes a whole value. Inside JS use `VARS.name`; inside `headers={...}` write `"$name"`.
- Unknown options and commands fail before anything runs, including inside `defer`/`if`/`for` blocks.

`defer` blocks run in LIFO order after normal completion, failure, or command timeout; each gets a separate 10-second budget.

## Targets

```text
@ref_12
ref=ref_12
role=button name="保存"
role=button name~="保存"
text="保存"
css="#save"
xpath="//button[normalize-space(.)='保存']"
```

Exactly one piped node supplies its ref and stable locator candidates. Several piped nodes make a single-target action fail with the candidate list. A ref from an earlier invocation is located in its frame automatically; when the same ref number exists in several frames add `frame=<id>`.

`scope=pipe` requires exactly one piped node and queries inside it (`scope` accepts only `pipe` or a ref):

```text
query role=row query="ORDER-001" | query role=button name="查看" scope=pipe | click
```

## Perception

```text
inspect interactive
inspect forms query="供应商" limit=50
inspect tables
inspect dialog query="导出账单CSV"
inspect text
inspect full
query "关键字"
query role=dialog name="确认提示"
query role=button name~="导出" nth=0
query css=".card" mode=full
diff
watch timeout=5000
```

- `role=`, `name=` (exact), `name~=` (case-insensitive substring), `css=` filter in the page before `limit`. A role or css filter selects matching nodes in any view.
- `query` fails with the filters it used when nothing matches; `inspect` only observes. A `css=`-only miss tells whether the selector matched nothing, only hidden elements (display none, visibility hidden, opacity 0, no size) or only plain markup.
- `inspect dialog` uses the dialog whose text contains `query=`, else the topmost visible one (ARIA dialogs, `<dialog open>`, Element UI/Ant/Fusion dialogs and message boxes). Every inspection of a visible page waits up to 400 ms for running fades, so a dialog or popup list that is fading in counts as open and one fading out as closed; a hidden page advances no fade and is read at once.
- A node's `in=` names its innermost container: a dialog, form, table or, inside a table, its row (`in="row:HDFK001 南昌晨宇 审批通过"`; a query matches it, so `query="HDFK001" role=button` lists that row's buttons). A table is named by its column headers, a row by its cells.
- Fixed-column tables (Element UI 2, vxe-table, Ant Design 3) repeat every row in overlay tables; rows are listed once, and a control in an overlay belongs to the main row at the same height, also for `scope=pipe`.
- A checkbox or radio whose native input is hidden (opacity 0, as in Element UI and Material) is listed by its label with the input's role and `checked` state; `check`/`click` on it toggle the input. `css=` on the hidden input finds that label. Dropdown menu entries (Element UI, Ant, iView, Arco) are `menuitem`.
- `inspect text` lists text blocks once (no ancestor repeats, no script/style payloads) with up to 1000 characters each.
- Listings name `disabled`, `required`, `invalid` and `selected` only when true and omit an empty `value`; delta lines (`~`) keep every state, so a field that became enabled shows `disabled=false`.
- `inspect <view> since=vN` compares with an earlier inspect of the same view and options on the same tab that reported `state=vN` (the last four are kept per tab, also across calls) and prints only added, updated and removed nodes. Another view, or a version no longer kept, fails: inspect again without `since=`.
- Names ignore script/style/noscript text and zero-width/bidi control characters; native `<select>` is named by its label, its options are listed separately.
- Elements under `aria-hidden="true"`, transparent ancestors or `content-visibility:hidden` are not visible. Anchors without `href` that are scripted, and cards whose pointer cursor starts on them, are clickable.
- `diff` requires an earlier inspect in the same invocation. `watch` waits for a semantic version change and returns actionable nodes.

## Interaction

```text
click @ref_1
dblclick text="编辑"
fill @ref_2 $value
fill role=textbox name="邮箱" value=$email submit=true
type @ref_2 "hello" submit=true
fillform 邮箱=$email 密码=$password
select role=combobox name="状态" value="enabled" timeout=8000
check role=checkbox name="启用" value=true
key "Ctrl+S"
key Enter css="#email"
scroll down 500
scroll top
scroll @ref_9
query role=list | scroll down 300
hover role=button name="更多"
drag @ref_5 @ref_8
upload css="input[type=file]" file=$path
upload @ref_7 file=["C:/a.pdf","C:/b.pdf"]
```

- `select` opens the component, waits up to `timeout=` (default 5000) for a matching real option (popup options win over same-named menu items) and clicks it; native selects are set directly, also through a ref from an earlier invocation. When the opened select takes text (Element UI `filterable`/`remote`, Ant `showSearch`), the value is typed first so remote options load. A list that shows the same options for a second without the value ends the wait; the error names those options (`option "预付款" is not in the list; it shows 2 option(s): 物资采购, 原料采购`).
- A ref from an earlier invocation resolves in the frame that owns it. If a re-render replaced its element, an action uses the only node with the same role and name in the same container (else the only one on the page) and warns `warning click: ref_18 was re-rendered; used ref_85 (button "下一步")`; a scope ref (`scope=pipe` on a row) is found again the same way. No unique match: `STALE_REF`.
- `fill` replaces the value and commits by blurring; `submit=true` presses Enter in the field. `type` inserts trusted keystrokes at the caret (rich editors, VNC canvases, search boxes).
- `key` dispatches trusted key events through CDP; without a target it focuses the last filled/typed field. Chords use `+`, sequences spaces: `key "Ctrl+A Backspace"`.
- `scroll` runs inside the page (works in background tabs): direction + pixels, `top`/`bottom`, a target to bring into view, or a piped container to scroll.
- `upload` sets files once (the page receives a single change event); several files need `<input multiple>`.

## Variables and Control

```text
set $ids=["1","2"]
for $id in $ids { query text=$id | click }
if $confirmed { query "提交" | click } else { assert text="未确认" }
if success { assert text="成功" }
if failure { screenshot }
defer { tab close }
extract css="#order-id" as=$orderId
extract css=".row" fields={"title":"a","href":"a@href","price":".price"} as=$rows
extract @ref_12 attr=href
```

Loops stop on the first failed body command and are capped at 100 iterations. `extract` reads `attr=text|html|value|href|<attribute>`; `all=true` returns every match, `fields=` returns one object per match (`"sel"`, `"sel@attr"`, `"@attr"`, `""` = row text). Without `as=` the value is printed.

## Navigation, Waiting, and Assertions

```text
navigate https://example.com/path
back
forward
reload
tab list match=example
tab new https://example.com timeout=20000
tab switch 123
tab switch 123 focus=true
tab close 123
window
wait idle
wait gone="加载中"
wait navigation
wait network
wait text="完成"
wait selector="#result"
wait selector="#comment" state=attached
wait url~="/detail/"
assert text="保存成功"
assert exists="#saved"
assert visible="#dialog"
```

- `navigate` fails when the main frame lands on a network error page (`net::ERR_*`).
- `wait navigation` succeeds on a URL change or a completed reload seen during the wait; without an earlier inspect it compares with the URL the program started on.
- `wait idle` succeeds once the page structure and its fetch/XHR traffic have not changed for 500 ms; requests pending over 5 s (long polling, server-sent events) do not count. A page that keeps changing (clocks, carousels) fails at `timeout=`. `wait gone=` waits for text to disappear. `wait N` sleeps a fixed time: a last resort.
- `wait text` also matches the document title. `wait selector` accepts any visible match; `state=attached|detached` ignores visibility.
- `tab new` opens the tab behind the user's current tab (`active=true` makes it the active tab of its window) and returns once the document is parsed; a page still loading after `timeout=` (default 10000, at most half the remaining budget) returns its id with a warning. Tabs the page opens appear as `+tab <id> <url>` in the delta.
- `navigate` returns once the new document is parsed; slow images or long polling do not hold the program, so wait for the content you need.
- No command activates a tab or raises a window except `tab switch`, which activates the tab but leaves the window behind the user's application unless `focus=true`.
- A tab the user is not looking at (background tab, minimized window, Chrome not the focused application, or any tab while the screen is locked) is kept rendering like a foreground tab for the program: animations, transitions, timers and CDP input behave as in front. Chrome shows its "started debugging this browser" bar meanwhile; it goes away about 15 s after the last program.
- Navigation and network waits use the runtime's current tab; observation never crosses tab boundaries.

## Page Data, Diagnostics and Artifacts

```text
http GET /api/items pick=data.records as=$rows
http POST /api/items body={"name":"demo"}
http POST /login form={"user":"a","pwd":"$pwd"}
http GET https://api.example.com/x headers={"Authorization":"$auth"} context=extension
storage get session key=accessToken as=$token
console buffer --errors
network start body=true url=/api/
network stop url=/api/ limit=20
screenshot
screenshot @ref_5
screenshot full=true
dialog accept
dialog dismiss
download timeout=30000
js code="return document.title"
js "location.href"
js file=scripts/read-table.js frame=3 max=200000
```

- `http` defaults to the page context: `fetch` with the page's cookies, certificates and CORS rules; relative URLs resolve against the page; JSON bodies get `Content-Type: application/json`; non-2xx fails with `HTTP <status>` and a response snippet; `pick=` takes a dot path, an array of paths, or `{alias: path}`; `as=` stores the data. `context=extension` sends from the extension (host permissions, no page state).
- `storage get local|session|cookie key= as=` stores the value (JSON-quoted strings unwrapped) and prints only its length.
- `network stop` prints one line per request (method, status, URL, type) and a body preview; headers are never printed. XHR/fetch responses are kept whatever their content type.
- `screenshot` captures the target tab via CDP without Chrome downloads; `@ref`/locator for one element (same-origin frames included), `full=true` for the whole page (up to 16384 px tall).
- `download timeout=` must fit inside the program deadline.
- `js`: like the console, one expression returns its value and statement code returns its last expression statement (`const a = 6; a * 7` prints 42); an explicit `return` works anywhere; code ending in another statement (`for`, `if`, a declaration) returns `undefined` with a warning. The code runs async (top-level `await` works); `VARS` exposes program variables; `frame=<id>` runs in that frame's page context; results print as `js: <value>` and are cut at `max=` bytes (default 50 KB) with a warning. When the debugger cannot attach, JS runs through `chrome.userScripts` (enable "Allow User Scripts" for the extension) or the page main world (subject to page CSP).

## Page Tools

```text
tool ls
tool call tool_name input={"id":"1"} timeout=60000 max=200000
call tool_name input={"id":"1"}
```

`tool ls` prints each tool's input fields and the workspace files that failed to load (oversized, invalid, duplicate). A workspace JavaScript tool runs under the program deadline (or `timeout=`) with `max=` output bytes; a missing tool fails with the available names. A workspace manifest lives below `.webmcp`:

```json
{
  "name": "search_supplier",
  "description": "Search suppliers",
  "kind": "javascript",
  "entry": "search_supplier.js",
  "inputSchema": {
    "type": "object",
    "properties": { "keyword": { "type": "string" } },
    "required": ["keyword"]
  }
}
```

JS snippets declare `// tool:`, optional `// description:`, optional `// input:`, and optional `// readonly: true` in their first 20 lines. Manifests use `"readOnly": true`. The body receives frozen `ARGS`; a program containing only read-only tools skips change observation. Files above 256 KiB, or a catalog above 768 KiB, are skipped and reported by `tool ls`.

## Operation Capture

```text
capture begin
; query "启用" | click
; capture end name=enable_order description="Enable an order"
; capture publish name=enable_order bindings={"requests.0.body.id":"id"} allowConstants
```

The bridge publishes a sanitized `.tool.json` into `.webmcp/operations/` under the CLI workspace. String bindings are stored as `{{input}}`. Number, boolean, and null bindings use `{ "$chromeShellInput": "input" }`, receive matching JSON Schema types, and are replayed without string coercion. Every dynamic scalar must still be bound unless `allowConstants` is explicit. `capture begin` defaults to lightweight request capture; use `capture begin body=true` when response bodies and debugger capture are required.

## Output

```text
ok tab=123 steps=3 duration=214ms
fillform: 2 fields
click: ok
js: {"count":3}
warning js: result truncated; return less data, raise max=<bytes>, or page through it
delta v8->v9
+ ref_30 status "保存成功"
net POST /api/order 200 143ms
```

`--output json` prints one JSON document: `ok`, `tabId`, `durationMs`, `steps[]` (`command`, `status`, `detail`, `value`, `warnings`, `durationMs`), `state`, `delta`, `error`, plus `artifacts[]` paths and `notes[]`. `detail` keeps the raw tool text for existing consumers; `value` is the decoded result of `js`, `http`, `tool call`, `extract`, `tab list` and `network stop`. Parse it in PowerShell with `($r = chrome-shell ... --output json | ConvertFrom-Json).steps[0].value`. `debug` adds the parser AST and internal action logs. Any failed step sets exit code `1`.

## Automatic Learning and Correlation

```text
learn status
learn maintain
```

Successful asserted stable batches are automatically parameterized and published after repeated evidence. `learn status` shows candidates, active/quarantined/retired states and errors; `learn maintain` requests immediate maintenance. Generated tools use `kind: "semantic-sequence"` with a typed inputSchema, exact URL scope and dependency fingerprints. See [automatic-learning.md](automatic-learning.md).

Prefer `click ... && download timeout=30000`. Download correlation uses the program start and current page origin, accepts already-complete matches, and rejects ambiguous/unrelated history. Standalone `download` looks back at most one minute; `filename="prefix"` narrows candidates. Returned URLs redact query credentials and indicate `urlRedacted`.

Workspace discovery resolves JS entries and manifests by realpath. Entries outside the workspace, symlinked publish directories, and symlinked publish targets fail fast. When no endpoint/port override is set, the CLI reads the bridge's PID-validated port state from the OS temporary directory.
