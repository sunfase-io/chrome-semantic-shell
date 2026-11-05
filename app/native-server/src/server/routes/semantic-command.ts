import type { FastifyInstance } from 'fastify';
import { ERROR_MESSAGES, HTTP_STATUS } from '../../constant';
import {
  executeSemanticCommand,
  SEMANTIC_EXEC_ROUTE,
  SemanticExecInputError,
  type ExtensionCommandBridge,
  type SemanticExecRequest,
} from '../../command/semantic-exec';

export interface SemanticCommandRoutesOptions {
  getBridge: () => ExtensionCommandBridge | null;
  isReady: () => boolean;
}

export function registerSemanticCommandRoutes(
  fastify: FastifyInstance,
  options: SemanticCommandRoutesOptions,
): void {
  fastify.post<{ Body: SemanticExecRequest }>(
    SEMANTIC_EXEC_ROUTE,
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      const bridge = options.getBridge();
      if (!bridge || !options.isReady()) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE,
        });
      }

      try {
        const result = await executeSemanticCommand(bridge, request.body);
        return reply.status(HTTP_STATUS.OK).send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SemanticExecInputError) {
          return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
        }
        if (/timed out/i.test(message)) {
          return reply.status(HTTP_STATUS.GATEWAY_TIMEOUT).send({ error: message });
        }
        return reply.status(HTTP_STATUS.BAD_GATEWAY).send({ error: message });
      }
    },
  );
}
