/**
 * Client for the AI `/generate` endpoint on the local MCP mock server.
 *
 * The server owns the tool contract, the LLM prompt, and the Zod validation.
 * The app just hands over the italian prompt + widgetId and receives
 * widget-ready `DynamicWidgetProps`.
 */

import type { DynamicWidgetProps } from '../widgets/DynamicWidget';

const DEFAULT_BASE_URL =
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_MOCK_BASE_URL) ||
  'http://localhost:4599';

export type GenerateEngine = 'openai' | 'fallback';

export type GenerateToolCall = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

export type GenerateMeta = {
  engine: GenerateEngine;
  model?: string;
  prompt: string;
  widgetId: string;
  toolCalls: GenerateToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  reason?: string;
};

export type GenerateResponse = {
  widgetId: string;
  props: DynamicWidgetProps;
  meta: GenerateMeta;
};

export async function generateWidgetPropsFromPrompt(
  prompt: string,
  widgetId: string,
): Promise<GenerateResponse> {
  const res = await fetch(`${DEFAULT_BASE_URL}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ prompt, widgetId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `[generateClient] POST /generate → ${res.status} ${res.statusText}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return (await res.json()) as GenerateResponse;
}
