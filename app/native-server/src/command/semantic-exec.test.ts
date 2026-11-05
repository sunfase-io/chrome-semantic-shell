import * as path from 'node:path';
import { NativeMessageType } from './types';
import {
  executeSemanticCommand,
  normalizeSemanticExecRequest,
  SEMANTIC_EXEC_TOOL,
  type ExtensionCommandBridge,
} from './semantic-exec';

describe('semantic command execution', () => {
  it('validates input strictly', () => {
    expect(() => normalizeSemanticExecRequest({})).toThrow('script must be a non-empty string');
    expect(() =>
      normalizeSemanticExecRequest({ script: 'tab list', workspace: 'relative' }),
    ).toThrow('workspace must be an absolute path');
    expect(() => normalizeSemanticExecRequest({ script: 'tab list', extra: true })).toThrow(
      'unknown request field',
    );
  });

  it('forwards only the internal semantic executor', async () => {
    const sendRequestToExtensionAndWait = jest.fn().mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok tab=1' }], isError: false },
    });
    const bridge: ExtensionCommandBridge = { sendRequestToExtensionAndWait };

    const result = await executeSemanticCommand(bridge, {
      script: 'tab list',
      tabId: 1,
      timeoutMs: 900,
      workspace: path.resolve('.'),
    });

    expect(result.isError).toBe(false);
    expect(sendRequestToExtensionAndWait).toHaveBeenCalledTimes(1);
    const [payload, messageType, timeout] = sendRequestToExtensionAndWait.mock.calls[0];
    expect(messageType).toBe(NativeMessageType.CALL_TOOL);
    expect(timeout).toBe(5_900);
    expect(payload.name).toBe(SEMANTIC_EXEC_TOOL);
    expect(payload.args.script).toBe('tab list');
    expect(payload.args.__workspaceTools).toEqual(expect.any(Array));
  });

  it('fails fast on malformed extension responses', async () => {
    const bridge: ExtensionCommandBridge = {
      sendRequestToExtensionAndWait: jest.fn().mockResolvedValue({ status: 'success', data: null }),
    };
    await expect(executeSemanticCommand(bridge, { script: 'tab list' })).rejects.toThrow(
      'extension returned an invalid result',
    );
  });
});
