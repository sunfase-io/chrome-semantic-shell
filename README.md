# Chrome Semantic Shell

[![npm](https://img.shields.io/npm/v/chrome-semantic-shell)](https://www.npmjs.com/package/chrome-semantic-shell)
[![release](https://img.shields.io/github/v/release/sunfase-io/chrome-semantic-shell)](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest)
[![license](https://img.shields.io/github/license/sunfase-io/chrome-semantic-shell)](LICENSE)

English | [简体中文](README_zh.md)

Chrome Semantic Shell is a local, CLI-first browser automation runtime for an existing Chrome
profile. It operates the browser you already use, so login sessions, extensions, certificates,
and user settings remain available.

The product has no popup, side panel, built-in chat agent, local model, vector database, or visual
workflow editor. Agents and terminal users interact through one executable: `chrome-shell`.

## Architecture

```text
Agent / terminal
  → chrome-shell
  → loopback POST /chrome/shell
  → Native Messaging
  → headless Chrome extension runtime
```

- The HTTP server listens only on loopback.
- Each CLI invocation is one request; the HTTP connection closes after success, failure, or timeout.
- The Jev flow runner reuses local HTTP and Jev HTTPS connections across decisions in one process.
- The extension and Native host keep one persistent Native Messaging channel.
- Semantic state combines native HTML/ARIA with Vue 2, Vue 3, React, frames, and WebMCP adapters.
- Operation memory learns verified sequences and maintains reusable tools in the Native host background queue.

## Highlights

- Compact `inspect` and exact `query` views with stable refs
- Batched click, fill, select, keyboard, scroll, drag, upload, navigation, and tab operations
- `wait`, `assert`, `diff`, `watch`, network, console, screenshot, and download verification
- Variables, conditions, loops, pipelines, and LIFO `defer` cleanup
- Exact custom-component option selection without fuzzy guessing
- Relationship queries with `scope=pipe`
- Workspace `.webmcp` tools and standard page WebMCP tools
- Captured HTTP operations with typed input bindings and credential sanitization
- Fail-fast errors for ambiguity, stale refs, invalid input, unsafe paths, and deadlines
- Automatic learning of asserted operations, with parameterized `.webmcp` tools, versioning, and retirement
- Optional Jev decisions with bounded candidates, persistent connections, fused deterministic steps, and result assertions
- Session-driven coverage, offline regressions, live browser fixtures, and comparative benchmarks

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer (`node -v`)
- Google Chrome or Chromium (Manifest V3 and Native Messaging)
- Optional: Python 3.10+ for the Jev runner and the Python test suites

## Installation

Installation has three parts that must all be present: the **CLI** (npm), the **extension** (loaded into
Chrome), and the **Native Messaging registration** that lets Chrome start the CLI's bridge. The agent skill is
optional.

### 1. Install the CLI

The CLI is published on npm as [`chrome-semantic-shell`](https://www.npmjs.com/package/chrome-semantic-shell)
(its runtime dependency `chrome-semantic-shell-shared` is installed automatically):

```powershell
npm install -g chrome-semantic-shell
chrome-shell --version
```

This installs two commands: `chrome-shell` (runs DSL programs) and `chrome-shell-bridge` (registration and
diagnostics). npm runs a postinstall step that registers the Native Messaging host for the current user.
Use the same major version for the CLI and the extension.

In mainland China, the npmmirror registry is usually faster (new versions sync within minutes):
`npm install -g chrome-semantic-shell --registry=https://registry.npmmirror.com`.

pnpm 10 may block global lifecycle scripts, so register explicitly:

```powershell
pnpm add -g chrome-semantic-shell
chrome-shell-bridge register
```

Running `chrome-shell-bridge register` again is always safe; use it whenever you are unsure.

Without access to the npm registry, download `chrome-semantic-shell-shared-<version>.tgz` and
`chrome-semantic-shell-<version>.tgz` from the release and install both files in one command:
`npm install -g .\chrome-semantic-shell-shared-<version>.tgz .\chrome-semantic-shell-<version>.tgz`.

### 2. Load the extension

1. Download `chrome-semantic-shell-extension-<version>.zip` from the
   [latest release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) and extract it to a
   permanent folder (Chrome loads it from there on every start; do not delete it).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the extracted folder (the one that contains `manifest.json`).
4. Confirm the extension ID is `hnhimbinihlfejljamlgfniplabkaamk`. The Native host only accepts this ID.

The extension has no toolbar button or popup by design; everything is managed from the terminal.

### 3. Register and connect

```powershell
chrome-shell-bridge register
```

Then click the reload button on the extension card in `chrome://extensions` once, so it connects to the
newly registered host. Verify:

```powershell
chrome-shell-bridge status
chrome-shell 'tab list'
```

`status` should report `bridge: connected on 127.0.0.1:12306`, and `tab list` should print your open tabs.

### 4. Optional: install the agent skill

To let coding agents (Claude Code, Codex, OpenCode, ...) use the CLI, download
`chrome-shell-skill-<version>.zip` from the same release and extract it so that `SKILL.md` ends up at:

- `~/.agents/skills/chrome-shell/SKILL.md` (shared agent skills directory), or
- `~/.claude/skills/chrome-shell/SKILL.md` (Claude Code)

The same files are in [`skills/chrome-shell`](skills/chrome-shell) of this repository.

### Upgrade and uninstall

- **Upgrade:** `npm install -g chrome-semantic-shell@latest`, run `chrome-shell-bridge register`, replace the
  extension folder with the new release, and reload the extension.
- **Uninstall:** remove the extension in `chrome://extensions`, run `npm uninstall -g chrome-semantic-shell`,
  then delete the host manifest `com.chromesemanticshell.nativehost.json`:
  - Windows: `%APPDATA%\Google\Chrome\NativeMessagingHosts\` and the registry key
    `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromesemanticshell.nativehost`
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/`

### Troubleshooting

| Symptom                                                      | Fix                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` shows the bridge is not connected                   | Run `chrome-shell-bridge register`, reload the extension, and make sure Chrome is running.                                                    |
| Extension ID differs from `hnhimbinihlfejljamlgfniplabkaamk` | You loaded a different build; load the release folder unchanged, or allow your ID in the host manifest.                                       |
| Port 12306 is in use                                         | `chrome-shell-bridge config --port <port>`, then reload the extension.                                                                        |
| Garbled Chinese or broken JSON in Windows PowerShell         | Run `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)` first, or install the UTF-8 launchers once with `chrome-shell-bridge shims`. |
| `chrome-shell` not found after pnpm install                  | Run `pnpm setup` so the pnpm global bin directory is on `PATH`, then open a new terminal.                                                     |
| Permission errors on macOS/Linux                             | `chrome-shell-bridge fix-permissions`                                                                                                         |

Logs: `%LOCALAPPDATA%\chrome-semantic-shell\logs` (Windows), `~/Library/Logs/chrome-semantic-shell` (macOS),
`~/.local/state/chrome-semantic-shell/logs` (Linux).

## Build from source

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

Load `dist-extension/chrome-mv3` with **Load unpacked**, reload it, and verify with `chrome-shell-bridge status`.
The built-in manifest key keeps the extension ID identical to the release build.

## Basic usage

Use single quotes around DSL programs in PowerShell and POSIX shells so `$variables` are not
expanded by the shell.

```powershell
chrome-shell 'tab list'
chrome-shell 'inspect interactive limit=30'
chrome-shell 'fillform Email=$email && query role=button name="Sign in" | click && wait text="Dashboard" timeout=10000 && assert text="Dashboard"' --tab 123 --var 'email=user@example.com'
```

Exact component selection:

```powershell
chrome-shell 'select role=combobox name="System" value="Trading" && inspect forms query="System"' --tab 123
```

Query one table row and act only inside that row:

```powershell
chrome-shell 'query role=row query="ORDER-001" | query role=button name="View" scope=pipe | click'
```

Guaranteed cleanup after success, failure, or timeout:

```powershell
chrome-shell 'tab new https://example.com; defer { tab close }; inspect interactive; assert text="Example Domain"'
```

Target a background tab without changing the default active-tab selection:

```powershell
chrome-shell 'inspect forms' --tab 123
```

Read the complete command reference in
[`skills/chrome-shell/references/semantic-shell.md`](skills/chrome-shell/references/semantic-shell.md).

Use `&&` between dependent steps: a failure stops subsequent writes. `;` always continues and is not a fail-fast separator.
Keep mutations on one tab serial and observe again at an unknown dialog or page state. Use `--file` and `--vars-file`
for long JSON/JS, and validate syntax with `--dry-run`. Successful writes are not rolled back by a later failure.

## Headless configuration

```powershell
chrome-shell-bridge status
chrome-shell-bridge config
chrome-shell-bridge config --port 12307
chrome-shell-bridge config --timeout 45000
```

Port changes take effect after reloading the extension. Override one invocation with `--timeout`,
`--endpoint`, or `CHROME_SHELL_PORT`.

The persistent configuration file is stored at:

```text
Windows: %LOCALAPPDATA%\chrome-semantic-shell\config.json
macOS:   ~/Library/Application Support/chrome-semantic-shell/config.json
Linux:   $XDG_CONFIG_HOME/chrome-semantic-shell/config.json
```

## Workspace page tools

Use `-C` to discover `.webmcp` snippets and captured operations from a workspace:

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project 'tool call lookup_order input={"id":"1001"}'
```

Declare guaranteed read-only snippets with `// readonly: true`, or manifests with
`"readOnly": true`. Programs containing only read-only tools skip page-change observation.

## Automatic operation memory

Learning is enabled by default. Normal `chrome-shell` use accumulates evidence without a separate request to generate scripts:

```text
Successful batch with a final assertion
  → stable sequence and parameterized inputs
  → repeated successful evidence
  → .webmcp/learned/auto_*.tool.json
  → usage feedback, dependency checks, new revisions or retirement
```

Templates with inputs need two successful observations with different input samples by default; static operations need repeated success.
Generated `semantic-sequence` tools include an input schema, exact URL scope, and dependency fingerprints. Discover them at task start,
then invoke a suitable tool using its actual name and schema:

```powershell
chrome-shell -C D:\project 'tool ls'
chrome-shell -C D:\project --tab 123 'call auto_<actual_name> input={"arg1":"actual value"}'
chrome-shell -C D:\project 'learn status'
```

The lifecycle is `candidate → active → quarantined/retired`; manual-edit conflicts become `conflict`.

- Structural failures or changed dependencies remove obsolete generated tools from the active catalog; fresh successful evidence can create a new revision.
- Defaults: **32** active tools and retirement after **30 days without reuse**. Only registered generated files with matching fingerprints are deleted.
- The index and archives live in `.chrome-shell/learning/`; input sample values are not stored.
- Learning and disk maintenance run in the background. Revisiting an indexed workspace after restart resumes maintenance.

Global settings live in the installed skill's `chrome-shell/config.json`. Override learning per workspace with `.chrome-shell/config.json`:

```json
{ "learning": { "enabled": true, "minSuccesses": 2, "maxActive": 32, "idleDays": 30 } }
```

The first version deliberately keeps exact URL scopes and excludes arbitrary JS, stale refs, credentials, and unreliable assertions.
`learn maintain` requests immediate maintenance; ordinary learning does not depend on it.
See [operation memory](skills/chrome-shell/references/automatic-learning.md) and the [design](docs/automatic-operation-memory.md).

## Jev: fast decisions and configuration

Jev is TypeSafe's typed decision model. This integration asks it to choose among host-defined actions from a current semantic observation.
Local code remains responsible for executing the selected program, checking preconditions, and asserting the result.

- **Known operations:** run DSL, APIs, or existing tools directly; fuse consecutive deterministic nodes.
- **Semantic branches:** let Jev choose an action and execute locally, without a host-model turn between every step.
- **Unknown workflows, missing evidence, or low confidence:** return control to the host rather than guessing or silently switching models.

### 1. Install the client and configure the API

The runner reuses configuration loading, request validation, and decision interpretation from the existing
[Jev skill](https://github.com/wuyoscar/jev-skill). Its default client path is `~/.agents/skills/jev/scripts/jev.py`.

Create `~/.agents/jev/config.json` outside the repository, using your own API key:

```json
{
  "api_url": "https://api.typesafe.ai/v1/systemone",
  "api_key": "<YOUR_JEV_API_KEY>",
  "model": "jev-latest"
}
```

Use an endpoint compatible with `POST /v1/systemone`; the configured URL is authoritative.
Keep the real key local, out of plans, documentation, and commits.

### 2. Configure the switch, transport, and budgets

Edit [`skills/chrome-shell/config.json`](skills/chrome-shell/config.json), or the corresponding file in the installed skill:

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

Set `jev.enabled=false` to disable model decisions while retaining the regular CLI and operation memory.
`keepalive=true` uses a direct persistent HTTPS connection. If a system proxy is required, explicitly set it to `false`
to use the existing client's urllib transport. Probability thresholds are heuristics, not accuracy guarantees.

### 3. Check and run

```powershell
python "$HOME/.agents/skills/jev/scripts/jev.py" config-check
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --dry-run
python skills/chrome-shell/scripts/jev_flow.py plan.json --tab 123 --workspace D:\project --vars-file private-values.json
```

The host defines `goal`, `acceptance`, `allowed_origins`, and nodes from an actual page; every action has a
`guard/program/verify` contract. The runner requires extension protocol **3** and sends only necessary semantic evidence.
Control values, program inputs, and URL credentials/query/fragment are excluded from automatically constructed model evidence.
Titles, candidate names, and custom context still need an appropriate scope.

Exit codes: `0` verified, `2` host review needed, `1` configuration or execution error. `--dry-run` validates grammar without
browser actions or Jev calls. See the [flow guide](skills/chrome-shell/references/jev-fast-loop.md) for the plan example and full contract.

## Measurements and session-driven regressions

On 2026-09-21, the same localhost form fixture was tested three times per path, with alternating order and independent server-side read-back:

| Execution path                                 | Browser requests |       Median |
| ---------------------------------------------- | ---------------: | -----------: |
| Separate CLI steps                             |                6 |     1457.9ms |
| One CLI batch                                  |                1 |      722.2ms |
| One persistent HTTP batch                      |                1 |  **635.0ms** |
| Two Jev decisions with persistent browser HTTP |                3 | **2420.7ms** |

The form path took **56.4% less time**, or about **2.30× faster**. Browser work in the two-decision Jev flow took about 0.43s;
most remaining time was in API calls. This compares execution paths, not host models, and is not a cross-site or p95/p99 guarantee.

Receipts include **162 offline/component tests** and **37 live Chrome synthetic cases** across targeting, forms, frames, navigation,
waits, downloads, capture, Jev, operation memory, and failure handling. `tests/browser-automation/coverage.json` maps features to session
evidence and tests. `docs/analysis/session_inventory.py` detects new sessions, appended content, and edits to existing messages.

- [Test entrypoints and prerequisites](tests/browser-automation/README.md)
- [Raw benchmark data](docs/browser-performance-keepalive-2026-09-21.json)
- [Live regression results](docs/browser-regression-final-2026-09-21.json)

## Development

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

Build output:

- Extension: `dist-extension/chrome-mv3`
- Native CLI: `app/native-server/dist`

## Releases

Push a tag matching the Native package version:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions verifies the repository and offline regressions, packages the extension, agent skill, shared runtime,
and Native CLI, creates a GitHub Release, and publishes `chrome-semantic-shell-shared` and then `chrome-semantic-shell`
to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC, no stored token,
automatic provenance). Versions already on npm are skipped.

Release checklist for maintainers:

1. Bump `version` in `app/native-server/package.json` and `packages/shared/package.json` together; the tag
   must equal `v<version>`.
2. Both npm packages trust `sunfase-io` / `chrome-semantic-shell` / `build-release.yml`
   (npmjs.com → package → **Settings → Trusted publishing**). Without that trust the npm step fails.
3. If npm puts a version into staged publishing, approve it with 2FA under **Staged Packages** on npmjs.com;
   it is not installable until approved.
4. Check `npm view chrome-semantic-shell version` and the release assets after the workflow finishes.

## Security model

- The command endpoint accepts only loopback HTTP URLs.
- Workspace discovery and publishing reject realpath and symlink escapes.
- Captured operations do not persist authorization, cookies, tokens, secrets, or passwords.
- The Native host accepts only the allowlisted extension IDs.
- Production dependency audits run in CI.

## Documentation

- [Semantic Shell overview](docs/SEMANTIC_SHELL.md)
- [Agent skill](skills/chrome-shell/SKILL.md)
- [Complete CLI reference](skills/chrome-shell/references/semantic-shell.md)
- [Jev configuration and flow contract](skills/chrome-shell/references/jev-fast-loop.md)
- [Automatic operation memory](skills/chrome-shell/references/automatic-learning.md)
- [Papers, open-source projects, and session research](docs/browser-automation-research-2026-09-21.md)
- [Session-driven tests](tests/browser-automation/README.md)

## License

[MIT](LICENSE)
