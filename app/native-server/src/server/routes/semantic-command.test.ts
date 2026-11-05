import Fastify, { type FastifyInstance } from 'fastify';
import { registerSemanticCommandRoutes } from './semantic-command';
import type { ExtensionCommandBridge } from '../../command/semantic-exec';

describe('semantic command route', () => {
  let fastify: FastifyInstance;
  let ready = true;
  const sendRequestToExtensionAndWait = jest.fn();
  const bridge: ExtensionCommandBridge = { sendRequestToExtensionAndWait };

  beforeEach(async () => {
    ready = true;
    sendRequestToExtensionAndWait.mockReset().mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok tab=1' }], isError: false },
    });
    fastify = Fastify();
    registerSemanticCommandRoutes(fastify, {
      getBridge: () => bridge,
      isReady: () => ready,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('returns a command result without a session envelope', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/chrome/shell',
      payload: { script: 'tab list' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      content: [{ type: 'text', text: 'ok tab=1' }],
      isError: false,
    });
  });

  it('rejects invalid requests before contacting Chrome', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/chrome/shell',
      payload: { script: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(sendRequestToExtensionAndWait).not.toHaveBeenCalled();
  });

  it('fails immediately when the extension bridge is unavailable', async () => {
    ready = false;
    const response = await fastify.inject({
      method: 'POST',
      url: '/chrome/shell',
      payload: { script: 'tab list' },
    });
    expect(response.statusCode).toBe(503);
    expect(sendRequestToExtensionAndWait).not.toHaveBeenCalled();
  });
});
