/**
 * Shared tool registry.
 *
 * These are the "MCP tools" — they describe capabilities in a JSON-schema
 * contract, and are consumed by two very different callers:
 *
 *  1. `index.ts` — the real MCP stdio server, which advertises them to any
 *     external AI client (Claude Desktop, Cursor, VS Code MCP…).
 *  2. `generator.ts` — the local `/generate` gateway, which passes the same
 *     schema to OpenAI's function-calling API so the LLM can decide which
 *     tool to invoke on behalf of the app.
 *
 * Keeping a single source of truth here is the whole point of MCP: the
 * contract is declarative, the implementation runs once.
 */

import {
  buildClientiMorosi,
  buildFatturatoAttuale,
  buildScadenzeImminenti,
  buildStimaTasse,
} from "./data.js";

export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export const tools: ToolDefinition[] = [
  {
    name: "getFatturatoAttuale",
    description:
      "Ritorna il fatturato del mese corrente (importo, valuta, trend rispetto al mese precedente). Nessun parametro.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: async () => buildFatturatoAttuale(),
  },
  {
    name: "getScadenzeImminenti",
    description:
      "Ritorna le prossime scadenze (fatture attive + versamenti fiscali). Supporta filtri: 'onlyType' per limitare a fatture o tasse, 'limit' per il numero massimo di risultati.",
    parameters: {
      type: "object",
      properties: {
        onlyType: {
          type: "string",
          enum: ["invoice", "tax"],
          description:
            "Se impostato, ritorna solo scadenze di questo tipo. 'invoice' = fatture attive, 'tax' = versamenti fiscali.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "Numero massimo di scadenze da ritornare (default: 3).",
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const onlyType = args.onlyType as "invoice" | "tax" | undefined;
      const limit = typeof args.limit === "number" ? args.limit : 3;
      let list = buildScadenzeImminenti();
      if (onlyType) {
        list = list.filter((s) => s.type === onlyType);
      }
      return list.slice(0, limit);
    },
  },
  {
    name: "getClientiMorosi",
    description:
      "Ritorna la lista dei clienti con fatture scadute non ancora pagate. Utile per monitorare gli insoluti e attivare azioni di recupero credito. Supporta il filtro 'periodo' (trimestre o anno).",
    parameters: {
      type: "object",
      properties: {
        periodo: {
          type: "string",
          enum: ["Q1", "Q2", "Q3", "Q4", "anno"],
          description:
            "Periodo di riferimento. 'Q1..Q4' filtra per trimestre, 'anno' considera l'intero anno corrente. Default: Q3.",
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const periodo =
        typeof args.periodo === "string" ? args.periodo : "Q3";
      return buildClientiMorosi(periodo);
    },
  },
  {
    name: "getStimaTasse",
    description:
      "Ritorna la stima delle tasse dovute nell'anno indicato, l'accantonamento suggerito e un breve consiglio operativo generato dal sistema. Utile per widget di pianificazione fiscale.",
    parameters: {
      type: "object",
      properties: {
        anno: {
          type: "integer",
          minimum: 2020,
          maximum: 2100,
          description: "Anno fiscale. Default: 2026.",
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const anno = typeof args.anno === "number" ? args.anno : 2026;
      return buildStimaTasse(anno);
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.run(args ?? {});
}
