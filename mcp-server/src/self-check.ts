/**
 * Quick sanity check: prints both tool payloads to stdout as JSON.
 *
 * Not a formal test suite — just a fast way for the Reviewer to confirm the
 * mock data conforms to the contract before wiring the widget.
 */

import { buildFatturatoAttuale, buildScadenzeImminenti } from "./data.js";

const fatturato = buildFatturatoAttuale();
const scadenze = buildScadenzeImminenti();

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      getFatturatoAttuale: fatturato,
      getScadenzeImminenti: scadenze,
    },
    null,
    2,
  ),
);

if (fatturato.currency !== "EUR") {
  process.exit(1);
}

if (!Array.isArray(scadenze) || scadenze.length === 0) {
  process.exit(2);
}
