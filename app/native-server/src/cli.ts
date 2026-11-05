#!/usr/bin/env node

import { program } from 'commander';
import {
  tryRegisterUserLevelHost,
  colorText,
  registerWithElevatedPermissions,
  ensureExecutionPermissions,
  writeNodePathFile,
} from './scripts/utils';
import { BrowserType, parseBrowserType, detectInstalledBrowsers } from './scripts/browser-config';
import { readCommandPortState } from './command/port-state';
import { readShellConfig, shellConfigPath, writeShellConfig } from './config';
import { findShimDirectories, inspectShims, installShims } from './command/shims';
import * as path from 'node:path';

program
  .version(require('../package.json').version)
  .description('Install and manage the Chrome Semantic Shell native bridge');

// Register Native Messaging host
program
  .command('register')
  .description('Register Native Messaging host')
  .option('-s, --system', 'Use system-level installation (requires administrator/sudo privileges)')
  .option('-b, --browser <browser>', 'Register for specific browser (chrome, chromium, or all)')
  .option('-d, --detect', 'Auto-detect installed browsers')
  .action(async (options) => {
    try {
      // Write Node.js path for run_host scripts
      writeNodePathFile(__dirname);

      // Determine which browsers to register
      let targetBrowsers: BrowserType[] | undefined;

      if (options.browser) {
        if (options.browser.toLowerCase() === 'all') {
          targetBrowsers = [BrowserType.CHROME, BrowserType.CHROMIUM];
          console.log(colorText('Registering for all supported browsers...', 'blue'));
        } else {
          const browserType = parseBrowserType(options.browser);
          if (!browserType) {
            console.error(
              colorText(
                `Invalid browser: ${options.browser}. Use 'chrome', 'chromium', or 'all'`,
                'red',
              ),
            );
            process.exit(1);
          }
          targetBrowsers = [browserType];
        }
      } else if (options.detect) {
        targetBrowsers = detectInstalledBrowsers();
        if (targetBrowsers.length === 0) {
          console.log(
            colorText(
              'No supported browsers detected, will register for Chrome and Chromium',
              'yellow',
            ),
          );
          targetBrowsers = undefined; // Will use default behavior
        }
      }
      // If neither option specified, tryRegisterUserLevelHost will detect browsers

      if (options.system) {
        await registerWithElevatedPermissions();
        console.log(
          colorText('System-level Native Messaging host registered successfully!', 'green'),
        );
        console.log(
          colorText(
            'Reload the extension once, then verify the connection with chrome-shell-bridge status.',
            'blue',
          ),
        );
      } else {
        // Regular user-level installation
        console.log(colorText('Registering user-level Native Messaging host...', 'blue'));
        const success = await tryRegisterUserLevelHost(targetBrowsers);

        if (success) {
          console.log(colorText('Native Messaging host registered successfully!', 'green'));
          console.log(
            colorText(
              'Reload the extension once, then verify the connection with chrome-shell-bridge status.',
              'blue',
            ),
          );
        } else {
          console.log(
            colorText(
              'User-level registration failed, please try the following methods:',
              'yellow',
            ),
          );
          console.log(colorText('  1. sudo chrome-shell-bridge register', 'yellow'));
          console.log(colorText('  2. chrome-shell-bridge register --system', 'yellow'));
          process.exit(1);
        }
      }
    } catch (error: any) {
      console.error(colorText(`Registration failed: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

// Fix execution permissions
program
  .command('fix-permissions')
  .description('Fix execution permissions for native host files')
  .action(async () => {
    try {
      console.log(colorText('Fixing execution permissions...', 'blue'));
      await ensureExecutionPermissions();
      console.log(colorText('✓ Execution permissions fixed successfully!', 'green'));
    } catch (error: any) {
      console.error(colorText(`Failed to fix permissions: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Show or update persistent shell settings')
  .option('--port <port>', 'Loopback server port (1-65535)')
  .option('--timeout <ms>', 'Default command deadline (1-280000 ms)')
  .option('--json', 'Print JSON')
  .action(async (options) => {
    const port = options.port === undefined ? undefined : Number(options.port);
    const commandTimeoutMs = options.timeout === undefined ? undefined : Number(options.timeout);
    const config =
      port === undefined && commandTimeoutMs === undefined
        ? await readShellConfig()
        : await writeShellConfig({ port, commandTimeoutMs });
    if (options.json) {
      console.log(JSON.stringify({ path: shellConfigPath(), ...config }, null, 2));
      return;
    }
    console.log(`config: ${shellConfigPath()}`);
    console.log(`port: ${config.port}`);
    console.log(`timeout: ${config.commandTimeoutMs}ms`);
    if (port !== undefined) console.log('Reload the extension once to apply the new port.');
  });

program
  .command('status')
  .description('Show configured and active bridge state')
  .option('--json', 'Print JSON')
  .action(async (options) => {
    const config = await readShellConfig();
    const runningPort = await readCommandPortState();
    const port = runningPort || config.port;
    let reachable = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: AbortSignal.timeout(1_000),
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    }
    const status = {
      configPath: shellConfigPath(),
      configuredPort: config.port,
      defaultTimeoutMs: config.commandTimeoutMs,
      runningPort: runningPort || null,
      bridgeReachable: reachable,
      extensionConnected: reachable,
    };
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`config: ${status.configPath}`);
      console.log(`configured port: ${status.configuredPort}`);
      console.log(
        `active port: ${port} (${runningPort ? 'from the running bridge state file' : 'configured; the running bridge wrote no port state file'})`,
      );
      console.log(`default timeout: ${status.defaultTimeoutMs}ms`);
      console.log(
        `bridge: ${status.bridgeReachable ? `connected on 127.0.0.1:${port}` : `not reachable on 127.0.0.1:${port} (open Chrome with the extension enabled)`}`,
      );
      const shims = await inspectShims(await findShimDirectories());
      const unmanaged = shims.filter((shim) => !shim.managed);
      console.log(`cli entry: ${path.join(__dirname, 'semantic-cli.js')}`);
      console.log(
        `launchers: ${shims.length ? (unmanaged.length ? `${unmanaged.length} unmanaged (non-ASCII output may be garbled; run chrome-shell-bridge shims)` : 'managed UTF-8 shims') : 'none on PATH'}`,
      );
    }
    if (!reachable) process.exitCode = 1;
  });

program
  .command('shims')
  .description('Install UTF-8 safe chrome-shell launchers in the PATH directories that hold one')
  .option('--dir <dir...>', 'Target directories instead of the PATH lookup')
  .action(async (options) => {
    const dirs: string[] = options.dir?.length ? options.dir.map((dir: string) => path.resolve(dir)) : await findShimDirectories();
    if (!dirs.length) throw new Error('no chrome-shell launcher on PATH; pass --dir <directory>');
    const written = await installShims(path.join(__dirname, 'semantic-cli.js'), dirs);
    for (const file of written) console.log(`wrote ${file}`);
  });

async function main(): Promise<void> {
  if (!process.argv.slice(2).length) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
