/**
 * `/generate` engine.
 *
 * Given a natural-language prompt in italian + a `widgetId`, produces a
 * validated `DynamicWidgetProps` that the app can hand straight to
 * `<widget>.updateTimeline([...])`.
 *
 * Two engines:
 *   - "openai": function-calling loop against the OpenAI API. Uses the shared
 *     tool registry (tools.ts) so the LLM literally invokes MCP-style tools
 *     to fetch data. Final output is forced through
 *     `response_format: json_schema` (strict) to guarantee it matches the
 *     DynamicWidgetProps contract.
 *   - "fallback": no OPENAI_API_KEY, so we simulate the same reasoning with
 *     italian keyword heuristics — picks the template, calls the same tools
 *     directly, and materializes the same shape.
 *
 * Every path re-validates with Zod before returning.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
  ClienteMoroso,
  FatturatoAttuale,
  ScadenzaImminente,
  StimaTasse,
} from "./data.js";
import {
  formatCurrencyEur,
  formatDue,
  formatMonth,
} from "./format.js";
import {
  dynamicWidgetPropsJsonSchema,
  dynamicWidgetPropsSchema,
  type DynamicWidgetProps,
  type WidgetStatus,
} from "./schema.js";
import { executeTool, tools } from "./tools.js";

export type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

export type GenerateResult = {
  widgetId: string;
  props: DynamicWidgetProps;
  meta: {
    engine: "openai" | "fallback";
    model?: string;
    prompt: string;
    widgetId: string;
    toolCalls: ToolCallRecord[];
    promptTokens?: number;
    completionTokens?: number;
    reason?: string;
  };
};

/* -------------------------------------------------------------------------- */
/* Prompting                                                                  */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `Sei "Widget Builder AI", un assistente che configura in tempo reale gli SLOT WIDGET di un'app iOS/Android per Fatture in Cloud.

CONTESTO ARCHITETTURALE (IMPORTANTE):
- iOS (WidgetKit) e Android (AppWidgets) NON permettono di creare nuovi tipi di widget a runtime.
- L'app dichiara al compile-time 3 slot generici pre-registrati (widgetId: "overview", "finance_focus", "tax_tracker") che l'utente può aggiungere alla Home Screen.
- Ogni slot è una TELA GENERICA: può diventare qualsiasi cosa a seconda del prompt che l'utente invia. Il widgetId è solo l'indirizzo dello slot da riempire, NON un vincolo sul contenuto.
- Il tuo compito: dato il prompt dell'utente per uno specifico slot, scegli il template migliore e riempilo con dati reali dai tool.

Il widget può assumere UNO di tre template visivi:
- "split_overview"     — metrica in alto + lista secondaria di 2-3 elementi. Ideale per panoramiche (fatturato + scadenze).
- "list_focus"         — piccola metrica riassuntiva + lista in evidenza. Ideale per alert operativi come clienti insoluti.
- "metric_with_alert"  — metrica grande + un singolo consiglio/avviso sotto. Ideale per previsioni, stime, insight fiscali.

Regole:
1. Scegli il template SOLO in base al prompt, MAI in base al widgetId. Uno slot chiamato "overview" può benissimo diventare un widget di insoluti se il prompt lo richiede.
2. Usa i tool disponibili (getFatturatoAttuale, getScadenzeImminenti, getClientiMorosi, getStimaTasse) per prendere i dati; passa i parametri quando servono.
3. NON inventare numeri: ogni cifra deve venire da un tool.
4. Riempi SEMPRE la struttura completa: title, primaryMetric{label,value,trend}, secondarySection{title,items[]}.
5. Formatta gli importi in euro con formato italiano ("€ 8.450"), senza decimali salvo eccezioni.
6. Per ogni item scegli uno "status": "critical" per elementi urgenti/rossi, "warning" per medi/arancioni, "info" per neutri/blu.
7. Massimo 3 items in secondarySection.items.
8. Testi brevi (label ≤ 40 char, text ≤ 40 char, subtext ≤ 60 char). Se un campo non serve, usa la stringa vuota "".
9. Al termine della fase di raccolta dati, ritorna SOLO il JSON conforme allo schema.

Ecco tre esempi di riferimento (few-shot). Nota: il widgetId di partenza è irrilevante per la scelta del template.

--- ESEMPIO 1 (split_overview) ---
Prompt: "Mostrami il fatturato del mese e le due scadenze più urgenti."
Tools: getFatturatoAttuale(), getScadenzeImminenti(limit: 2)
Output:
{"template":"split_overview","content":{"title":"STATO MENSILE","primaryMetric":{"label":"Fatturato di luglio","value":"€ 18.420","trend":"+12% vs giugno"},"secondarySection":{"title":"SCADENZE URGENTI","items":[{"id":"inv-2026-104","text":"Fattura #2026/104 · Studio Rossi","subtext":"Scadenza 10 lug · €2.450","status":"critical"},{"id":"tax-iva-q2","text":"Versamento IVA · 2° trim.","subtext":"Scadenza 16 lug · €3.180","status":"warning"}]}}}

--- ESEMPIO 2 (list_focus) ---
Prompt: "Voglio tenere d'occhio i clienti che non hanno ancora pagato questo trimestre."
Tools: getClientiMorosi(periodo: "Q3")
Output:
{"template":"list_focus","content":{"title":"INSOLUTI Q3","primaryMetric":{"label":"Totale da recuperare","value":"€ 3.950","trend":"3 fatture aperte"},"secondarySection":{"title":"CLIENTI","items":[{"id":"cli-101","text":"Verdi Auto SpA","subtext":"Ritardo 24 giorni · €2.000","status":"critical"},{"id":"cli-103","text":"Neri Restauri SRL","subtext":"Ritardo 12 giorni · €850","status":"warning"},{"id":"cli-102","text":"Studio Tecnico Bianchi","subtext":"Ritardo 5 giorni · €1.100","status":"warning"}]}}}

--- ESEMPIO 3 (metric_with_alert) ---
Prompt: "Crea un widget per monitorare le mie tasse stimate e quanto devo accantonare."
Tools: getStimaTasse(anno: 2026)
Output:
{"template":"metric_with_alert","content":{"title":"TASSE 2026","primaryMetric":{"label":"Accantonamento stimato","value":"€ 5.600","trend":"Regime forfetario"},"secondarySection":{"title":"AI INSIGHT","items":[{"id":"tip-1","text":"Consiglio AI","subtext":"Accantona il 25% su ogni fattura in arrivo per l'acconto di novembre.","status":"info"}]}}}
`;

const MAX_TOOL_ROUNDS = 4;

/* -------------------------------------------------------------------------- */
/* Public entrypoint                                                          */
/* -------------------------------------------------------------------------- */

export async function generateWidgetProps(
  prompt: string,
  widgetId: string,
): Promise<GenerateResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    throw new Error("Prompt is empty");
  }
  const cleanWidgetId = widgetId.trim() || "default";

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      return await generateWithOpenAI(cleanPrompt, cleanWidgetId, apiKey);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[generator] openai path failed: ${reason}`);
      const fb = await generateWithFallback(cleanPrompt, cleanWidgetId);
      fb.meta.reason = `openai_failed: ${reason}`;
      return fb;
    }
  }

  const fb = await generateWithFallback(cleanPrompt, cleanWidgetId);
  fb.meta.reason = "no_api_key";
  return fb;
}

/* -------------------------------------------------------------------------- */
/* OpenAI engine                                                              */
/* -------------------------------------------------------------------------- */

async function generateWithOpenAI(
  prompt: string,
  widgetId: string,
  apiKey: string,
): Promise<GenerateResult> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const client = new OpenAI({ apiKey });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `widgetId: ${widgetId}\nRichiesta utente: ${prompt}`,
    },
  ];

  const openaiTools: ChatCompletionTool[] = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));

  const toolCallsLog: ToolCallRecord[] = [];

  // Tool-use loop.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: openaiTools,
      tool_choice: "auto",
    });
    const choice = completion.choices[0];
    if (!choice) throw new Error("OpenAI: empty completion");

    const msg = choice.message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `Unsupported tool call type: ${tc.type}`,
            }),
          });
          continue;
        }

        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          args = {};
        }
        let result: unknown;
        try {
          result = await executeTool(name, args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolCallsLog.push({ name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    break;
  }

  // Final call: force structured output that matches DynamicWidgetProps.
  messages.push({
    role: "user",
    content:
      "Ora, sulla base dei dati recuperati, ritorna il JSON finale conforme allo schema del widget. Non chiamare altri tool.",
  });

  const finalCompletion = await client.chat.completions.create({
    model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "DynamicWidgetProps",
        strict: true,
        schema: dynamicWidgetPropsJsonSchema,
      },
    },
  });

  const content = finalCompletion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI: empty structured response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `OpenAI returned non-JSON content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const validated = dynamicWidgetPropsSchema.parse(parsed);

  return {
    widgetId,
    props: validated,
    meta: {
      engine: "openai",
      model,
      prompt,
      widgetId,
      toolCalls: toolCallsLog,
      promptTokens: finalCompletion.usage?.prompt_tokens,
      completionTokens: finalCompletion.usage?.completion_tokens,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fallback engine (no API key)                                               */
/* -------------------------------------------------------------------------- */

type Intent = "morosi" | "tasse" | "overview";

function detectIntent(prompt: string): Intent {
  const p = prompt.toLowerCase();

  // "morosi" is a broad concept: clienti che non pagano, insoluti, recupero
  // credito, fatture scadute, chi è in ritardo, chi mi deve dei soldi.
  // Watch for any of these italian markers.
  if (
    /\bmoros[io]\b|insolut|\bpagat[oaie]?\b|scadut[oaie]?|recupero\s+credit|\bin\s+ritardo\b|non\s+(ha|hanno)\s+\w*\s*pagat|\bmi\s+dev(e|ono)\b|\bdev(e|ono)\s+pagar|\bda\s+recuperar/.test(
      p,
    )
  ) {
    return "morosi";
  }

  // "Prossimi versamenti/scadenze" is a list-of-deadlines request and must
  // win over generic tasse/fiscal keywords: an IVA versamento is a scadenza,
  // not an accantonamento stimato.
  if (/\bversament[oi]\b|\bscadenz[ae]/.test(p)) {
    return "overview";
  }

  if (
    /\btasse?\b|fiscal|accantonamen|forfet|acconto|irpef|inps|previsione\s+tasse|stima\s+tasse/.test(
      p,
    )
  ) {
    return "tasse";
  }
  return "overview";
}

async function generateWithFallback(
  prompt: string,
  widgetId: string,
): Promise<GenerateResult> {
  const intent = detectIntent(prompt);
  const toolCalls: ToolCallRecord[] = [];

  if (intent === "morosi") {
    const morosi = (await executeTool("getClientiMorosi", {
      periodo: "Q3",
    })) as ClienteMoroso[];
    toolCalls.push({
      name: "getClientiMorosi",
      args: { periodo: "Q3" },
      result: morosi,
    });

    const total = morosi.reduce((acc, c) => acc + c.importo, 0);
    const items = morosi.slice(0, 3).map((c) => ({
      id: c.id,
      text: c.ragioneSociale,
      subtext: `Ritardo ${c.giorniRitardo} giorni · ${formatCurrencyEur(c.importo)}`,
      status: statusFromRitardo(c.giorniRitardo),
    }));

    const props: DynamicWidgetProps = {
      template: "list_focus",
      content: {
        title: "INSOLUTI Q3",
        primaryMetric: {
          label: "Totale da recuperare",
          value: formatCurrencyEur(total),
          trend: `${morosi.length} fatture aperte`,
        },
        secondarySection: {
          title: "CLIENTI",
          items,
        },
      },
    };
    return finalize(widgetId, prompt, props, toolCalls);
  }

  if (intent === "tasse") {
    const stima = (await executeTool("getStimaTasse", { anno: 2026 })) as
      | StimaTasse;
    toolCalls.push({
      name: "getStimaTasse",
      args: { anno: 2026 },
      result: stima,
    });

    const props: DynamicWidgetProps = {
      template: "metric_with_alert",
      content: {
        title: `TASSE ${stima.anno}`,
        primaryMetric: {
          label: "Accantonamento stimato",
          value: formatCurrencyEur(stima.accantonamentoStimato),
          trend: stima.regime,
        },
        secondarySection: {
          title: "AI INSIGHT",
          items: [
            {
              id: "tip-1",
              text: "Consiglio AI",
              subtext: stima.consiglio,
              status: "info",
            },
          ],
        },
      },
    };
    return finalize(widgetId, prompt, props, toolCalls);
  }

  // Default: split_overview with fatturato + scadenze.
  const fatturato = (await executeTool("getFatturatoAttuale", {})) as
    | FatturatoAttuale;
  toolCalls.push({
    name: "getFatturatoAttuale",
    args: {},
    result: fatturato,
  });

  // limit heuristic
  let limit = 2;
  const p = prompt.toLowerCase();
  const numMatch = p.match(/(\d+)\s*(?:scaden|voci|elementi|prime|prossim)/);
  if (numMatch && numMatch[1]) {
    const n = parseInt(numMatch[1], 10);
    if (!Number.isNaN(n) && n > 0) limit = Math.min(n, 3);
  }
  let onlyType: "invoice" | "tax" | undefined;
  if (/\biva\b|tass|versament/.test(p)) onlyType = "tax";

  const scadenze = (await executeTool("getScadenzeImminenti", {
    limit,
    ...(onlyType ? { onlyType } : {}),
  })) as ScadenzaImminente[];
  toolCalls.push({
    name: "getScadenzeImminenti",
    args: { limit, ...(onlyType ? { onlyType } : {}) },
    result: scadenze,
  });

  const items = scadenze.slice(0, 3).map((s) => ({
    id: s.id,
    text: truncate(s.description, 40),
    subtext: `Scadenza ${formatDue(s.dueDate)} · ${formatCurrencyEur(s.amount)}`,
    status: statusFromDue(s.dueDate),
  }));

  const props: DynamicWidgetProps = {
    template: "split_overview",
    content: {
      title: "STATO MENSILE",
      primaryMetric: {
        label: `Fatturato di ${formatMonth(fatturato.month).toLowerCase()}`,
        value: formatCurrencyEur(fatturato.amount),
        trend: fatturato.trendVsPreviousMonth,
      },
      secondarySection: {
        title: "SCADENZE URGENTI",
        items,
      },
    },
  };
  return finalize(widgetId, prompt, props, toolCalls);
}

function finalize(
  widgetId: string,
  prompt: string,
  props: DynamicWidgetProps,
  toolCalls: ToolCallRecord[],
): GenerateResult {
  const validated = dynamicWidgetPropsSchema.parse(props);
  return {
    widgetId,
    props: validated,
    meta: {
      engine: "fallback",
      prompt,
      widgetId,
      toolCalls,
    },
  };
}

function statusFromRitardo(days: number): WidgetStatus {
  if (days >= 15) return "critical";
  if (days >= 5) return "warning";
  return "info";
}

function statusFromDue(iso: string): WidgetStatus {
  const days = Math.round(
    (new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (days <= 3) return "critical";
  if (days <= 10) return "warning";
  return "info";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
