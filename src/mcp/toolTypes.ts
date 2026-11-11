import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { TerminalToolService } from './terminalServiceContract';

export type ToolResponse = {
  structuredContent?: Record<string, unknown>;
  content: { type: 'text'; text: string }[];
};

export interface ToolMetadata {
  name: string;
  description: string;
  domain?: string;
  requiredScope?: string;
  annotations?: ToolAnnotations;
}

/** Keep the Zod shape as the single source of truth for validated tool arguments. */
export function defineTool<const Shape extends z.ZodRawShape>(
  tool: ToolMetadata & {
    schema: Shape;
    handler(args: z.output<z.ZodObject<Shape>>, service?: TerminalToolService): Promise<ToolResponse>;
  }
) { return tool; }

export type AnyTool = ToolMetadata & {
  schema: z.ZodRawShape;
  handler(args: never): Promise<ToolResponse>;
};
