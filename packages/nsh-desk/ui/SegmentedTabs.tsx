import { Text, View, type JSX } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { FOCUS_RING_CLASS } from "./tokens";

export interface SegmentedTabItem<T extends string = string> {
  id: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedTabsProps<T extends string = string> {
  items: readonly SegmentedTabItem<T>[];
  value: T;
  accessibilityLabel?: string;
  onChange: (next: T) => void;
}

/**
 * Segmented selection control built on `nsh/base`'s `Tabs` + `Tab`:
 * - WAI-ARIA tablist keyboard behavior (single Tab stop, Left/Right/Home/End)
 * - One native spring-sliding indicator (`indicatorClass`) that snaps immediately
 *   when `reduceMotion` is enabled.
 */
export function SegmentedTabs<T extends string = string>(
  props: SegmentedTabsProps<T>,
): JSX.Element {
  return (
    <View role="group" accessibilityLabel={props.accessibilityLabel}>
      <Tabs
        class="flex-row items-center gap-0.5 rounded-(--radius-lg) border border-border bg-muted p-0.5"
        indicatorClass="inset-y-0.5 rounded-(--radius-sm) border border-border/70 bg-card shadow-xs"
      >
        <Each of={props.items} key={(item) => item.id}>
          {(item) => (
            <Tab
              selected={props.value === item().id}
              disabled={item().disabled}
              accessibilityLabel={item().label}
              onPress={() => props.onChange(item().id)}
              class={`group min-h-6 items-center justify-center rounded-(--radius-sm) px-2.5 py-0.5 ios:min-h-10 android:min-h-11 transition duration-100 hover:bg-accent/50 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 ${FOCUS_RING_CLASS} disabled:opacity-45`}
            >
              <Text class="text-xs font-medium text-muted-foreground group-hover:text-foreground group-selected:font-semibold group-selected:text-foreground">
                {item().label}
              </Text>
            </Tab>
          )}
        </Each>
      </Tabs>
    </View>
  );
}
