import { createErrorResponse, type ToolExecutor } from '@/common/tool-handler';
import * as browserTools from './browser';

const tools = new Map<string, ToolExecutor>(
  Object.values(browserTools).map((tool) => [tool.name, tool]),
);

export interface ToolCallParam {
  name: string;
  args: unknown;
}

/** Internal action dispatch used by the Semantic Shell runtime. */
export async function handleCallTool(param: ToolCallParam) {
  const tool = tools.get(param.name);
  if (!tool) return createErrorResponse(`Internal action ${param.name} not found`);
  try {
    return await tool.execute(param.args as any);
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
