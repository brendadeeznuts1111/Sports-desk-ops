import { platform, Text, type JSX } from "nsh";
import { Button } from "nsh/base";
import { FOCUS_RING_CLASS, MOTION, type ControlSize } from "./tokens";

export type ButtonVariant =
  "default" | "primary" | "outline" | "ghost" | "danger";

const TOUCH_TARGET_CLASS = platform.desktop ? "" : "min-h-11";
const TOUCH_ICON_CLASS = platform.desktop ? "" : "min-h-11 min-w-11";

const SIZE_CLASSES: Record<ControlSize, string> = {
  xs: `h-6 gap-1 rounded-(--radius-sm) px-2 ${TOUCH_TARGET_CLASS}`,
  sm: `h-7 gap-1.5 rounded-(--radius) px-2.5 ${TOUCH_TARGET_CLASS}`,
  md: `h-8 gap-2 rounded-(--radius) px-3 ${TOUCH_TARGET_CLASS}`,
};

const ICON_SIZE_CLASSES: Record<ControlSize, string> = {
  xs: `size-6 rounded-(--radius-sm) ${TOUCH_ICON_CLASS}`,
  sm: `size-7 rounded-(--radius) ${TOUCH_ICON_CLASS}`,
  md: `size-8 rounded-(--radius) ${TOUCH_ICON_CLASS}`,
};

const TEXT_SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "text-xs font-medium",
  sm: "text-xs font-medium",
  md: "text-sm font-medium",
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default:
    "border border-border bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent selected:border-foreground/30 selected:bg-accent aria-expanded:border-foreground/30 aria-expanded:bg-accent",
  primary:
    "border border-primary bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 selected:bg-primary/90 aria-expanded:bg-primary/90",
  outline:
    "border border-border bg-card text-card-foreground hover:bg-accent/70 active:bg-accent selected:border-foreground/35 selected:bg-accent aria-expanded:border-foreground/35 aria-expanded:bg-accent",
  ghost:
    "border border-transparent bg-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground active:bg-accent selected:bg-accent selected:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
  danger:
    "border border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
};

const VARIANT_TEXT_CLASSES: Record<ButtonVariant, string> = {
  default: "text-secondary-foreground",
  primary: "text-primary-foreground",
  outline: "text-card-foreground group-selected:font-semibold",
  ghost:
    "text-muted-foreground group-hover:text-foreground group-selected:font-semibold group-selected:text-foreground",
  danger: "text-destructive-foreground",
};

export interface DeskButtonProps {
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  selected?: boolean;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  tooltip?: string;
  testID?: string;
  class?: string;
  onPress?: () => void;
}

export function DeskButton(props: DeskButtonProps): JSX.Element {
  const isDisabled = () => Boolean(props.disabled || props.loading);
  const size = () => props.size ?? "sm";
  const variant = () => props.variant ?? "outline";

  return (
    <Button
      testID={props.testID}
      selected={props.selected}
      disabled={isDisabled()}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      tooltip={props.tooltip}
      hitSlop={4}
      onPress={props.onPress}
      class={`group flex-row items-center justify-center ${SIZE_CLASSES[size()]} ${VARIANT_CLASSES[variant()]} ${MOTION.buttonTransitionClass} ${FOCUS_RING_CLASS} disabled:opacity-45 ${props.class ?? ""}`}
    >
      <Text
        class={`${TEXT_SIZE_CLASSES[size()]} ${VARIANT_TEXT_CLASSES[variant()]}`}
      >
        {props.label}
      </Text>
    </Button>
  );
}

export interface DeskIconButtonProps {
  symbol: string;
  accessibilityLabel: string;
  tooltip?: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  selected?: boolean;
  disabled?: boolean;
  testID?: string;
  onPress?: () => void;
}

export function DeskIconButton(props: DeskIconButtonProps): JSX.Element {
  const size = () => props.size ?? "sm";
  const variant = () => props.variant ?? "ghost";

  return (
    <Button
      testID={props.testID}
      selected={props.selected}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel}
      tooltip={props.tooltip ?? props.accessibilityLabel}
      hitSlop={6}
      onPress={props.onPress}
      class={`group items-center justify-center ${ICON_SIZE_CLASSES[size()]} ${VARIANT_CLASSES[variant()]} ${MOTION.iconButtonTransitionClass} ${FOCUS_RING_CLASS} disabled:opacity-45`}
    >
      <Text
        class={`${TEXT_SIZE_CLASSES[size()]} ${VARIANT_TEXT_CLASSES[variant()]}`}
      >
        {props.symbol}
      </Text>
    </Button>
  );
}
