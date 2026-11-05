#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance);
  nativeMessagingHostInstance.setServer(serverInstance);
  nativeMessagingHostInstance.start();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(code: number, reason?: unknown): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason !== undefined) {
    process.stderr.write(
      `${reason instanceof Error ? reason.stack || reason.message : String(reason)}\n`,
    );
  }
  await serverInstance.stop().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('uncaughtException', (error) => void shutdown(1, error));
process.on('unhandledRejection', (reason) => void shutdown(1, reason));
