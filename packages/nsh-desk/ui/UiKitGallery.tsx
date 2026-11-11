import { colorScheme, setColorScheme, signal, Text, View, type JSX } from "nsh";
import { DeskButton, DeskIconButton } from "./Button";
import { DeskDialog } from "./Dialog";
import { DeskInput, DeskSelect } from "./Field";
import { SegmentedTabs, type SegmentedTabItem } from "./SegmentedTabs";
import {
  DayRangeBar,
  LiveDot,
  SparklineCanvas,
  SpringBar,
  StatGrid,
} from "./StockPrimitives";
import {
  Badge,
  SectionHeader,
  Separator,
  StateNotice,
  Surface,
} from "./Surface";
import { DeskSwitch } from "./Switch";

type AppearanceChoice = "system" | "light" | "dark";

const APPEARANCE_ITEMS: readonly SegmentedTabItem<AppearanceChoice>[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const DEMO_TABS: readonly SegmentedTabItem<"signals" | "kpis" | "sinks">[] = [
  { id: "signals", label: "Signals" },
  { id: "kpis", label: "KPIs" },
  { id: "sinks", label: "Sinks" },
];

const DEMO_SELECT_ITEMS = [
  { value: "auto", title: "Source: auto" },
  { value: "file", title: "Source: file" },
  { value: "live", title: "Source: live" },
];

const DEMO_STATS = [
  { label: "Open", value: "44.2¢" },
  { label: "Prev close", value: "42.3¢" },
  { label: "Avg price", value: "45.1¢" },
  { label: "Amplitude", value: "9.9%" },
  { label: "Volume", value: "2 accts" },
  { label: "Turnover", value: "$27.7K", tone: "positive" as const },
  { label: "Book high", value: "48.6¢" },
  { label: "Book low", value: "41.8¢" },
];

/**
 * Interactive showcase of every `packages/nsh-desk/ui/` control across its
 * variants, sizes, and states in both Light and Dark appearances, per
 * `nsh-design-guides` ("The app's `ui` layer" -> "Show it").
 */
export function UiKitGalleryDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const appearance = signal<AppearanceChoice>("system");
  const sampleSwitch = signal(true);
  const sampleTab = signal<"signals" | "kpis" | "sinks">("signals");
  const sampleInput = signal("BILLY666");
  const sampleSource = signal<string>("auto");
  const splitPressDownCount = signal(0);

  const applyAppearance = (next: AppearanceChoice) => {
    appearance.set(next);
    setColorScheme(next);
  };

  return (
    <DeskDialog
      testID="ui-kit-dialog"
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Sportsdesk UI kit"
      subtitle="Semantic tokens, variants, sizes, and states across Light and Dark appearances."
    >
      <Surface variant="inset" class="gap-2">
        <SectionHeader
          title="Appearance preview"
          trailing={`active: ${colorScheme()}`}
        />
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <Text class="text-xs text-muted-foreground">
            Switch theme appearance to inspect semantic token contrast live.
          </Text>
          <SegmentedTabs
            accessibilityLabel="Theme appearance"
            items={APPEARANCE_ITEMS}
            value={appearance()}
            onChange={applyAppearance}
          />
        </View>
      </Surface>

      <View class="gap-2">
        <SectionHeader title="Buttons — variants & states" />
        <View class="flex-row flex-wrap items-center gap-2">
          <DeskButton label="Primary" variant="primary" onPress={() => {}} />
          <DeskButton label="Default" variant="default" onPress={() => {}} />
          <DeskButton label="Outline" variant="outline" onPress={() => {}} />
          <DeskButton label="Ghost" variant="ghost" onPress={() => {}} />
          <DeskButton label="Danger" variant="danger" onPress={() => {}} />
          <DeskButton
            label="Selected"
            variant="outline"
            selected={true}
            onPress={() => {}}
          />
          <DeskButton
            label="Disabled"
            variant="outline"
            disabled={true}
            onPress={() => {}}
          />
          <DeskIconButton
            symbol="↻"
            accessibilityLabel="Sample icon action"
            variant="outline"
            onPress={() => {}}
          />
          <DeskButton
            testID="ui-kit-split-probe"
            label={`Split probe (${splitPressDownCount()})`}
            variant="outline"
            selected={splitPressDownCount() > 0}
            onPressDown={() => splitPressDownCount.update((n) => n + 1)}
            onPress={() => {}}
          />
        </View>
      </View>

      <View class="gap-2">
        <SectionHeader title="Buttons — size scale (xs / sm / md)" />
        <View class="flex-row flex-wrap items-center gap-2">
          <DeskButton label="Size xs" size="xs" onPress={() => {}} />
          <DeskButton label="Size sm" size="sm" onPress={() => {}} />
          <DeskButton label="Size md" size="md" onPress={() => {}} />
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Inputs, Select, Switch & sliding segmented tabs" />
        <View class="flex-row flex-wrap items-center gap-2.5">
          <DeskInput
            accessibilityLabel="Sample agent search input"
            value={sampleInput()}
            placeholder="Agent ID…"
            mono={true}
            class="w-40"
            onChangeText={(next) => sampleInput.set(next)}
          />
          <DeskSelect
            accessibilityLabel="Sample source select"
            items={DEMO_SELECT_ITEMS}
            value={sampleSource()}
            onValueChange={(next) => {
              if (next !== null) sampleSource.set(next);
            }}
          />
          <DeskSwitch
            label={sampleSwitch() ? "Sample toggle: on" : "Sample toggle: off"}
            checked={sampleSwitch()}
            onChange={(next) => sampleSwitch.set(next)}
          />
          <SegmentedTabs
            accessibilityLabel="Sample segmented tabs"
            items={DEMO_TABS}
            value={sampleTab()}
            onChange={(next) => sampleTab.set(next)}
          />
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Stocks terminal primitives (Canvas + Spring)" />
        <Surface variant="card" class="gap-3">
          <View class="flex-row items-center justify-between gap-3">
            <View class="flex-row items-center gap-2">
              <LiveDot live={sampleSwitch()} />
              <Text class="font-mono text-xs font-semibold text-foreground">
                NBA·LAL@BOS · 46.5¢ (+4.2¢)
              </Text>
            </View>
            <SparklineCanvas
              values={[42.3, 43.1, 42.8, 44.6, 45.2, 46.5]}
              prevClose={42.3}
              live={sampleSwitch()}
            />
          </View>
          <DayRangeBar
            low={41.8}
            high={48.6}
            prevClose={42.3}
            last={46.5}
            formatValue={(v) => `${v.toFixed(1)}¢`}
          />
          <View class="flex-row items-center gap-2">
            <SpringBar
              ratio={0.64}
              from="right"
              tone="positive"
              class="flex-1"
            />
            <SpringBar
              ratio={0.36}
              from="left"
              tone="negative"
              class="flex-1"
            />
          </View>
          <StatGrid items={DEMO_STATS} />
        </Surface>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Semantic status badges (text + token)" />
        <View class="flex-row flex-wrap items-center gap-2">
          <Badge label="NEUTRAL · FIXTURE" tone="neutral" />
          <Badge label="LIVE · 12s" tone="positive" />
          <Badge label="DATA-STALE · #78" tone="warning" />
          <Badge label="HTTP 503 · UNAUTHORIZED" tone="danger" />
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Surfaces & state notices" />
        <Surface variant="card" class="gap-2">
          <Text class="text-xs font-medium text-card-foreground">
            Card surface — concentric outer (8pt) and inner (6pt) radii
          </Text>
          <Surface variant="inset">
            <StateNotice
              kind="unavailable"
              title="Sample unavailable endpoint"
              detail="/api/live-bets/summary HTTP 503 [unauthorized]: missing F402 bearer"
            />
          </Surface>
        </Surface>
      </View>
    </DeskDialog>
  );
}
