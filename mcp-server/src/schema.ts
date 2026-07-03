/**
 * DynamicWidgetProps — the flexible contract every widget instance receives.
 *
 * Instead of hard-coding the "fatturato" layout, we describe three visual
 * templates the widget knows how to render:
 *
 *   - "split_overview"     — headline metric + side list of items.
 *   - "list_focus"         — small metric summary + emphasized list.
 *   - "metric_with_alert"  — huge metric + single alert/insight callout.
 *
 * The LLM picks the template and fills a shared structure. The Expo widget
 * component reads `template` and branches its layout.
 *
 * All fields are REQUIRED and no extra properties are allowed — this makes
 * the schema safe for OpenAI's `response_format.json_schema` strict mode.
 */

import { z } from "zod";

export const widgetStatusSchema = z.enum(["critical", "warning", "info"]);
export type WidgetStatus = z.infer<typeof widgetStatusSchema>;

export const widgetTemplateSchema = z.enum([
  "split_overview",
  "list_focus",
  "metric_with_alert",
]);
export type WidgetTemplate = z.infer<typeof widgetTemplateSchema>;

export const primaryMetricSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(24),
  trend: z.string().max(60),
});

export const sectionItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(60),
  subtext: z.string().max(140),
  status: widgetStatusSchema,
});

export const secondarySectionSchema = z.object({
  title: z.string().max(60),
  items: z.array(sectionItemSchema).max(3),
});

export const dynamicWidgetContentSchema = z.object({
  title: z.string().min(1).max(60),
  primaryMetric: primaryMetricSchema,
  secondarySection: secondarySectionSchema,
});

export const dynamicWidgetPropsSchema = z.object({
  template: widgetTemplateSchema,
  content: dynamicWidgetContentSchema,
});

export type DynamicWidgetProps = z.infer<typeof dynamicWidgetPropsSchema>;

/**
 * JSON-schema variant handed to OpenAI as `response_format.json_schema` with
 * `strict: true`. Must mirror the Zod schema exactly: every property listed
 * in `required`, and every object with `additionalProperties: false`.
 */
export const dynamicWidgetPropsJsonSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["template", "content"],
  properties: {
    template: {
      type: "string",
      enum: ["split_overview", "list_focus", "metric_with_alert"],
      description:
        "Template di rendering del widget. Sceglilo in base al prompt: 'split_overview' per panoramiche, 'list_focus' per liste di alert/clienti, 'metric_with_alert' per una metrica grande con consiglio.",
    },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["title", "primaryMetric", "secondarySection"],
      properties: {
        title: {
          type: "string",
          description:
            "Titolo del widget, breve e leggibile in maiuscolo (es. 'STATO MENSILE').",
        },
        primaryMetric: {
          type: "object",
          additionalProperties: false,
          required: ["label", "value", "trend"],
          properties: {
            label: {
              type: "string",
              description:
                "Etichetta della metrica principale (es. 'Fatturato di luglio').",
            },
            value: {
              type: "string",
              description:
                'Valore già formattato (es. "€ 8.450"). Usa formato italiano.',
            },
            trend: {
              type: "string",
              description:
                'Trend o contesto breve. Se non applicabile, ritorna stringa vuota "".',
            },
          },
        },
        secondarySection: {
          type: "object",
          additionalProperties: false,
          required: ["title", "items"],
          properties: {
            title: {
              type: "string",
              description:
                'Titolo della sezione secondaria. Se non applicabile, ritorna stringa vuota "".',
            },
            items: {
              type: "array",
              maxItems: 3,
              description:
                "Massimo 3 elementi. Ognuno ha uno status che ne determina il colore.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "text", "subtext", "status"],
                properties: {
                  id: {
                    type: "string",
                    description: "Identificatore stabile dell'elemento.",
                  },
                  text: {
                    type: "string",
                    description:
                      "Testo principale dell'elemento (es. 'Fattura #102 - Rossi SRL').",
                  },
                  subtext: {
                    type: "string",
                    description:
                      'Contesto o dettaglio dell\'elemento (es. "Scadenza domani • €1.200"). Puoi ritornare "" se non applicabile.',
                  },
                  status: {
                    type: "string",
                    enum: ["critical", "warning", "info"],
                    description:
                      "Livello di attenzione: critical (rosso), warning (arancione), info (blu/neutro).",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
