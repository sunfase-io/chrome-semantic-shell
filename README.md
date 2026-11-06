# Chrome Semantic Shell

[![npm](https://img.shields.io/npm/v/chrome-semantic-shell)](https://www.npmjs.com/package/chrome-semantic-shell)
[![release](https://img.shields.io/github/v/release/sunfase-io/chrome-semantic-shell)](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest)
[![license](https://img.shields.io/github/license/sunfase-io/chrome-semantic-shell)](LICENSE)

English | [简体中文](README_zh.md)

**Let an AI agent (or you) drive the Chrome you are already using, with one command.**

Your logins, company SSO, installed extensions, and certificates keep working: no second browser, no logging in
again, no remote-debugging port. One command can fill a form, click Save, wait for the result, and check that it
really worked, and it fails loudly when something goes wrong.

```powershell
npm install -g chrome-semantic-shell

# Which tabs are open?
chrome-shell 'tab list'

# In tab 123: fill the email, click Sign in, wait for the dashboard, confirm it appeared, all in one call
chrome-shell 'fillform Email=$email && query role=button name="Sign in" | click && wait text="Dashboard" && assert text="Dashboard"' --tab 123 --var 'email=user@example.com'
```

## Contents

- [What problem it solves](#what-problem-it-solves)
- [Advantages](#advantages)
- [Comparison with similar tools](#comparison-with-similar-tools)
- [Installation](#installation)
- [Getting started: five common tasks](#getting-started-five-common-tasks)
- [Command reference](#command-reference)
- [Advanced: page tools, automatic learning, Jev](#advanced-page-tools-automatic-learning-jev)
- [Measurements](#measurements)
- [How it works and security](#how-it-works-and-security)
- [Development and releases](#development-and-releases)

## What problem it solves

When a language model operates a browser, the usual problems are:

- **Lost logins.** Automation tools usually start a clean browser, so admin consoles, intranet SSO, and sites that
  need certificates or QR-code login all need signing in again.
- **Slow and token-hungry.** Every click goes back to the model, which reads the whole page again; one form takes a
  dozen round trips.
- **Silent mistakes.** There are two "Save" buttons and the tool quietly clicks the first; the dropdown is a
  Vue/React component and the typed value never reaches it.
- **False success.** Every command says OK, but nothing was saved.

Chrome Semantic Shell is an extension in your Chrome plus a local command, `chrome-shell`. The agent writes a short
script (a small DSL), the extension runs it in your browser, and you get back a compact view of the page and a list
of what the operation changed.

## Advantages

### 1. Uses your own Chrome

- Your everyday Chrome profile: logins, cookies, extensions, client certificates, and company SSO all remain.
- **No** restarting Chrome with `--remote-debugging-port`, **no** separate profile, no approval prompt on every
  connection.
- Works on background tabs (`--tab <id>`) without interrupting what you are doing; screenshots work on background
  tabs too.

### 2. A whole task in one call

- One script can contain many steps: `&&` (continue only on success), `||` (recover on failure), `|` (pass found
  elements on), variables, `if`, and `for`.
- `defer { ... }` guarantees cleanup after success, failure, or timeout (for example, closing a temporary tab).
- Measured on the same form: 6 separate calls took 1458 ms, one combined call took 722 ms (see
  [Measurements](#measurements)).

### 3. Fewer tokens

- `inspect` is compact: interactive elements, forms, tables, or dialogs only, filtered inside the page by
  `limit=`, `role=`, and `name~=` before anything is returned.
- After each write you get only the **changes** (new messages, buttons that became enabled, requests that were
  sent), not the whole page again.
- Read-only programs skip before/after comparison automatically.

### 4. Accurate: it fails instead of guessing

- Several matches fail with a list of candidates instead of clicking the first one.
- Element references (refs) that went stale after a re-render are detected, so the wrong element is never clicked.
- `select` really opens the dropdown component, waits for the real option, and clicks it, so Element UI and Ant
  Design dropdowns work.
- `scope=pipe` limits a search to one row or dialog, for example "the View button in the ORDER-001 row".

### 5. Understands front-end frameworks

The semantic layer combines native HTML/ARIA with Vue 2, Vue 3, and React component information, recognizes
Element UI / Ant / Fusion dialogs, and merges iframes, entering the right frame automatically when acting.

### 6. Failure means failure

- Exit code 0 only when the whole script succeeded; a missing element, failed assertion, non-2xx API response, or
  timeout returns non-zero.
- `assert`, `wait text=`, and API read-back confirm that data was really saved.
- Unknown commands and misspelled options are rejected before anything runs, so a script never half-executes.

### 7. Call APIs from inside the page

- `http GET /api/orders` runs in the page context with the page's cookies and certificates; `pick=` keeps only the
  fields you need.
- `storage get ... as=$token` reads a token **without printing it** and passes it to later requests.
- `extract` pulls structured data (titles, links, prices, ...) by selector.

### 8. Gets faster with use: repeated operations become tools

- Asserted operations that succeed repeatedly are parameterized automatically into
  `.webmcp/learned/auto_*.tool.json`; next time a single `call` does the job.
- `capture` records the HTTP requests behind a UI action and turns them into a typed, callable tool (cookies,
  tokens, and passwords are never stored).
- Tools broken by a page redesign are retired automatically; tools unused for 30 days are archived.

### 9. Project page tools and WebMCP

- Put JS snippets or JSON manifests in a project's `.webmcp` folder and they become tools for `tool call`, versioned
  with the project.
- Tools that a page registers through standard WebMCP can be listed and called as well.

### 10. Local, no account, ready for agents

- No cloud service, account, or model API key; the local server listens on `127.0.0.1` only and checks an extension
  ID allowlist.
- Ships with an [agent skill](skills/chrome-shell/SKILL.md) that Claude Code, Codex, OpenCode, and similar coding
  agents can use directly.
- Optional Jev fast-decision model takes "pick one of these known actions" decisions away from the large model (see
  [Advanced](#advanced-page-tools-automatic-learning-jev)).

## Comparison with similar tools

Based on each project's official README and documentation as of November 2026, listing only documented facts. No
cross-tool speed benchmark was run.

|                                     | Chrome Semantic Shell                                                        | Playwright MCP / playwright-cli                             | Chrome DevTools MCP                                                 | agent-browser (Vercel)       | browser-use                                                                                    | Stagehand                                                             | Claude in Chrome / Gemini in Chrome                       |
| ----------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Form                                | CLI + Chrome extension                                                       | MCP server / CLI                                            | MCP server + CLI                                                    | CLI (Rust) + MCP             | Python library / CLI / MCP                                                                     | SDK (TS/Python/Go)                                                    | Built-in side panel / extension                           |
| Uses your running, logged-in Chrome | ✅ install the extension; no remote debugging, no restart                    | Needs the Playwright extension or a remote-debugging attach | Needs remote debugging (Chrome 144+ auto-connect asks for approval) | Needs remote debugging / CDP | CLI attaches over CDP (approve remote debugging); Python launcher may need Chrome closed first | Needs a CDP URL you provide                                           | ✅                                                        |
| Many steps + assertions in one call | ✅ DSL with `&&`, pipes, variables, `defer` cleanup                          | One action per call; can run Playwright code snippets       | One tool per call                                                   | Has `batch`                  | Agent mode asks the model each step                                                            | `act` calls the model each time; Playwright-style code also available | Model acts step by step                                   |
| What the model sees                 | Semantic view (HTML/ARIA + Vue/React components), only changes after actions | Accessibility snapshot                                      | Accessibility snapshot                                              | Accessibility snapshot       | Interactive element list + screenshot                                                          | Trimmed accessibility tree                                            | Screenshots + page text (Claude); not documented (Gemini) |
| Model key / cloud required          | No (Jev optional)                                                            | No                                                          | No (usage statistics on by default, can be disabled)                | Not locally                  | Agent needs a model key                                                                        | `act`/`extract`/`observe` need a model                                | Paid subscription, cloud model                            |
| Reusing operations                  | ✅ automatic learning of repeated operations + recorded HTTP tools           | Records to Playwright code                                  | Not found                                                           | Recording, session restore   | Recordings in the cloud                                                                        | Action cache only on Browserbase cloud                                | Recorded shortcuts (Claude classic side panel)            |
| WebMCP                              | ✅ page standard + project `.webmcp` folder                                  | ✅                                                          | Experimental                                                        | Experimental                 | Not found                                                                                      | ✅                                                                    | Not found (announced for Gemini)                          |
| Browsers                            | Chrome / Chromium                                                            | Chromium / Firefox / WebKit                                 | Chrome                                                              | Chrome / Chromium            | Chromium                                                                                       | Chromium                                                              | Chrome (Claude enterprise also Edge)                      |
| License                             | MIT                                                                          | Apache-2.0                                                  | Apache-2.0                                                          | Apache-2.0                   | MIT                                                                                            | MIT                                                                   | Commercial                                                |

**When to pick something else:**

- Cross-browser test automation or headless CI runs → **Playwright**.
- Performance, memory, or network debugging → **Chrome DevTools MCP**.
- "Describe it in one sentence and let the AI do it", with no scripting → **browser-use**, **Stagehand**, or
  **Claude in Chrome / Gemini in Chrome**.
- Large-scale cloud browser fleets → Browserbase, browser-use Cloud, and similar services.

**This project fits best when** a coding agent must work inside your real, logged-in Chrome on internal systems,
admin consoles, or sites behind certificates or SSO, and you want it fast, light on tokens, loud on errors, and
faster on repeated work.

Sources: [Playwright MCP](https://playwright.dev/mcp/introduction) ·
[playwright-cli](https://github.com/microsoft/playwright-cli) ·
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) ·
[agent-browser](https://github.com/vercel-labs/agent-browser) ·
[browser-use](https://github.com/browser-use/browser-use) ·
[Stagehand](https://github.com/browserbase/stagehand) ·
[Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) ·
[Gemini in Chrome](https://support.google.com/gemini/answer/16821166)

## Installation

Requires Windows, macOS, or Linux, Node.js 20+, and Google Chrome or Chromium. Python 3.10+ is needed only for Jev
and the Python test suites.

Three parts, all required: the **CLI**, the **Chrome extension**, and the **local registration** that lets Chrome
start the CLI's bridge process.

### 1. Install the CLI

```powershell
npm install -g chrome-semantic-shell
chrome-shell --version
```

In mainland China the npmmirror registry is usually faster (new versions sync within minutes):
`npm install -g chrome-semantic-shell --registry=https://registry.npmmirror.com`.

This installs `chrome-shell` (runs operations) and `chrome-shell-bridge` (registration and diagnostics). npm
registers the bridge automatically.

pnpm 10 may block global install scripts, so register once by hand:

```powershell
pnpm add -g chrome-semantic-shell
chrome-shell-bridge register
```

Without npm registry access, download both `.tgz` files from the
[release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) and install them together:
`npm install -g .\chrome-semantic-shell-shared-<version>.tgz .\chrome-semantic-shell-<version>.tgz`.

### 2. Load the Chrome extension

1. Download `chrome-semantic-shell-extension-<version>.zip` from the
   [latest release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) and extract it to a
   **permanent folder** (Chrome loads it from there on every start).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Check that the extension ID is `hnhimbinihlfejljamlgfniplabkaamk` (the bridge accepts only this ID).

The extension has no toolbar button or popup on purpose; everything happens in the terminal.

### 3. Register and verify

```powershell
chrome-shell-bridge register
```

Click **Reload** on the extension card in `chrome://extensions`, then:

```powershell
chrome-shell-bridge status   # should show: bridge: connected on 127.0.0.1:12306
chrome-shell 'tab list'      # should list your open tabs
```

### 4. Optional: install the agent skill

Download `chrome-shell-skill-<version>.zip` from the same release and extract it so that `SKILL.md` ends up at
`~/.agents/skills/chrome-shell/SKILL.md` (shared) or `~/.claude/skills/chrome-shell/SKILL.md` (Claude Code). The
same files live in [`skills/chrome-shell`](skills/chrome-shell).

### Upgrade, uninstall, troubleshooting

- **Upgrade:** `npm install -g chrome-semantic-shell@latest` → `chrome-shell-bridge register` → replace the extension
  folder with the new release → reload the extension. Keep the CLI and extension on the same major version.
- **Uninstall:** remove the extension in `chrome://extensions`, run `npm uninstall -g chrome-semantic-shell`, then
  delete `com.chromesemanticshell.nativehost.json`:
  - Windows: `%APPDATA%\Google\Chrome\NativeMessagingHosts\` and the registry key
    `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromesemanticshell.nativehost`
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/`

| Symptom                                           | Fix                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `status` says not connected                       | Run `chrome-shell-bridge register`, reload the extension, make sure Chrome is running                                                      |
| Wrong extension ID                                | You loaded a modified build; load the release folder unchanged                                                                             |
| Port 12306 in use                                 | `chrome-shell-bridge config --port <port>`, then reload the extension                                                                      |
| Garbled text or broken JSON in Windows PowerShell | Run `chrome-shell-bridge shims` once to install UTF-8 launchers, or run `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)` first |
| Command not found after pnpm install              | `pnpm setup` to put the global bin on `PATH`, then open a new terminal                                                                     |
| Permission errors on macOS / Linux                | `chrome-shell-bridge fix-permissions`                                                                                                      |

Logs: `%LOCALAPPDATA%\chrome-semantic-shell\logs` (Windows), `~/Library/Logs/chrome-semantic-shell` (macOS),
`~/.local/state/chrome-semantic-shell/logs` (Linux).

## Getting started: five common tasks

Wrap scripts in **single quotes** in PowerShell and bash so the shell does not expand `$variables`.

**1. See what can be operated on a page**

```powershell
chrome-shell 'tab list match=github'
chrome-shell 'inspect interactive limit=30' --tab 123
chrome-shell 'inspect forms' --tab 123
```

Every element gets an id such as `ref_12`; act on it later with `@ref_12`.

**2. Fill a form and confirm it saved**

```powershell
chrome-shell 'fillform Name=$name Email=$email && select role=combobox name="Type" value="Business" && query role=button name="Save" | click && wait text="Saved" && assert text="Saved"' --tab 123 --var 'name=Test' --var 'email=a@example.com'
```

**3. Click a button inside one table row**

```powershell
chrome-shell 'query role=row query="ORDER-001" | query role=button name="View" scope=pipe | click' --tab 123
```

**4. Open a temporary page, read it, close it automatically**

```powershell
chrome-shell 'tab new https://example.com active=false; defer { tab close }; extract css="h1" ; inspect text'
```

**5. Call an API with the page's login**

```powershell
chrome-shell 'http GET /api/orders?status=open pick=data.records' --tab 123
chrome-shell 'storage get session key=accessToken as=$token && http POST /api/flow/save headers={"accessToken":"$token"} body={"id":1}' --tab 123
```

Put long scripts or scripts with JSON/JS in a file: `chrome-shell --file job.chrome --fail-fast`; check syntax first
with `--dry-run`.

## Command reference

`chrome-shell help` lists every command offline; `chrome-shell help <command>` shows all options of one command. The
full grammar, options, and output format are in the [CLI reference](skills/chrome-shell/references/semantic-shell.md).

**Composition:** `;` or newline always continues; `&&` continues only after success; `||` runs only after failure;
`|` passes found elements to the next command.

**Targets:** `@ref_12`, `role=button name="Save"` (exact), `name~="Save"` (contains), `text="Save"`, `css="#save"`,
`xpath="..."`.

### Observe

| Command   | Purpose                                                                   | Example                                     |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `inspect` | View the page: `interactive`, `forms`, `tables`, `dialog`, `text`, `full` | `inspect forms query="Supplier" limit=50`   |
| `query`   | Find elements exactly; fails when nothing matches                         | `query role=button name="Save"`             |
| `diff`    | Changes since the earlier `inspect` in this script                        | `inspect interactive ; click @ref_3 ; diff` |
| `watch`   | Wait for a page change and return new actionable elements                 | `watch timeout=5000`                        |

### Act on elements

| Command    | Purpose                                               | Example                                              |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `click`    | Click                                                 | `query "OK" \| click`                                |
| `dblclick` | Double-click                                          | `dblclick text="Edit"`                               |
| `fill`     | Replace an input's value; `submit=true` presses Enter | `fill @ref_2 $value`                                 |
| `type`     | Real keystrokes (rich editors, search boxes)          | `type @ref_2 "hello" submit=true`                    |
| `fillform` | Fill several fields by label                          | `fillform Email=$email Password=$pwd`                |
| `select`   | Open a dropdown component and click the real option   | `select role=combobox name="Status" value="Enabled"` |
| `check`    | Check or uncheck                                      | `check role=checkbox name="Enabled" value=true`      |
| `key`      | Press a key or chord                                  | `key "Ctrl+S"`                                       |
| `hover`    | Hover                                                 | `hover role=button name="More"`                      |
| `drag`     | Drag and drop                                         | `drag @ref_5 @ref_8`                                 |
| `scroll`   | Scroll the page, to an element, or inside a container | `scroll down 600`, `scroll @ref_40`                  |
| `upload`   | Upload files                                          | `upload css="#file" file=$path`                      |

### Navigation, tabs, waiting, assertions

| Command    | Purpose                                                              | Example                                    |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `navigate` | Open a URL; fails on a network error page                            | `navigate https://example.com`             |
| `back`     | Go back                                                              | `back`                                     |
| `forward`  | Go forward                                                           | `forward`                                  |
| `reload`   | Reload                                                               | `reload`                                   |
| `tab`      | List / open / switch / close tabs                                    | `tab new https://example.com active=false` |
| `window`   | List windows and their tabs                                          | `window`                                   |
| `wait`     | Wait for text, an element, a URL change, navigation, or network idle | `wait text="Done" timeout=10000`           |
| `assert`   | Assert text exists / element exists / element visible                | `assert text="Saved"`                      |
| `dialog`   | Handle native alert / confirm / prompt                               | `dialog accept`                            |

### Data and APIs

| Command   | Purpose                                                       | Example                                                   |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `http`    | Request with the page's login; `pick=` keeps needed fields    | `http GET /api/items pick=data.records as=$rows`          |
| `extract` | Extract structured data by selector                           | `extract css=".row" fields={"title":"a","href":"a@href"}` |
| `storage` | Read localStorage / sessionStorage / cookies without printing | `storage get session key=token as=$token`                 |
| `js`      | Run JavaScript (last resort)                                  | `js "location.href"`                                      |

### Diagnostics and artifacts

| Command      | Purpose                                                                      | Example                                        |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `screenshot` | Screenshot of the page, an element, or a background tab; no browser download | `screenshot full=true`                         |
| `console`    | Read page console messages                                                   | `console buffer --errors`                      |
| `network`    | Capture API requests and responses                                           | `network start url=/api/ ; ... ; network stop` |
| `download`   | Wait for and confirm a download                                              | `click @ref_9 && download timeout=30000`       |

### Control flow

| Command | Purpose                                              | Example                                       |
| ------- | ---------------------------------------------------- | --------------------------------------------- |
| `set`   | Set a variable                                       | `set $ids=["1","2"]`                          |
| `if`    | Branch on the previous result or a variable          | `if failure { screenshot }`                   |
| `for`   | Loop (up to 100 iterations)                          | `for $id in $ids { query text=$id \| click }` |
| `defer` | Cleanup that runs after success, failure, or timeout | `defer { tab close }`                         |

### Tools and learning

| Command   | Purpose                                                       | Example                                                             |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `tool`    | List / call page tools (project `.webmcp` and page WebMCP)    | `tool ls`                                                           |
| `call`    | Short form of `tool call`                                     | `call lookup_order input={"id":"1001"}`                             |
| `capture` | Record the HTTP requests behind an action as a callable tool  | `capture begin ; ... ; capture end name=x ; capture publish name=x` |
| `learn`   | Show or maintain automatically learned tools (run on its own) | `learn status`                                                      |

### CLI options

| Option                                    | Purpose                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `--tab <id>` / `--window <id>`            | Target tab / window                                |
| `--var k=v`, `--vars-file`, `--vars-json` | Pass variables (`--var` wins)                      |
| `--file <path>` / `--stdin`               | Read the script from a file / standard input       |
| `--fail-fast`                             | Stop at the first failure, even across `;`         |
| `--dry-run`                               | Check syntax and options without touching the page |
| `--timeout <ms>`                          | Deadline for the whole script (max 280000)         |
| `--output compact\|json\|debug`           | Output format; `--out <file>` writes it to a file  |
| `--quiet`                                 | Omit the change report                             |
| `-C, --workspace <path>`                  | Project folder that holds `.webmcp` tools          |
| `--timing`                                | Print round-trip time                              |

`chrome-shell-bridge` subcommands: `register`, `status`, `config` (port and default timeout), `shims` (UTF-8
launchers), `fix-permissions`.

## Advanced: page tools, automatic learning, Jev

**Project page tools:** put JS snippets (starting with `// tool: name`) or JSON manifests in a project's `.webmcp`
folder and call them with `tool call`; mark read-only tools with `// readonly: true`. Point to the project with
`-C <folder>`.

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project 'tool call lookup_order input={"id":"1001"}'
```

**Automatic learning** (on by default): asserted operations that succeed repeatedly become
`.webmcp/learned/auto_*.tool.json` with typed inputs, URL scope, and dependency fingerprints. By default at most 32
tools are active, tools unused for 30 days are archived, and only generated files that nobody edited are ever
deleted. Configure it in the skill's `config.json` or the project's `.chrome-shell/config.json`:

```json
{ "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 } }
```

See [operation memory](skills/chrome-shell/references/automatic-learning.md) and the
[design notes](docs/automatic-operation-memory.md).

**Jev fast decisions** (optional): Jev is TypeSafe's typed decision model. For small decisions such as "which of
these known actions comes next", the local runner sends a compact page summary to Jev, executes the chosen action,
and asserts the result, without a large-model turn for every step; when unsure it hands control back instead of
guessing. Bring your own API key; see the [Jev fast loop](skills/chrome-shell/references/jev-fast-loop.md).

```powershell
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --dry-run
```

## Measurements

2026-09-21, same localhost form on one machine, three runs per path in alternating order, with server-side read-back
to confirm the data was saved:

| Execution path                      | Browser requests |       Median |
| ----------------------------------- | ---------------: | -----------: |
| 6 separate CLI calls                |                6 |    1457.9 ms |
| 1 combined CLI call                 |                1 |     722.2 ms |
| 1 persistent-HTTP batch             |                1 | **635.0 ms** |
| Two Jev decisions + persistent HTTP |                3 |    2420.7 ms |

Combining the steps into one call cut the time by about **56%**. This compares execution paths within this project,
not other tools, and is not a guarantee for every site.

Tests: offline/component suites and 37 live Chrome regressions covering targeting, forms, iframes, navigation,
waits, downloads, capture, Jev, automatic learning, and failure handling. See the
[test guide](tests/browser-automation/README.md), [raw benchmark data](docs/browser-performance-keepalive-2026-09-21.json),
and [regression results](docs/browser-regression-final-2026-09-21.json).

## How it works and security

```text
Agent / terminal
  → chrome-shell (CLI)
  → HTTP on 127.0.0.1
  → Native Messaging (Chrome's official channel to local programs)
  → the extension in your Chrome, running inside the page
```

- The local server listens on `127.0.0.1` only, and the CLI accepts only loopback endpoints.
- The native host accepts only allowlisted extension IDs.
- Recorded operations never store Authorization headers, cookies, tokens, secrets, or passwords.
- Project tool folders are checked by real path; symlink escapes are rejected.
- CI audits production dependencies on every run.

More: [Semantic Shell overview](docs/SEMANTIC_SHELL.md) ·
[papers and open-source research](docs/browser-automation-research-2026-09-21.md)

## Development and releases

Build from source:

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

Then load `dist-extension/chrome-mv3` with **Load unpacked**. The built-in manifest key keeps the extension ID equal
to the release build.

Checks:

```powershell
pnpm typecheck
pnpm lint
pnpm --filter chrome-semantic-shell-extension test
pnpm --filter chrome-semantic-shell test
python -m unittest discover -s skills/chrome-shell/evals -p "test_*.py" -v
python -m unittest discover -s tests/browser-automation -p "test_*.py" -v
```

When adding or changing a command, update `chrome-shell help`, the command reference in both READMEs, and the
[CLI reference](skills/chrome-shell/references/semantic-shell.md); a test checks that all three cover every command,
so CI fails when one is missed.

**Releases are automatic:** set the same new `version` in `app/native-server`, `packages/shared`, and
`app/chrome-extension` `package.json`, then push to `master`. After CI passes it:

1. tags `v<version>` and creates a GitHub Release with the extension zip, the skill zip, and both npm tarballs;
2. publishes to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (no stored token,
   automatic provenance).

Pushes that do not change the version only run checks; versions already on npm are skipped.

## License

[MIT](LICENSE). Evolved from [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome).
