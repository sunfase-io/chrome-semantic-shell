# chrome-semantic-shell

CLI-first browser automation for the Chrome profile you already use: login sessions, extensions, and
certificates stay available. Agents and terminal users drive the browser through one command, `chrome-shell`,
with a compact semantic DSL.

This package provides the CLI (`chrome-shell`) and the Native Messaging bridge (`chrome-shell-bridge`). It
works together with the Chrome Semantic Shell extension.

## Install

Requires Node.js 20+ and Google Chrome or Chromium.

1. Install the CLI:

   ```sh
   npm install -g chrome-semantic-shell --registry=https://registry.npmmirror.com   # mainland China
   npm install -g chrome-semantic-shell                                              # elsewhere
   ```

   With pnpm 10, also run `chrome-shell-bridge register`, because global lifecycle scripts may be blocked.

2. Copy the bundled extension to a fixed folder, then open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked** and pick the printed folder. The extension ID must be
   `hnhimbinihlfejljamlgfniplabkaamk`. After an upgrade, run the command again and click **Reload**.

   ```sh
   chrome-shell-bridge install-extension   # ~/.chrome-semantic-shell/extension by default, --dir to change
   ```

   Alternative: extract `chrome-semantic-shell-extension-<version>.zip` from the
   [latest release](https://github.com/sunfase-io/chrome-semantic-shell/releases/latest) and load that folder.

3. Register the host, reload the extension once, and verify:

   ```sh
   chrome-shell-bridge register
   chrome-shell-bridge status
   chrome-shell 'tab list'
   ```

## Usage

```sh
chrome-shell 'inspect interactive limit=30' --tab 123
chrome-shell 'fillform Email=$email && query role=button name="Sign in" | click && wait text="Dashboard"' --tab 123 --var 'email=user@example.com'
```

The agent skill ships in the package: `chrome-shell-bridge skill-path` prints its folder (holds `SKILL.md`); copy
it to `~/.agents/skills/chrome-shell` or `~/.claude/skills/chrome-shell`.

Documentation, troubleshooting, and the full CLI reference:
<https://github.com/sunfase-io/chrome-semantic-shell>

## License

MIT
