/**
 * MCP mock server (stdio transport).
 *
 * Exposes the shared tool registry (tools.ts) over MCP so any external AI
 * agent — Claude Desktop, Cursor, VS Code Copilot with MCP — can reason over
 * the same data the widget consumes.
 *
 * The `/generate` HTTP endpoint (http.ts) uses the SAME registry internally,
 * so the LLM-driven builder and any external MCP agent stay in lockstep.
 *
 * Run with:  npm run dev   (tsx watch)
 *      or:   npm run build && npm start
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { executeTool, tools } from "./tools.js";

const server = new Server(
  {
    name: "fic-widget-mcp-mock",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  try {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const payload = await executeTool(name, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr, so it doesn't clobber the JSON-RPC channel on stdout.
process.stderr.write("[fic-widget-mcp-mock] listening on stdio\n");
