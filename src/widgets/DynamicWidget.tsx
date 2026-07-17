/**
 * DynamicWidget — a single component with three visual templates.
 *
 * The server-side `/generate` LLM chooses the template ("split_overview",
 * "list_focus", "metric_with_alert") and fills a shared payload. This
 * component reads `props.template` and branches its layout accordingly.
 *
 * We register three widget "kinds" here (`OverviewWidget`, `FinanceFocusWidget`,
 * `TaxTrackerWidget`) — all sharing the exact same component. Each kind has
 * its own timeline, so the user can place multiple widgets on the home screen
 * and independently update each one from the app via natural language.
 *
 * Visual system: NO container background — WidgetKit uses the system default
 * widget material (auto light/dark). Text uses SwiftUI semantic colors
 * (`primary` / `secondary`) so it inverts automatically. Only accent
 * highlights (title pill, primary trend, item amounts) use fixed hex colors —
 * they have enough saturation to remain legible on both light and dark
 * widget surfaces.
 *
 * Empty state: if there's no data yet (widget picker preview, placeholder
 * snapshot, or before the first `updateTimeline`), the widget renders as a
 * blank tile — no placeholder text, no fake numbers.
 */

import { HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  background,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  multilineTextAlignment,
  padding,
  shapes,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

export type WidgetStatus = 'critical' | 'warning' | 'info';

export type WidgetTemplate =
  | 'split_overview'
  | 'list_focus'
  | 'metric_with_alert';

export type SectionItem = {
  id: string;
  text: string;
  subtext: string;
  status: WidgetStatus;
};

export type DynamicWidgetProps = {
  template: WidgetTemplate;
  content: {
    title: string;
    primaryMetric: {
      label: string;
      value: string;
      trend: string;
    };
    secondarySection: {
      title: string;
      items: SectionItem[];
    };
  };
};

/** Logical widget id → matches the `name` field in app.json plugin config. */
export type WidgetId = 'overview' | 'finance_focus' | 'tax_tracker';

/**
 * Widget component. Marked with the 'widget' directive so Metro isolates it
 * into the widget bundle. IMPORTANT: only code inside this function body is
 * visible to the widget runtime — external helpers/functions AND external
 * const objects/lookup tables are NOT hoisted into scope. Any helper logic
 * and any constant table (like a status→color map) MUST be inlined here.
 */
const DynamicWidget = (
  rawProps: DynamicWidgetProps | undefined,
  env: WidgetEnvironment | undefined,
) => {
  'widget';

  const isSmall = env?.widgetFamily === 'systemSmall';

  // Empty-state gate: no timeline data yet → render an intentionally blank
  // widget. We treat missing primaryMetric.value as "empty" so partial /
  // half-migrated payloads also render clean.
  const hasContent = Boolean(
    rawProps?.content?.primaryMetric?.value &&
      rawProps.content.primaryMetric.value.length > 0,
  );
  if (!hasContent) {
    return (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          frame({
            maxWidth: 10000,
            maxHeight: 10000,
            alignment: 'topLeading',
          }),
        ]}
      >
        <Spacer />
      </VStack>
    );
  }

  const template = rawProps!.template ?? 'split_overview';
  const title = rawProps!.content.title ?? '';
  const primaryLabel = rawProps!.content.primaryMetric.label ?? '';
  const primaryValue = rawProps!.content.primaryMetric.value;
  const primaryTrend = rawProps!.content.primaryMetric.trend ?? '';
  const sectionTitle = rawProps!.content.secondarySection?.title ?? '';
  const rawItems = rawProps!.content.secondarySection?.items;
  const safeItems: SectionItem[] = Array.isArray(rawItems) ? rawItems : [];

  // Accent color per template — used for the title pill and (for
  // split_overview / metric_with_alert) the trend line. These hex values
  // are picked to have good contrast on both light and dark widget surfaces.
  const accentColor =
    template === 'list_focus'
      ? '#6366F1' // indigo-500
      : template === 'metric_with_alert'
        ? '#10B981' // emerald-500
        : '#3B82F6'; // blue-500

  // Per-template item budget. `list_focus` is the "super-large list" view,
  // so on medium we lean into the list.
  const itemLimit =
    template === 'metric_with_alert'
      ? 1
      : template === 'list_focus'
        ? isSmall
          ? 2
          : 5
        : isSmall
          ? 2
          : 3;
  const items = safeItems.slice(0, itemLimit);

  // Primary value size. Large for metric_with_alert (hero number), compact
  // for list_focus (the list gets the real estate).
  const primaryValueSize =
    template === 'metric_with_alert'
      ? isSmall
        ? 34
        : 48
      : template === 'list_focus'
        ? isSmall
          ? 18
          : 22
        : isSmall
          ? 26
          : 34;

  return (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[
        // Fill the whole widget container. maxWidth/maxHeight with a very
        // large sentinel simulates SwiftUI's .infinity in @expo/ui.
        frame({
          maxWidth: 10000,
          maxHeight: 10000,
          alignment: 'topLeading',
        }),
        padding({ all: 14 }),
      ]}
    >
      {/* Title pill — colored accent bar makes each template visually distinct.
          White text on saturated accent → readable in both light and dark. */}
      {title ? (
        <HStack alignment="center" spacing={6}>
          <Text
            modifiers={[
              font({ size: 10, weight: 'bold' }),
              foregroundStyle('#FFFFFF'),
              padding({ horizontal: 8, vertical: 3 }),
              background(accentColor, shapes.capsule()),
              lineLimit(1),
              truncationMode('tail'),
            ]}
          >
            {title}
          </Text>
          <Spacer />
        </HStack>
      ) : null}

      {/* Primary metric block — layout depends on template */}
      {template === 'list_focus' ? (
        // Compact header row so the list dominates the widget.
        <HStack
          alignment="firstTextBaseline"
          spacing={8}
          modifiers={[padding({ top: 8 })]}
        >
          <VStack alignment="leading" spacing={0}>
            <Text
              modifiers={[
                font({ size: 10 }),
                foregroundStyle('secondary'),
                lineLimit(1),
                truncationMode('tail'),
              ]}
            >
              {primaryLabel}
            </Text>
            {primaryTrend ? (
              <Text
                modifiers={[
                  font({ size: 9 }),
                  foregroundStyle('secondary'),
                  lineLimit(1),
                  truncationMode('tail'),
                ]}
              >
                {primaryTrend}
              </Text>
            ) : null}
          </VStack>
          <Spacer />
          <Text
            modifiers={[
              font({ size: primaryValueSize, weight: 'bold' }),
              foregroundStyle('primary'),
              lineLimit(1),
              minimumScaleFactor(0.6),
            ]}
          >
            {primaryValue}
          </Text>
        </HStack>
      ) : (
        // Big value stacked above label.
        <VStack alignment="leading" spacing={2} modifiers={[padding({ top: 8 })]}>
          <Text
            modifiers={[
              font({ size: primaryValueSize, weight: 'bold' }),
              foregroundStyle('primary'),
              lineLimit(1),
              minimumScaleFactor(0.5),
            ]}
          >
            {primaryValue}
          </Text>
          <Text
            modifiers={[
              font({ size: 11 }),
              foregroundStyle('secondary'),
              lineLimit(1),
              truncationMode('tail'),
            ]}
          >
            {primaryLabel}
          </Text>
          {primaryTrend ? (
            <Text
              modifiers={[
                font({ size: 10, weight: 'medium' }),
                foregroundStyle(accentColor),
                lineLimit(1),
                truncationMode('tail'),
              ]}
            >
              {primaryTrend}
            </Text>
          ) : null}
        </VStack>
      )}

      {/* Section title (only shown when there's a list to introduce) */}
      {sectionTitle && items.length > 0 ? (
        <Text
          modifiers={[
            font({ size: 9, weight: 'bold' }),
            foregroundStyle('secondary'),
            padding({ top: template === 'list_focus' ? 10 : 12 }),
            lineLimit(1),
            truncationMode('tail'),
          ]}
        >
          {sectionTitle}
        </Text>
      ) : null}

      {/* Item list — two-column rows. Amount is bold + status-colored (no
          background chip) so it stays readable on both light and dark
          widget surfaces. */}
      {items.length > 0 ? (
        <VStack
          alignment="leading"
          spacing={template === 'list_focus' ? 8 : 6}
          modifiers={[padding({ top: 6 })]}
        >
          {items.map((it) => {
            const rawSubtext = it.subtext ?? '';
            // Split "caption · amount" — the last piece containing € becomes
            // the money column, everything else becomes the caption line.
            const parts = rawSubtext.split(' · ');
            const amountIdx = parts.findIndex((p) => p.includes('€'));
            const amount = amountIdx >= 0 ? parts[amountIdx] : rawSubtext;
            const caption =
              amountIdx >= 0
                ? parts.filter((_, i) => i !== amountIdx).join(' · ')
                : '';
            // Saturated tone that reads well on both light and dark bg.
            const amountColor =
              it.status === 'critical'
                ? '#DC2626' // red-600
                : it.status === 'warning'
                  ? '#D97706' // amber-600
                  : '#2563EB'; // blue-600
            const labelSize =
              template === 'list_focus'
                ? isSmall
                  ? 11
                  : 13
                : isSmall
                  ? 10
                  : 12;
            const amountSize =
              template === 'list_focus'
                ? isSmall
                  ? 12
                  : 14
                : isSmall
                  ? 11
                  : 13;

            return (
              <HStack key={it.id} alignment="center" spacing={8}>
                <VStack alignment="leading" spacing={1}>
                  <Text
                    modifiers={[
                      font({ size: labelSize, weight: 'semibold' }),
                      foregroundStyle('primary'),
                      lineLimit(1),
                      truncationMode('tail'),
                    ]}
                  >
                    {it.text}
                  </Text>
                  {caption ? (
                    <Text
                      modifiers={[
                        font({ size: Math.max(labelSize - 2, 9) }),
                        foregroundStyle('secondary'),
                        lineLimit(1),
                        truncationMode('tail'),
                      ]}
                    >
                      {caption}
                    </Text>
                  ) : null}
                </VStack>
                <Spacer />
                {amount ? (
                  <Text
                    modifiers={[
                      font({ size: amountSize, weight: 'bold' }),
                      foregroundStyle(amountColor),
                      lineLimit(1),
                      minimumScaleFactor(0.6),
                      multilineTextAlignment('trailing'),
                    ]}
                  >
                    {amount}
                  </Text>
                ) : null}
              </HStack>
            );
          })}
        </VStack>
      ) : null}

      <Spacer />
    </VStack>
  );
};

/**
 * Three widget kinds — all render the SAME component but each owns its own
 * WidgetKit / Glance timeline. This is what enables independent widget
 * instances on the home screen: the user places whichever kinds they want,
 * and the app updates each one separately via `<widget>.updateTimeline(...)`.
 *
 * The `name` argument MUST match the `name` field in
 * `app.json > expo.plugins["expo-widgets"].widgets[]`.
 */
export const overviewWidget = createWidget<DynamicWidgetProps>(
  'OverviewWidget',
  DynamicWidget,
);
export const financeFocusWidget = createWidget<DynamicWidgetProps>(
  'FinanceFocusWidget',
  DynamicWidget,
);
export const taxTrackerWidget = createWidget<DynamicWidgetProps>(
  'TaxTrackerWidget',
  DynamicWidget,
);

export const widgetsById = {
  overview: overviewWidget,
  finance_focus: financeFocusWidget,
  tax_tracker: taxTrackerWidget,
} as const;

export const WIDGET_ORDER: readonly WidgetId[] = [
  'overview',
  'finance_focus',
  'tax_tracker',
];

/**
 * Display metadata for the app-side configuration dashboard.
 *
 * IMPORTANT: the three keys ("overview", "finance_focus", "tax_tracker") are
 * only pre-registered *slot IDs* — they map 1:1 to the native widget targets
 * declared at compile-time in `app.json` (WidgetKit / AppWidgetProvider). Each
 * slot is a GENERIC CANVAS: the user's natural-language prompt fully drives
 * both the visual template AND the data source. The slot ID is just the
 * address of the target we call `updateTimeline` on, never a content filter.
 */
export const WIDGET_DISPLAY: Record<
  WidgetId,
  {
    slotNumber: number;
    slotLabel: string;
    nativeKind: string;
    description: string;
    placeholder: string;
    exampleHint: string;
  }
> = {
  overview: {
    slotNumber: 1,
    slotLabel: 'Slot 1',
    nativeKind: 'OverviewWidget',
    description: 'Slot generico configurabile via prompt.',
    placeholder:
      'Es. "Fatturato del mese e le 2 scadenze più urgenti."',
    exampleHint:
      'Esempio → panoramica: fatturato + scadenze (split_overview)',
  },
  finance_focus: {
    slotNumber: 2,
    slotLabel: 'Slot 2',
    nativeKind: 'FinanceFocusWidget',
    description: 'Slot generico configurabile via prompt.',
    placeholder:
      "Es. \"Monitora i clienti che non hanno ancora pagato questo trimestre.\"",
    exampleHint:
      'Esempio → alert operativo: insoluti Q3 (list_focus)',
  },
  tax_tracker: {
    slotNumber: 3,
    slotLabel: 'Slot 3',
    nativeKind: 'TaxTrackerWidget',
    description: 'Slot generico configurabile via prompt.',
    placeholder:
      'Es. "Stima tasse 2026 e quanto devo accantonare."',
    exampleHint:
      'Esempio → insight fiscale: stima tasse (metric_with_alert)',
  },
};
