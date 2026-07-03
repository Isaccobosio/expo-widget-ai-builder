/**
 * Deterministic mock data source for the Fatture in Cloud widget POC.
 *
 * All numbers are fake. The shape here is the contract the widget consumes,
 * so keep the field names stable — the iOS/Android native code depends on them.
 *
 * Four "endpoints" are exposed here:
 *   - buildFatturatoAttuale()   → monthly revenue
 *   - buildScadenzeImminenti()  → upcoming invoices and fiscal deadlines
 *   - buildClientiMorosi()      → customers with unpaid invoices (per quarter)
 *   - buildStimaTasse()         → yearly tax forecast with an insight
 */

export interface FatturatoAttuale {
  month: string; // e.g. "2026-07"
  amount: number; // EUR, cents-free
  currency: "EUR";
  trendVsPreviousMonth: string; // e.g. "+12% vs giugno"
  updatedAt: string; // ISO 8601
}

export interface ScadenzaImminente {
  id: string;
  description: string;
  dueDate: string; // ISO 8601 date
  amount: number; // EUR
  type: "invoice" | "tax";
}

export interface ClienteMoroso {
  id: string;
  ragioneSociale: string;
  giorniRitardo: number;
  importo: number; // EUR
  numeroFatture: number;
}

export interface StimaTasse {
  anno: number;
  regime: string; // e.g. "Regime forfetario"
  accantonamentoStimato: number; // EUR
  aliquotaPercentualeSuggerita: number; // e.g. 25
  consiglio: string; // AI insight-friendly one-liner
}

const REFERENCE_MONTH = "2026-07";

export function buildFatturatoAttuale(): FatturatoAttuale {
  return {
    month: REFERENCE_MONTH,
    amount: 18_420,
    currency: "EUR",
    trendVsPreviousMonth: "+12% vs giugno",
    updatedAt: new Date().toISOString(),
  };
}

export function buildScadenzeImminenti(): ScadenzaImminente[] {
  return [
    {
      id: "inv-2026-104",
      description: "Fattura #2026/104 — Studio Rossi SRL",
      dueDate: "2026-07-10",
      amount: 2_450,
      type: "invoice",
    },
    {
      id: "tax-iva-q2",
      description: "Versamento IVA — 2° trimestre",
      dueDate: "2026-07-16",
      amount: 3_180,
      type: "tax",
    },
    {
      id: "inv-2026-107",
      description: "Fattura #2026/107 — Bianchi & Co.",
      dueDate: "2026-07-22",
      amount: 1_120,
      type: "invoice",
    },
  ];
}

/**
 * Ignores `periodo` in this POC — we just return a deterministic set. In a
 * real backend `periodo` would filter by quarter.
 */
export function buildClientiMorosi(_periodo: string = "Q3"): ClienteMoroso[] {
  return [
    {
      id: "cli-101",
      ragioneSociale: "Verdi Auto SpA",
      giorniRitardo: 24,
      importo: 2_000,
      numeroFatture: 1,
    },
    {
      id: "cli-102",
      ragioneSociale: "Studio Tecnico Bianchi",
      giorniRitardo: 5,
      importo: 1_100,
      numeroFatture: 1,
    },
    {
      id: "cli-103",
      ragioneSociale: "Neri Restauri SRL",
      giorniRitardo: 12,
      importo: 850,
      numeroFatture: 1,
    },
  ];
}

export function buildStimaTasse(anno: number = 2026): StimaTasse {
  return {
    anno,
    regime: "Regime forfetario",
    accantonamentoStimato: 5_600,
    aliquotaPercentualeSuggerita: 25,
    consiglio:
      "Accantona il 25% su ogni fattura attiva in arrivo per coprire l’acconto di novembre in sicurezza.",
  };
}
