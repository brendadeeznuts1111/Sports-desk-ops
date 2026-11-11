import { colorScheme, setColorScheme, signal, Text, View, type JSX } from "nsh";
import { DeskButton, DeskIconButton } from "./Button";
import { DeskDialog } from "./Dialog";
import { SegmentedTabs, type SegmentedTabItem } from "./SegmentedTabs";
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
        <SectionHeader title="Switch & sliding segmented tabs" />
        <View class="flex-row flex-wrap items-center justify-between gap-3">
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
