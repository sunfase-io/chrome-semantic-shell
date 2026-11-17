import * as path from 'node:path';
import {
  bundledExtensionDir,
  bundledSkillDir,
  stageBundledAssets,
} from '../command/bundled-assets';
import { EXTENSION_IDS } from './constant';

// Runs as `prepack`: the extension must already be built (`pnpm build` at the repository root).
const packageRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

void stageBundledAssets({
  extensionSource: path.join(repoRoot, 'dist-extension', 'chrome-mv3'),
  skillSource: path.join(repoRoot, 'skills', 'chrome-shell'),
  packageRoot,
  version: require(path.join(packageRoot, 'package.json')).version,
  allowedIds: EXTENSION_IDS,
}).then(
  (info) => {
    console.log(
      `staged extension ${info.version} (${info.id}) -> ${bundledExtensionDir(packageRoot)}`,
    );
    console.log(`staged skill -> ${bundledSkillDir(packageRoot)}`);
  },
  (error) => {
    console.error(`stage-assets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
