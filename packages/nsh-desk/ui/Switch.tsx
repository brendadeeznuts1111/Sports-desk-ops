import { platform, Text, type JSX } from "nsh";
import { Switch } from "nsh/base";
import { FOCUS_RING_CLASS } from "./tokens";

const TOUCH_TARGET_CLASS = platform.desktop ? "h-7" : "min-h-11";

export interface DeskSwitchProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  tooltip?: string;
  testID?: string;
  onChange: (checked: boolean) => void;
}

export function DeskSwitch(props: DeskSwitchProps): JSX.Element {
  return (
    <Switch
      testID={props.testID}
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      tooltip={props.tooltip}
      hitSlop={6}
      onChange={({ checked }) => props.onChange(checked)}
      class={`group ${TOUCH_TARGET_CLASS} flex-row items-center gap-2 rounded-(--radius) px-2 hover:bg-accent/60 active:bg-accent ${FOCUS_RING_CLASS} disabled:opacity-45`}
      trackClass="w-8 rounded-full border border-border bg-muted p-0.5 transition-colors duration-150 checked:border-primary checked:bg-primary motion-reduce:transition-none"
      thumbClass="size-3.5 rounded-full bg-background shadow-xs transition-transform duration-150 checked:translate-x-3.5 motion-reduce:transition-none"
    >
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </Switch>
  );
}
