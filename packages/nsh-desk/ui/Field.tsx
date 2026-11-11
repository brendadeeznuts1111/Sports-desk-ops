import { reduceMotion, Scroll, split, Text, View, type JSX } from "nsh";
import {
  Input,
  Select,
  Sheet,
  type InputProps,
  type SelectItem,
  type SelectProps,
  type SheetProps,
} from "nsh/base";
import { DeskButton } from "./Button";
import {
  FOCUS_RING_CLASS,
  POPUP_SURFACE_CLASS,
  SCRIM_BACKDROP_CLASS,
  type ControlSize,
} from "./tokens";

export type { SelectItem };

const INPUT_SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "min-h-6 px-2 py-0.5 text-xs ios:min-h-11 android:min-h-12",
  sm: "min-h-7 px-2.5 py-1 text-xs ios:min-h-11 android:min-h-12",
  md: "min-h-8 px-3 py-1.5 text-xs ios:min-h-11 android:min-h-12",
};

export interface DeskInputProps extends InputProps {
  size?: ControlSize;
  mono?: boolean;
  onChangeText?: (value: string) => void;
  onSubmitText?: (text: string) => void;
}

/**
 * Semantic theme-token text field built on `nsh/base`'s `Input` using `split()`.
 */
export function DeskInput(props: DeskInputProps): JSX.Element {
  const [own, rest] = split(props, [
    "size",
    "mono",
    "class",
    "onChange",
    "onChangeText",
    "onSubmit",
    "onSubmitText",
  ]);
  const size = () => own.size ?? "sm";
  return (
    <Input
      {...rest}
      onChange={(e) => {
        own.onChange?.(e);
        own.onChangeText?.(e.value);
      }}
      onSubmit={(e) => {
        own.onSubmit?.(e);
        own.onSubmitText?.(e.text);
      }}
      class={`rounded-(--radius) border border-input bg-background text-foreground placeholder:text-muted-foreground ${INPUT_SIZE_CLASSES[size()]} ${own.mono ? "font-mono tabular-nums" : ""} ${FOCUS_RING_CLASS} ${own.class ?? ""}`}
    />
  );
}

export interface DeskSelectProps extends Omit<
  SelectProps,
  "trigger" | "onChange"
> {
  label?: string;
  placeholder?: string;
  size?: ControlSize;
  onValueChange: (value: string | null) => void;
}

const SELECT_TRIGGER_SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "min-h-6 px-2 py-0.5 ios:min-h-11 android:min-h-12",
  sm: "min-h-7 px-2.5 py-1 ios:min-h-11 android:min-h-12",
  md: "min-h-8 px-3 py-1.5 ios:min-h-11 android:min-h-12",
};

/**
 * Semantic theme-token `Select` wrapper built on `nsh/base` using `split()`.
 */
export function DeskSelect(props: DeskSelectProps): JSX.Element {
  const [own, rest] = split(props, [
    "label",
    "placeholder",
    "size",
    "items",
    "value",
    "disabled",
    "onValueChange",
  ]);
  const size = () => own.size ?? "sm";
  const selectedTitle = () => {
    const cur = own.value;
    if (cur == null) return own.placeholder ?? "Select…";
    const found = (own.items ?? []).find((it) => it.value === cur);
    return found ? found.title : cur;
  };

  return (
    <Select
      {...rest}
      items={own.items}
      value={own.value}
      disabled={own.disabled}
      onChange={({ value }) => own.onValueChange(value)}
      popupClass={POPUP_SURFACE_CLASS}
      backdropClass={SCRIM_BACKDROP_CLASS}
      listClass="max-h-64"
      groupClass="px-2 py-1 text-xs font-semibold text-muted-foreground"
      searchClass="mb-1 rounded-(--radius-sm) border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
      itemClass="group flex-row items-center justify-between rounded-(--radius-sm) px-2.5 py-1.5 text-xs text-popover-foreground focus:bg-accent focus:text-accent-foreground selected:bg-primary/15 selected:font-semibold selected:text-foreground disabled:opacity-45"
      trigger={
        <View
          class={`flex-row items-center justify-between gap-2 rounded-(--radius) border border-border bg-card transition duration-100 hover:bg-accent active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 ${SELECT_TRIGGER_SIZE_CLASSES[size()]} ${FOCUS_RING_CLASS} disabled:opacity-45`}
        >
          <If when={own.label}>
            <Text class="text-xs text-muted-foreground">{own.label}</Text>
          </If>
          <Text class="font-mono text-xs font-medium text-foreground truncate">
            {selectedTitle()}
          </Text>
          <Text class="text-xs text-muted-foreground">▾</Text>
        </View>
      }
    />
  );
}

export interface DeskSheetProps extends Omit<
  SheetProps,
  "onOpenChange" | "children"
> {
  open: boolean;
  title: string;
  subtitle?: string;
  onOpenChange: (open: boolean) => void;
  children?: JSX.Element;
}

/**
 * Bottom/edge sheet built on `nsh/base`'s `Sheet` using `split()`, supporting
 * downward swipe dismissal on mobile viewports.
 */
export function DeskSheet(props: DeskSheetProps): JSX.Element {
  const [own, rest] = split(props, [
    "open",
    "title",
    "subtitle",
    "side",
    "onOpenChange",
    "children",
  ]);
  return (
    <Sheet
      {...rest}
      open={own.open}
      side={own.side ?? "bottom"}
      closeOnEscape={true}
      closeOnBackdropPress={true}
      closeOnSwipe={!reduceMotion()}
      onOpenChange={({ open }) => own.onOpenChange(open)}
      backdropClass={SCRIM_BACKDROP_CLASS}
      popupClass="max-h-[88%] rounded-t-(--radius-lg) border-t border-border bg-popover shadow-lg"
    >
      <View class="items-center pt-2">
        <View class="h-1 w-9 rounded-full bg-border" />
      </View>
      <View class="flex-row items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <View class="min-w-0 flex-1 gap-0.5">
          <Text
            role="header"
            class="text-sm font-semibold text-popover-foreground truncate"
          >
            {own.title}
          </Text>
          <If when={own.subtitle}>
            <Text class="text-xs text-muted-foreground truncate">
              {own.subtitle}
            </Text>
          </If>
        </View>
        <DeskButton
          label="Done"
          variant="outline"
          size="sm"
          onPress={() => own.onOpenChange(false)}
        />
      </View>
      <Scroll class="min-h-0 flex-1">
        <View class="gap-3 p-4">{own.children}</View>
      </Scroll>
    </Sheet>
  );
}
