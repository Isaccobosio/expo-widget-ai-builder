/**
 * Minimal HTTP wrapper around the mock data + the AI /generate endpoint.
 *
 * The MCP stdio transport (index.ts) is for AI agents talking MCP directly.
 * The widget's JS layer talks HTTP instead — it's what the iOS/Android
 * simulator can reach at localhost. This file exposes:
 *
 *   GET  /health                → { ok: true }
 *   GET  /fatturato-attuale     → FatturatoAttuale
 *   GET  /scadenze-imminenti    → ScadenzaImminente[]
 *   POST /generate  {prompt}    → { props: FatturatoWidgetPropsShape, meta }
 *
 * `/generate` is the "AI builder" surface: it takes a natural-language prompt
 * from the app, hands it to an LLM (or the deterministic fallback), lets the
 * model call the same MCP tools, and returns validated widget props.
 */

import { createServer, type IncomingMessage } from "node:http";

import { buildFatturatoAttuale, buildScadenzeImminenti } from "./data.js";
import { generateWidgetProps } from "./generator.js";

const PORT = Number(process.env.PORT ?? 4599);
const MAX_BODY_BYTES = 32 * 1024;

function logAccess(
  method: string,
  url: string,
  status: number,
  startedAt: number,
): void {
  const ms = Date.now() - startedAt;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${method} ${url} → ${status} (${ms}ms)`);
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(
          new Error(
            `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  res.on("finish", () => logAccess(method, url, res.statusCode, startedAt));

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (method === "GET") {
      switch (url) {
        case "/health":
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              ok: true,
              service: "fic-widget-mcp-mock",
              aiEngine: process.env.OPENAI_API_KEY ? "openai" : "fallback",
            }),
          );
          return;

        case "/fatturato-attuale":
          res.statusCode = 200;
          res.end(JSON.stringify(buildFatturatoAttuale()));
          return;

        case "/scadenze-imminenti":
          res.statusCode = 200;
          res.end(JSON.stringify(buildScadenzeImminenti()));
          return;

        default:
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Not found", path: url }));
          return;
      }
    }

    if (method === "POST" && url === "/generate") {
      let body: { prompt?: unknown; widgetId?: unknown };
      try {
        body = await readJsonBody<{ prompt?: unknown; widgetId?: unknown }>(
          req,
        );
      } catch (err) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: "Invalid body",
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (!prompt.trim()) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing 'prompt' string" }));
        return;
      }
      const widgetId =
        typeof body.widgetId === "string" && body.widgetId.trim()
          ? body.widgetId.trim()
          : "default";
      const result = await generateWidgetProps(prompt, widgetId);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fic-widget-mcp-mock] handler error:", err);
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "Internal error",
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
  }
});

server.listen(PORT, () => {
  const engine = process.env.OPENAI_API_KEY
    ? `openai (${process.env.OPENAI_MODEL ?? "gpt-4o-mini"})`
    : "fallback (no OPENAI_API_KEY)";
  // eslint-disable-next-line no-console
  console.log(
    `[fic-widget-mcp-mock] HTTP listening on http://localhost:${PORT}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[fic-widget-mcp-mock] /generate engine: ${engine}`);
});
