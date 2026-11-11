import { platform, split, Text, type JSX } from "nsh";
import { Switch, type SwitchProps } from "nsh/base";
import { FOCUS_RING_CLASS } from "./tokens";

const TOUCH_TARGET_CLASS = platform.desktop ? "h-7" : "min-h-11";

export interface DeskSwitchProps extends Omit<
  SwitchProps,
  "children" | "onChange" | "checked"
> {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function DeskSwitch(props: DeskSwitchProps): JSX.Element {
  const [own, rest] = split(props, [
    "label",
    "accessibilityLabel",
    "hitSlop",
    "onChange",
    "class",
    "trackClass",
    "thumbClass",
  ]);
  return (
    <Switch
      {...rest}
      accessibilityLabel={own.accessibilityLabel ?? own.label}
      hitSlop={own.hitSlop ?? 6}
      onChange={({ checked }) => own.onChange(checked)}
      class={`group ${TOUCH_TARGET_CLASS} flex-row items-center gap-2 rounded-(--radius) px-2 hover:bg-accent/60 active:bg-accent ${FOCUS_RING_CLASS} disabled:opacity-45 ${own.class ?? ""}`}
      trackClass={
        own.trackClass ??
        "w-8 rounded-full border border-border bg-muted p-0.5 transition-colors duration-150 checked:border-primary checked:bg-primary motion-reduce:transition-none"
      }
      thumbClass={
        own.thumbClass ??
        "size-3.5 rounded-full bg-background shadow-xs transition-transform duration-150 checked:translate-x-3.5 motion-reduce:transition-none"
      }
    >
      <Text class="text-xs font-medium text-foreground">{own.label}</Text>
    </Switch>
  );
}
