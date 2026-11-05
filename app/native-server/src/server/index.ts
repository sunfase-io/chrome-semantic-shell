import Fastify, { type FastifyInstance } from 'fastify';
import { clearCommandPortState, writeCommandPortState } from '../command/port-state';
import { HTTP_STATUS, NATIVE_SERVER_PORT, SERVER_CONFIG } from '../constant';
import type { NativeMessagingHost } from '../native-messaging-host';
import { registerSemanticCommandRoutes } from './routes';

/** Loopback-only server for the Chrome Semantic Shell command path. */
export class Server {
  private readonly fastify: FastifyInstance;
  private nativeHost: NativeMessagingHost | null = null;
  public isRunning = false;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.fastify.get('/ping', async (_request, reply) => {
      return reply.status(HTTP_STATUS.OK).send({ status: 'ok', message: 'pong' });
    });
    registerSemanticCommandRoutes(this.fastify, {
      getBridge: () => this.nativeHost,
      isReady: () => this.isRunning,
    });
  }

  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    this.nativeHost = nativeHost;
    if (this.isRunning) return;

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });
      process.env.CHROME_SHELL_PORT = String(port);
      await writeCommandPortState(port);
      this.isRunning = true;
    } catch (error) {
      this.isRunning = false;
      await this.fastify.close().catch(() => {});
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.fastify.close();
      await clearCommandPortState();
    } finally {
      this.isRunning = false;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

export default new Server();
