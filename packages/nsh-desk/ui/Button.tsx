import { platform, split, Text, type JSX } from "nsh";
import { Button, type ButtonProps } from "nsh/base";
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

export interface DeskButtonProps extends Omit<ButtonProps, "children"> {
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
}

export function DeskButton(props: DeskButtonProps): JSX.Element {
  const [own, rest] = split(props, [
    "label",
    "variant",
    "size",
    "disabled",
    "loading",
    "accessibilityLabel",
    "hitSlop",
    "class",
  ]);
  const isDisabled = () => Boolean(own.disabled || own.loading);
  const size = () => own.size ?? "sm";
  const variant = () => own.variant ?? "outline";

  return (
    <Button
      {...rest}
      disabled={isDisabled()}
      accessibilityLabel={own.accessibilityLabel ?? own.label}
      hitSlop={own.hitSlop ?? 4}
      class={`group flex-row items-center justify-center ${SIZE_CLASSES[size()]} ${VARIANT_CLASSES[variant()]} ${MOTION.buttonTransitionClass} ${FOCUS_RING_CLASS} disabled:opacity-45 ${own.class ?? ""}`}
    >
      <Text
        class={`${TEXT_SIZE_CLASSES[size()]} ${VARIANT_TEXT_CLASSES[variant()]}`}
      >
        {own.label}
      </Text>
    </Button>
  );
}

export interface DeskIconButtonProps extends Omit<ButtonProps, "children"> {
  symbol: string;
  accessibilityLabel: string;
  variant?: ButtonVariant;
  size?: ControlSize;
}

export function DeskIconButton(props: DeskIconButtonProps): JSX.Element {
  const [own, rest] = split(props, [
    "symbol",
    "accessibilityLabel",
    "tooltip",
    "variant",
    "size",
    "hitSlop",
    "class",
  ]);
  const size = () => own.size ?? "sm";
  const variant = () => own.variant ?? "ghost";

  return (
    <Button
      {...rest}
      accessibilityLabel={own.accessibilityLabel}
      tooltip={own.tooltip ?? own.accessibilityLabel}
      hitSlop={own.hitSlop ?? 6}
      class={`group items-center justify-center ${ICON_SIZE_CLASSES[size()]} ${VARIANT_CLASSES[variant()]} ${MOTION.iconButtonTransitionClass} ${FOCUS_RING_CLASS} disabled:opacity-45 ${own.class ?? ""}`}
    >
      <Text
        class={`${TEXT_SIZE_CLASSES[size()]} ${VARIANT_TEXT_CLASSES[variant()]}`}
      >
        {own.symbol}
      </Text>
    </Button>
  );
}
