import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { warningsBlock } from '../format.js';

/** Successful tool result: markdown text (always) plus optional structuredContent. */
export function toolResult(
  text: string,
  structured?: Record<string, unknown>,
  warnings?: string[],
): CallToolResult {
  const block = warningsBlock(warnings);
  const full = block ? `${text}\n\n${block}` : text;
  const result: CallToolResult = { content: [{ type: 'text', text: full }] };
  if (structured || warnings?.length) {
    result.structuredContent = { ...structured, ...(warnings?.length ? { warnings } : {}) };
  }
  return result;
}

/** Error tool result (isError) with a plain message. */
export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
