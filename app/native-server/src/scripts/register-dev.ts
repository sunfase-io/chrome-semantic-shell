import { registerUserLevelHostWithNodePath } from './utils';

void registerUserLevelHostWithNodePath().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
