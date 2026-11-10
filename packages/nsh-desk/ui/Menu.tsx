import { keymap, platform, Text, View, type JSX } from "nsh";
import { Button, Menu, MenuItem, MenuSeparator } from "nsh/base";
import {
  FOCUS_RING_CLASS,
  MOTION,
  POPUP_ENDING_CLASS,
  POPUP_STARTING_CLASS,
  POPUP_SURFACE_CLASS,
  SCRIM_BACKDROP_CLASS,
} from "./tokens";

const TRIGGER_HEIGHT_CLASS = platform.desktop ? "h-7" : "min-h-11";
const ITEM_HEIGHT_CLASS = platform.desktop ? "min-h-7 py-1.5" : "min-h-11 py-2";

export interface DeskMenuProps {
  label: string;
  accessibilityLabel?: string;
  testID?: string;
  children?: JSX.Element;
}

/**
 * Shared anchored menu surface: popup on desktops with starting/ending transitions,
 * bottom sheet over scrim on touch screens. Trigger uses `aria-expanded:` so it
 * remains visibly active until the popup closes.
 */
export function DeskMenu(props: DeskMenuProps): JSX.Element {
  return (
    <Menu
      offset={4}
      align="end"
      popupClass={`${POPUP_SURFACE_CLASS} ${MOTION.popupTransitionClass}`}
      popupStartingClass={POPUP_STARTING_CLASS}
      popupEndingClass={POPUP_ENDING_CLASS}
      backdropClass={SCRIM_BACKDROP_CLASS}
      trigger={
        <Button
          testID={props.testID}
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          hitSlop={4}
          class={`group ${TRIGGER_HEIGHT_CLASS} flex-row items-center justify-center gap-1.5 rounded-(--radius) border border-border bg-card px-2.5 hover:bg-accent/70 active:bg-accent aria-expanded:border-foreground/35 aria-expanded:bg-accent ${MOTION.buttonTransitionClass} ${FOCUS_RING_CLASS}`}
        >
          <Text class="text-xs font-medium text-card-foreground group-aria-expanded:font-semibold">
            {props.label}
          </Text>
          <Text class="text-xs text-muted-foreground">▾</Text>
        </Button>
      }
    >
      {props.children}
    </Menu>
  );
}

export interface DeskMenuItemProps {
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
  onSelect: () => void;
}

function safeShortcutLabel(shortcut: string | undefined): string {
  if (!shortcut) return "";
  try {
    return keymap.label(shortcut);
  } catch {
    return shortcut;
  }
}

export function DeskMenuItem(props: DeskMenuItemProps): JSX.Element {
  const checkState = () =>
    props.checked === undefined ? undefined : props.checked;

  return (
    <MenuItem
      testID={props.testID}
      checked={checkState()}
      disabled={props.disabled}
      onSelect={props.onSelect}
      indicatorClass="w-4 items-center justify-center"
      indicator={
        <Text class="text-xs font-semibold text-foreground">
          {props.checked ? "✓" : ""}
        </Text>
      }
      class={`group ${ITEM_HEIGHT_CLASS} flex-row items-center justify-between gap-4 rounded-(--radius-sm) px-2.5 transition-colors duration-100 hover:bg-accent active:bg-accent motion-reduce:transition-none ${FOCUS_RING_CLASS} disabled:opacity-45`}
    >
      <View class="flex-1 flex-row items-center justify-between gap-4">
        <Text
          class={
            props.destructive
              ? "text-xs font-medium text-destructive"
              : "text-xs font-medium text-popover-foreground"
          }
        >
          {props.label}
        </Text>
        <If when={props.shortcut}>
          <Text class="font-mono text-xs text-muted-foreground">
            {safeShortcutLabel(props.shortcut)}
          </Text>
        </If>
      </View>
    </MenuItem>
  );
}

export function DeskMenuSeparator(): JSX.Element {
  return <MenuSeparator class="my-1 h-px bg-border" />;
}
