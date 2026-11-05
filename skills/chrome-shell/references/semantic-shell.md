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

| Option                          | Meaning                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `--tab <id>` / `--window <id>`  | Explicit Chrome target                                            |
| `--timeout <ms>`                | Whole-program deadline, 1–280000                                  |
| `--output compact\|json\|debug` | Result detail (not a file path; use `--out`)                      |
| `--out <file>`                  | Write the result as UTF-8 to a file, print a one-line summary     |
| `--quiet`                       | Omit the change/delta report                                      |
| `--fail-fast`                   | Stop at the first failed statement even across `;`/newlines       |
| `--dry-run`                     | Parse and validate options without page effects                   |
| `--var key=value`               | Repeatable typed variable; JSON literals are decoded              |
| `--vars-json` / `--vars-file`   | Merge a JSON object; `--var` wins                                 |
| `-C, --workspace <path>`        | Root for `.webmcp` discovery and publish                          |
| `--no-project-tools`            | Disable workspace page tools                                      |
| `--artifact-dir <path>`         | Stable parent; each run gets a unique child directory             |
| `--result-json`                 | Print the full local result envelope                              |
| `--timing`                      | Print HTTP round-trip time to stderr                              |
| `--expected-url <url>`          | Refuse effects if the target URL changed                          |
| `--print-entry`                 | Print the CLI entry script path (for `node <entry>` from scripts) |

The script limit is 64 KiB (`js file=` contents travel as variables and do not count). The endpoint is restricted to loopback HTTP. `chrome-shell-bridge status` shows ports, bridge state and whether the launchers are the UTF-8 managed ones; `chrome-shell-bridge shims` installs them; `chrome-shell-bridge config` manages persistent settings.

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
- `query` fails with the filters it used when nothing matches; `inspect` only observes.
- `inspect dialog` uses the dialog whose text contains `query=`, else the topmost visible one (ARIA dialogs, `<dialog open>`, Element UI/Ant/Fusion dialogs and message boxes).
- `inspect text` lists text blocks once (no ancestor repeats, no script/style payloads) with up to 1000 characters each.
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

- `select` opens the component, waits up to `timeout=` (default 5000) for a matching real option (popup options win over same-named menu items) and clicks it; native selects are set directly, also through a ref from an earlier invocation.
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
tab new https://example.com active=false timeout=20000
tab switch 123
tab close 123
wait 500
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
- `wait text` also matches the document title. `wait selector` accepts any visible match; `state=attached|detached` ignores visibility.
- `tab new` focuses the new tab unless `active=false`; a page that keeps loading returns its id with a warning instead of failing. Tabs the page opens appear as `+tab <id> <url>` in the delta.
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
- `js`: one expression returns its value; statements need `return`; the code runs async (top-level `await` works); `VARS` exposes program variables; `frame=<id>` runs in that frame's page context; results print as `js: <value>` and are cut at `max=` bytes (default 50 KB) with a warning. When the debugger cannot attach, JS runs through `chrome.userScripts` (enable "Allow User Scripts" for the extension) or the page main world (subject to page CSP).

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

`--output json` prints one JSON document: `ok`, `tabId`, `durationMs`, `steps[]` (`command`, `status`, `detail`, `value`, `durationMs`), `state`, `delta`, `error`, plus `artifacts[]` paths and `notes[]`. `detail` keeps the raw tool text for existing consumers; `value` is the decoded result of `js`, `http`, `tool call`, `extract`, `tab list` and `network stop`. Parse it in PowerShell with `($r = chrome-shell ... --output json | ConvertFrom-Json).steps[0].value`. `debug` adds the parser AST and internal action logs. Any failed step sets exit code `1`.

## Automatic Learning and Correlation

Successful asserted stable batches are automatically parameterized and published after repeated evidence. `learn status` shows candidates, active/quarantined/retired states and errors; `learn maintain` requests immediate maintenance. Generated tools use `kind: "semantic-sequence"` with a typed inputSchema, exact URL scope and dependency fingerprints. See [automatic-learning.md](automatic-learning.md).

Prefer `click ... && download timeout=30000`. Download correlation uses the program start and current page origin, accepts already-complete matches, and rejects ambiguous/unrelated history. Standalone `download` looks back at most one minute; `filename="prefix"` narrows candidates. Returned URLs redact query credentials and indicate `urlRedacted`.

Workspace discovery resolves JS entries and manifests by realpath. Entries outside the workspace, symlinked publish directories, and symlinked publish targets fail fast. When no endpoint/port override is set, the CLI reads the bridge's PID-validated port state from the OS temporary directory.
