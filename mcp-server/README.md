# MCP Mock Server — Fatture in Cloud (POC)

Local mock that simulates the two Fatture in Cloud endpoints the widget POC needs. Two transports are exposed from the same data source:

- **stdio (MCP)** — for AI agents / MCP clients: `npm run dev` or `npm start`.
- **HTTP** — for the Expo app running on a simulator: `npm run http`, then fetch from `http://localhost:4599`.

## Tools / Endpoints

| MCP Tool               | HTTP path                 | Returns                                             |
| ---------------------- | ------------------------- | --------------------------------------------------- |
| `getFatturatoAttuale`  | `GET /fatturato-attuale`  | `{ month, amount, currency, updatedAt }`            |
| `getScadenzeImminenti` | `GET /scadenze-imminenti` | `Array<{ id, description, dueDate, amount, type }>` |

Also: `GET /health` → `{ ok: true }`.

## Commands

```bash
cd mcp-server
npm install
npm run test:tools   # prints both payloads to stdout
npm run http         # HTTP server on :4599 (used by the Expo app)
npm run dev          # stdio MCP server (used by AI agents)
```

## Data

All values are static and deterministic — see [src/data.ts](src/data.ts). There is no persistence and no external API call.
