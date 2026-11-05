import type {
  CommandImageContent,
  CommandResult,
  CommandTextContent,
} from 'chrome-semantic-shell-shared';

export interface ToolResult extends CommandResult {
  content: (CommandTextContent | CommandImageContent)[];
  isError: boolean;
}

export interface ToolExecutor {
  execute(args: any): Promise<ToolResult>;
}

export const createErrorResponse = (
  message: string = 'Unknown error, please try again',
): ToolResult => {
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
};
