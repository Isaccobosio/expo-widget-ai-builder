/**
 * Home Screen Widget Manager
 *
 * Architectural note: iOS (WidgetKit) and Android (AppWidgets) do NOT allow
 * new widget types to be created at runtime — every widget kind must be
 * declared at compile-time in `app.json` / native manifests. We work around
 * this by pre-registering 3 GENERIC SLOTS (see `app.json` and
 * `src/widgets/DynamicWidget.tsx`). The user adds the slots they want to the
 * Home Screen and then uses this dashboard to configure what each slot shows,
 * via natural language.
 *
 * Data flow per slot: user types a prompt → we POST { prompt, widgetId } to
 * the local mock's `/generate` endpoint → the LLM picks a template, calls MCP
 * tools, and returns validated `DynamicWidgetProps` → we call
 * `widgetsById[widgetId].updateTimeline([...])` so ONLY that slot re-renders.
 *
 * UI shape: tab bar switches between the 3 slots (one full-screen editor at a
 * time — no long scroll). A "?" button in the header opens a modal with the
 * capabilities panel + setup notes. A per-app in-memory prompt history is
 * exposed as "Recenti" chips so the user can quickly reuse what they typed.
 */

import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  generateWidgetPropsFromPrompt,
  type GenerateMeta,
} from './src/data/generateClient';
import {
  WIDGET_DISPLAY,
  WIDGET_ORDER,
  widgetsById,
  type DynamicWidgetProps,
  type WidgetId,
  type WidgetStatus,
} from './src/widgets/DynamicWidget';

type PerSlotStatus = 'idle' | 'loading' | 'ok' | 'error';

type SlotState = {
  prompt: string;
  status: PerSlotStatus;
  message: string;
  props: DynamicWidgetProps | null;
  meta: GenerateMeta | null;
  lastSyncedAt: Date | null;
};

const HISTORY_LIMIT = 8;

const TEMPLATE_LABEL: Record<DynamicWidgetProps['template'], string> = {
  split_overview: 'Panoramica',
  list_focus: 'Lista in evidenza',
  metric_with_alert: 'Metrica + alert',
};

/**
 * Data sources the LLM can call through MCP-style tools. Kept in sync with
 * `mcp-server/src/tools.ts` (single source of truth on the server).
 */
const DATA_SOURCES: Array<{
  tool: string;
  title: string;
  description: string;
  fields: string[];
}> = [
  {
    tool: 'getFatturatoAttuale',
    title: 'Fatturato del mese corrente',
    description: 'Totale fatturato del mese in corso con trend vs. mese precedente.',
    fields: ['totaleFatturato', 'mese', 'trendVsPreviousMonth'],
  },
  {
    tool: 'getScadenzeImminenti',
    title: 'Scadenze imminenti',
    description:
      'Elenco delle prossime scadenze (fatture da incassare e versamenti fiscali).',
    fields: ['id', 'label', 'tipo (fattura|versamento)', 'dataScadenza', 'importo'],
  },
  {
    tool: 'getClientiMorosi',
    title: 'Clienti morosi',
    description: 'Clienti con fatture scadute non pagate, filtrabili per trimestre.',
    fields: ['ragioneSociale', 'giorniRitardo', 'importo', 'numeroFatture'],
  },
  {
    tool: 'getStimaTasse',
    title: 'Stima tasse',
    description: 'Accantonamento stimato per l\'anno fiscale + consiglio operativo.',
    fields: ['anno', 'regime', 'accantonamentoStimato', 'aliquotaPercentualeSuggerita', 'consiglio'],
  },
];

/**
 * Visual templates the LLM can pick. Kept in sync with the widget component
 * in `src/widgets/DynamicWidget.tsx`.
 */
const TEMPLATES: Array<{
  key: DynamicWidgetProps['template'];
  title: string;
  description: string;
}> = [
  {
    key: 'split_overview',
    title: 'split_overview',
    description:
      'Metrica in alto + lista da 2–3 elementi sotto. Ideale per panoramiche riassuntive.',
  },
  {
    key: 'list_focus',
    title: 'list_focus',
    description:
      'Header compatto + lista dominante (fino a 5 righe su medium). Ideale per alert operativi e viste "elenco".',
  },
  {
    key: 'metric_with_alert',
    title: 'metric_with_alert',
    description:
      'Metrica grande + un singolo consiglio/avviso sotto. Ideale per stime e insight.',
  },
];

/**
 * Example prompts the user can quickly try. Tapping a chip populates the
 * active slot's input. The `template` field is only illustrative — the LLM
 * ultimately picks the template based on the prompt content.
 */
const EXAMPLE_PROMPTS: Array<{
  label: string;
  prompt: string;
  template: DynamicWidgetProps['template'];
}> = [
  {
    label: 'Panoramica mese',
    prompt: 'Fatturato del mese e le 2 scadenze più urgenti.',
    template: 'split_overview',
  },
  {
    label: 'Clienti insoluti',
    prompt:
      "Mostrami i clienti che non hanno ancora pagato questo trimestre, in ordine di gravità.",
    template: 'list_focus',
  },
  {
    label: 'Stima tasse',
    prompt: 'Quanto devo accantonare per le tasse 2026? Dammi anche un consiglio.',
    template: 'metric_with_alert',
  },
  {
    label: 'Solo versamenti',
    prompt: 'Prossimi 3 versamenti fiscali con importo e giorni mancanti.',
    template: 'split_overview',
  },
  {
    label: 'Cliente più critico',
    prompt: 'Chi è il cliente più in ritardo e quanto mi deve?',
    template: 'list_focus',
  },
];

function initialSlots(): Record<WidgetId, SlotState> {
  const slots = {} as Record<WidgetId, SlotState>;
  for (const id of WIDGET_ORDER) {
    slots[id] = {
      prompt: '',
      status: 'idle',
      message: '',
      props: null,
      meta: null,
      lastSyncedAt: null,
    };
  }
  return slots;
}

export default function App() {
  const [slots, setSlots] = useState<Record<WidgetId, SlotState>>(initialSlots);
  const [activeSlot, setActiveSlot] = useState<WidgetId>(WIDGET_ORDER[0]);
  const [history, setHistory] = useState<string[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);

  const updateSlot = useCallback((id: WidgetId, patch: Partial<SlotState>) => {
    setSlots((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const pushHistory = useCallback((prompt: string) => {
    const t = prompt.trim();
    if (!t) return;
    setHistory((prev) => {
      const next = [t, ...prev.filter((p) => p !== t)];
      return next.slice(0, HISTORY_LIMIT);
    });
  }, []);

  const syncSlot = useCallback(
    async (id: WidgetId) => {
      const trimmed = slots[id].prompt.trim();
      if (!trimmed) {
        updateSlot(id, {
          status: 'error',
          message: 'Scrivi un prompt per configurare questo slot.',
        });
        return;
      }
      updateSlot(id, { status: 'loading', message: '' });
      try {
        const result = await generateWidgetPropsFromPrompt(trimmed, id);
        widgetsById[id].updateTimeline([
          { date: new Date(), props: result.props },
        ]);
        updateSlot(id, {
          status: 'ok',
          props: result.props,
          meta: result.meta,
          message: '',
          lastSyncedAt: new Date(),
        });
        pushHistory(trimmed);
      } catch (err) {
        updateSlot(id, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [slots, updateSlot, pushHistory],
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="auto" />

      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>Fatture in Cloud · POC</Text>
          <Text style={styles.title}>Widget Manager</Text>
        </View>
        <Pressable
          onPress={() => setInfoOpen(true)}
          style={({ pressed }) => [
            styles.infoButton,
            pressed && styles.infoButtonPressed,
          ]}
          accessibilityLabel="Cosa puoi chiedere"
        >
          <Text style={styles.infoButtonText}>?</Text>
        </Pressable>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {WIDGET_ORDER.map((id) => {
          const active = id === activeSlot;
          const s = slots[id];
          return (
            <Pressable
              key={id}
              onPress={() => setActiveSlot(id)}
              style={({ pressed }) => [
                styles.tab,
                active && styles.tabActive,
                pressed && !active && styles.tabPressed,
              ]}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                Slot {WIDGET_DISPLAY[id].slotNumber}
              </Text>
              <View
                style={[
                  styles.tabDot,
                  s.status === 'ok' && styles.tabDotOk,
                  s.status === 'error' && styles.tabDotError,
                  s.status === 'loading' && styles.tabDotLoading,
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      {/* Active slot editor */}
      <SlotEditor
        key={activeSlot}
        id={activeSlot}
        slot={slots[activeSlot]}
        history={history}
        onChangePrompt={(text) => updateSlot(activeSlot, { prompt: text })}
        onSync={() => syncSlot(activeSlot)}
      />

      {/* Info modal */}
      <InfoModal visible={infoOpen} onClose={() => setInfoOpen(false)} />
    </KeyboardAvoidingView>
  );
}

/* -------------------------------------------------------------------------- */
/* SlotEditor — full-screen editor for the active slot                        */
/* -------------------------------------------------------------------------- */

function SlotEditor({
  id,
  slot,
  history,
  onChangePrompt,
  onSync,
}: {
  id: WidgetId;
  slot: SlotState;
  history: string[];
  onChangePrompt: (text: string) => void;
  onSync: () => void;
}) {
  const info = WIDGET_DISPLAY[id];
  const meta = slot.meta;
  const engineLabel = meta
    ? meta.engine === 'openai'
      ? `AI reale · ${meta.model ?? 'openai'}`
      : `AI fallback · ${meta.reason ?? 'deterministic'}`
    : null;

  return (
    <ScrollView
      style={styles.editor}
      contentContainerStyle={styles.editorContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.slotHead}>
        <Text style={styles.slotHeadTitle}>{info.slotLabel}</Text>
        <Text style={styles.slotHeadHint}>{info.exampleHint}</Text>
        <Text style={styles.slotHeadKind}>
          native kind: <Text style={styles.mono}>{info.nativeKind}</Text>
        </Text>
      </View>

      {/* Recenti — only if the user has typed at least one prompt */}
      {history.length > 0 ? (
        <ChipRow
          label="Recenti"
          items={history.map((h, i) => ({
            key: `hist-${i}`,
            label: truncate(h, 32),
            prompt: h,
          }))}
          disabled={slot.status === 'loading'}
          onPick={onChangePrompt}
          tone="recent"
        />
      ) : null}

      <ChipRow
        label="Esempi"
        items={EXAMPLE_PROMPTS.map((ex) => ({
          key: ex.label,
          label: ex.label,
          prompt: ex.prompt,
        }))}
        disabled={slot.status === 'loading'}
        onPick={onChangePrompt}
        tone="example"
      />

      <TextInput
        value={slot.prompt}
        onChangeText={onChangePrompt}
        placeholder={info.placeholder}
        placeholderTextColor="#9CA3AF"
        style={styles.input}
        multiline
        editable={slot.status !== 'loading'}
      />

      <Pressable
        onPress={onSync}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          slot.status === 'loading' && styles.buttonDisabled,
        ]}
        disabled={slot.status === 'loading'}
      >
        {slot.status === 'loading' ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>
            {slot.props ? 'Riconfigura slot' : 'Salva e sincronizza con AI'}
          </Text>
        )}
      </Pressable>

      {slot.status === 'error' ? (
        <Text style={styles.error}>{slot.message}</Text>
      ) : null}

      {slot.props ? <WidgetPreview props={slot.props} /> : null}

      {meta ? (
        <View style={styles.metaBlock}>
          <Text style={styles.metaTitle}>
            {engineLabel} · tool: {meta.toolCalls.map((t) => t.name).join(', ') || '—'}
          </Text>
          {typeof meta.promptTokens === 'number' ? (
            <Text style={styles.metaTokens}>
              token: prompt {meta.promptTokens} · completion{' '}
              {meta.completionTokens ?? '—'}
            </Text>
          ) : null}
          {slot.lastSyncedAt ? (
            <Text style={styles.metaTokens}>
              sincronizzato {slot.lastSyncedAt.toLocaleTimeString('it-IT')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------- */
/* WidgetPreview — a faithful RN mock of what the real widget renders          */
/* -------------------------------------------------------------------------- */

/**
 * Kept in visual sync with `src/widgets/DynamicWidget.tsx`. Renders both the
 * `systemSmall` (155×155) and `systemMedium` (329×155) shapes so the user
 * can see exactly what each Home Screen size will look like before adding
 * the widget. Uses the light system palette (no bg color) to match the real
 * widget on iOS.
 */
const ACCENT: Record<DynamicWidgetProps['template'], string> = {
  split_overview: '#3B82F6', // blue-500
  list_focus: '#6366F1', // indigo-500
  metric_with_alert: '#10B981', // emerald-500
};

const AMOUNT_COLOR: Record<WidgetStatus, string> = {
  critical: '#DC2626', // red-600
  warning: '#D97706', // amber-600
  info: '#2563EB', // blue-600
};

/** Approximate WidgetKit rendered sizes (systemSmall / systemMedium on 3x). */
const PREVIEW_DIMS = {
  small: { width: 155, height: 155 },
  medium: { width: 329, height: 155 },
} as const;

type PreviewSize = 'small' | 'medium';

function WidgetPreview({ props }: { props: DynamicWidgetProps }) {
  return (
    <View style={styles.previewWrapper}>
      <View style={styles.previewHeaderBar}>
        <Text style={styles.previewLabel}>ANTEPRIMA WIDGET</Text>
        <View style={styles.templatePill}>
          <Text style={styles.templatePillText}>
            {TEMPLATE_LABEL[props.template]}
          </Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.previewGallery}
      >
        <View style={styles.previewColumn}>
          <Text style={styles.previewSizeLabel}>Piccolo</Text>
          <WidgetPreviewTile size="small" props={props} />
        </View>
        <View style={styles.previewColumn}>
          <Text style={styles.previewSizeLabel}>Medio</Text>
          <WidgetPreviewTile size="medium" props={props} />
        </View>
      </ScrollView>
    </View>
  );
}

function WidgetPreviewTile({
  size,
  props,
}: {
  size: PreviewSize;
  props: DynamicWidgetProps;
}) {
  const isSmall = size === 'small';
  const t = props.template;
  const accent = ACCENT[t];
  const dims = PREVIEW_DIMS[size];

  // Mirror the widget's per-template + per-size item budget. Small tiles are
  // TIGHT (155pt tall), so split_overview shows only 1 item on small.
  const itemLimit =
    t === 'metric_with_alert'
      ? 1
      : t === 'list_focus'
        ? isSmall
          ? 2
          : 5
        : isSmall
          ? 1
          : 3;
  const items = props.content.secondarySection.items.slice(0, itemLimit);

  const primaryValueSize =
    t === 'metric_with_alert'
      ? isSmall
        ? 24
        : 36
      : t === 'list_focus'
        ? isSmall
          ? 15
          : 20
        : isSmall
          ? 20
          : 28;

  return (
    <View style={[styles.previewTile, { width: dims.width, height: dims.height }]}>
      {props.content.title ? (
        <View style={styles.previewTitleRow}>
          <View style={[styles.previewTitlePill, { backgroundColor: accent }]}>
            <Text style={styles.previewTitlePillText} numberOfLines={1}>
              {props.content.title}
            </Text>
          </View>
        </View>
      ) : null}

      {t === 'list_focus' ? (
        <View style={styles.previewListHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.previewMetricLabel} numberOfLines={1}>
              {props.content.primaryMetric.label}
            </Text>
            {props.content.primaryMetric.trend ? (
              <Text style={styles.previewTrendFaint} numberOfLines={1}>
                {props.content.primaryMetric.trend}
              </Text>
            ) : null}
          </View>
          <Text
            style={[styles.previewValue, { fontSize: primaryValueSize }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            {props.content.primaryMetric.value}
          </Text>
        </View>
      ) : (
        <View style={styles.previewMetricBlock}>
          <Text
            style={[styles.previewValue, { fontSize: primaryValueSize }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          >
            {props.content.primaryMetric.value}
          </Text>
          <Text style={styles.previewMetricLabel} numberOfLines={1}>
            {props.content.primaryMetric.label}
          </Text>
          {props.content.primaryMetric.trend ? (
            <Text style={[styles.previewTrend, { color: accent }]} numberOfLines={1}>
              {props.content.primaryMetric.trend}
            </Text>
          ) : null}
        </View>
      )}

      {items.length > 0 && props.content.secondarySection.title ? (
        <Text style={styles.previewSectionTitle} numberOfLines={1}>
          {props.content.secondarySection.title}
        </Text>
      ) : null}

      {items.length > 0 ? (
        <View style={styles.previewItems}>
          {items.map((it) => {
            const parts = (it.subtext ?? '').split(' · ');
            const amountIdx = parts.findIndex((p) => p.includes('€'));
            const amount = amountIdx >= 0 ? parts[amountIdx] : it.subtext;
            const caption =
              amountIdx >= 0
                ? parts.filter((_, i) => i !== amountIdx).join(' · ')
                : '';
            return (
              <View key={it.id} style={styles.previewItem}>
                {/* flex: 1 + minWidth: 0 lets this container shrink so the
                    Text inside actually truncates (RN quirk: without
                    minWidth: 0 flex children refuse to shrink below content
                    width) */}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.previewItemText} numberOfLines={1}>
                    {it.text}
                  </Text>
                  {caption ? (
                    <Text style={styles.previewItemSubtext} numberOfLines={1}>
                      {caption}
                    </Text>
                  ) : null}
                </View>
                {amount ? (
                  <Text
                    style={[
                      styles.previewItemAmount,
                      { color: AMOUNT_COLOR[it.status] },
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.6}
                  >
                    {amount}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* ChipRow — reusable label + wrapping chips                                  */
/* -------------------------------------------------------------------------- */

function ChipRow({
  label,
  items,
  disabled,
  onPick,
  tone,
}: {
  label: string;
  items: Array<{ key: string; label: string; prompt: string }>;
  disabled: boolean;
  onPick: (prompt: string) => void;
  tone: 'example' | 'recent';
}) {
  return (
    <View style={styles.chipRow}>
      <Text style={styles.chipRowLabel}>{label}</Text>
      <View style={styles.chips}>
        {items.map((it) => (
          <Pressable
            key={it.key}
            onPress={() => onPick(it.prompt)}
            disabled={disabled}
            style={({ pressed }) => [
              styles.chip,
              tone === 'recent' && styles.chipRecent,
              pressed && (tone === 'recent' ? styles.chipRecentPressed : styles.chipPressed),
              disabled && styles.chipDisabled,
            ]}
          >
            <Text
              style={[
                styles.chipText,
                tone === 'recent' && styles.chipRecentText,
              ]}
              numberOfLines={1}
            >
              {it.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/* -------------------------------------------------------------------------- */
/* InfoModal — capabilities panel + setup notes                               */
/* -------------------------------------------------------------------------- */

function InfoModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Cosa puoi chiedere all'AI</Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              styles.modalClose,
              pressed && styles.modalClosePressed,
            ]}
            accessibilityLabel="Chiudi"
          >
            <Text style={styles.modalCloseText}>Chiudi</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.modalBody}>
          <Text style={styles.capabilitiesLead}>
            Ogni slot è alimentato da un LLM che può chiamare i seguenti tool
            MCP e comporre uno dei tre layout supportati. Il template viene
            scelto dall'AI in base al prompt, non è vincolato allo slot.
          </Text>

          <Text style={styles.capabilitiesSection}>Dati disponibili</Text>
          {DATA_SOURCES.map((ds) => (
            <View key={ds.tool} style={styles.capabilityRow}>
              <Text style={styles.capabilityTool}>{ds.tool}</Text>
              <Text style={styles.capabilityTitle}>{ds.title}</Text>
              <Text style={styles.capabilityDescription}>{ds.description}</Text>
              <View style={styles.fieldsRow}>
                {ds.fields.map((f) => (
                  <View key={f} style={styles.fieldPill}>
                    <Text style={styles.fieldPillText}>{f}</Text>
                  </View>
                ))}
              </View>
            </View>
          ))}

          <Text style={styles.capabilitiesSection}>Layout supportati</Text>
          {TEMPLATES.map((t) => (
            <View key={t.key} style={styles.capabilityRow}>
              <Text style={styles.capabilityTool}>{t.title}</Text>
              <Text style={styles.capabilityDescription}>{t.description}</Text>
            </View>
          ))}

          <Text style={styles.capabilitiesSection}>Perché "slot"</Text>
          <Text style={styles.constraintBody}>
            iOS WidgetKit e Android AppWidgets non permettono di registrare
            nuovi tipi di widget a runtime: tutti i target devono essere
            dichiarati al compile-time. Noi ne registriamo 3 generici e li
            trattiamo come slot configurabili via natural language.
          </Text>

          <Text style={styles.capabilitiesSection}>Setup rapido</Text>
          <Text style={styles.footerBody}>
            1) In un terminale:{' '}
            <Text style={styles.mono}>npm run mock:server</Text>
            {'\n'}
            2) (Opzionale) esporta{' '}
            <Text style={styles.mono}>OPENAI_API_KEY</Text> per usare l'LLM
            reale invece del fallback deterministico.
            {'\n'}
            3) Aggiungi i 3 slot alla Home Screen del simulatore, poi torna
            qui e premi <Text style={styles.mono}>Sincronizza</Text>.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 10,
    gap: 12,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4F46E5',
    letterSpacing: 1.2,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    marginTop: 2,
  },
  infoButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoButtonPressed: {
    opacity: 0.85,
  },
  infoButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 4,
    padding: 4,
    backgroundColor: '#E5E7EB',
    borderRadius: 12,
    gap: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  tabPressed: {
    opacity: 0.6,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#111827',
  },
  tabDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#D1D5DB',
  },
  tabDotOk: {
    backgroundColor: '#10B981',
  },
  tabDotError: {
    backgroundColor: '#DC2626',
  },
  tabDotLoading: {
    backgroundColor: '#F59E0B',
  },
  editor: {
    flex: 1,
  },
  editorContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
    gap: 12,
  },
  slotHead: {
    gap: 2,
  },
  slotHeadTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  slotHeadHint: {
    fontSize: 12,
    color: '#4F46E5',
    fontStyle: 'italic',
  },
  slotHeadKind: {
    fontSize: 10,
    color: '#9CA3AF',
    marginTop: 2,
  },
  chipRow: {
    gap: 6,
  },
  chipRowLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.6,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    backgroundColor: '#EEF2FF',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    maxWidth: '100%',
  },
  chipPressed: {
    backgroundColor: '#C7D2FE',
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    fontSize: 11,
    color: '#3730A3',
    fontWeight: '600',
  },
  chipRecent: {
    backgroundColor: '#F3F4F6',
    borderColor: '#D1D5DB',
  },
  chipRecentPressed: {
    backgroundColor: '#E5E7EB',
  },
  chipRecentText: {
    color: '#374151',
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 88,
    textAlignVertical: 'top',
    backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: '#111827',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#B91C1C',
    fontSize: 12,
  },
  previewWrapper: {
    gap: 8,
  },
  previewHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  previewLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.8,
  },
  templatePill: {
    backgroundColor: '#EEF2FF',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  templatePillText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#3730A3',
  },
  // Horizontal gallery of preview tiles (small + medium)
  previewGallery: {
    gap: 16,
    paddingVertical: 4,
    paddingRight: 24,
  },
  previewColumn: {
    gap: 6,
  },
  previewSizeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.6,
  },
  // Individual widget tile — white / system-neutral with soft rounded corners
  // and a subtle shadow, mirroring the iOS WidgetKit tile silhouette.
  previewTile: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 10,
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  previewTitleRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  previewTitlePill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    maxWidth: '100%',
  },
  previewTitlePillText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: '#FFFFFF',
  },
  previewMetricBlock: {
    marginTop: 2,
  },
  previewValue: {
    fontWeight: '700',
    color: '#111827',
  },
  previewListHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 4,
    gap: 6,
  },
  previewMetricLabel: {
    fontSize: 10,
    color: '#6B7280',
    marginTop: 1,
  },
  previewTrend: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 1,
  },
  previewTrendFaint: {
    fontSize: 9,
    color: '#9CA3AF',
    marginTop: 1,
  },
  previewSectionTitle: {
    fontSize: 9,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.6,
    marginTop: 6,
  },
  previewItems: {
    marginTop: 3,
    gap: 3,
  },
  previewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  previewItemText: {
    fontSize: 11,
    color: '#111827',
    fontWeight: '600',
  },
  previewItemSubtext: {
    fontSize: 9,
    color: '#6B7280',
    marginTop: 1,
  },
  previewItemAmount: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
    // No maxWidth — amount takes its intrinsic width and the label flex
    // container shrinks to fill the rest (mirrors the widget's fixedSize
    // + layoutPriority contract).
  },
  metaBlock: {
    gap: 2,
  },
  metaTitle: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#6B7280',
  },
  metaTokens: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#6B7280',
  },
  // Modal
  modalRoot: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  modalClose: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  modalClosePressed: {
    backgroundColor: '#E5E7EB',
  },
  modalCloseText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4F46E5',
  },
  modalBody: {
    padding: 20,
    gap: 8,
    paddingBottom: 60,
  },
  capabilitiesLead: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 19,
  },
  capabilitiesSection: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.6,
    marginTop: 12,
  },
  capabilityRow: {
    gap: 3,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 8,
    paddingBottom: 2,
  },
  capabilityTool: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#3730A3',
    fontWeight: '600',
  },
  capabilityTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  capabilityDescription: {
    fontSize: 12,
    color: '#4B5563',
    lineHeight: 17,
  },
  fieldsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  fieldPill: {
    backgroundColor: '#F3F4F6',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  fieldPillText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#374151',
  },
  constraintBody: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 19,
  },
  footerBody: {
    fontSize: 13,
    color: '#312E81',
    lineHeight: 20,
  },
  mono: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#312E81',
  },
});
