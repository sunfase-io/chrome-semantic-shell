import type { PageToolDescriptor } from 'chrome-semantic-shell-shared';

interface WebMcpToolRecord extends PageToolDescriptor {
  origin?: string;
}

/**
 * executeScript drops exceptions thrown by an injected function (the frame result is just undefined),
 * so injected functions report failures as values and the caller rethrows them.
 */
interface InjectedOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function unwrap<T>(results: Array<{ result?: InjectedOutcome<T> }> | undefined, action: string): T {
  const outcome = results?.[0]?.result;
  if (!outcome) throw new Error(`${action}: the page frame returned no result`);
  if (!outcome.ok) throw new Error(outcome.error || `${action} failed`);
  return outcome.value as T;
}

export async function listWebMcpTools(tabId: number): Promise<WebMcpToolRecord[]> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      try {
        const context = (document as any).modelContext;
        if (!context || typeof context.getTools !== 'function') return { ok: true, value: [] };
        const tools = await context.getTools();
        return {
          ok: true,
          value: tools.map((tool: any) => ({
            name: String(tool.name || ''),
            description: String(tool.description || ''),
            inputSchema: tool.inputSchema || undefined,
            source: 'webmcp',
            origin: tool.origin || location.origin,
            readOnly: tool.annotations?.readOnlyHint === true,
          })),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  } as any)) as Array<{ result?: InjectedOutcome<WebMcpToolRecord[]> }>;
  return unwrap(results, 'list WebMCP tools');
}

export async function callWebMcpTool(
  tabId: number,
  name: string,
  input: unknown,
): Promise<unknown> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (toolName: string, rawInput: string) => {
      try {
        const context = (document as any).modelContext;
        if (!context || typeof context.getTools !== 'function') {
          return { ok: false, error: 'document.modelContext is unavailable on this page' };
        }
        const tools = await context.getTools();
        const matches = tools.filter((tool: any) => String(tool.name) === toolName);
        if (matches.length !== 1) {
          return {
            ok: false,
            error: matches.length
              ? `WebMCP tool "${toolName}" is ambiguous`
              : `WebMCP tool "${toolName}" not found`,
          };
        }
        return { ok: true, value: await context.executeTool(matches[0], rawInput) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [name, JSON.stringify(input ?? {})],
  } as any)) as Array<{ result?: InjectedOutcome<unknown> }>;
  return unwrap(results, `WebMCP tool "${name}"`);
}
