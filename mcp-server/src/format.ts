/**
 * Server-side italian formatters.
 *
 * We format twice in this project:
 *   - on the client (src/data/formatWidgetProps.ts) for the deterministic
 *     reload path, and
 *   - here on the server for the AI fallback path and as a reference the LLM
 *     can inspect when producing structured output.
 *
 * Keep both in sync.
 */

const CURRENCY_FMT = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const MONTH_FMT = new Intl.DateTimeFormat("it-IT", {
  month: "long",
  year: "numeric",
});

const DUE_FMT = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "short",
});

const TIME_FMT = new Intl.DateTimeFormat("it-IT", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatCurrencyEur(amount: number): string {
  return CURRENCY_FMT.format(amount);
}

export function formatMonth(isoMonth: string): string {
  const d = new Date(`${isoMonth}-01T00:00:00`);
  if (Number.isNaN(d.valueOf())) return isoMonth;
  const raw = MONTH_FMT.format(d);
  // Intl outputs "luglio 2026" — capitalize the first letter for the widget.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function formatDue(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.valueOf())) return isoDate;
  return DUE_FMT.format(d).replace(".", "");
}

export function formatUpdatedAt(now: Date = new Date()): string {
  return `aggiornato ${TIME_FMT.format(now)}`;
}

export function shortLabel(text: string, max = 28): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
