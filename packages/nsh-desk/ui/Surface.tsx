import { split, Text, View, type JSX, type ViewProps } from "nsh";
import { DeskButton } from "./Button";

export type SurfaceVariant = "panel" | "card" | "inset";

const SURFACE_CLASSES: Record<SurfaceVariant, string> = {
  panel: "bg-background",
  card: "rounded-(--radius-lg) border border-border bg-card p-3",
  inset: "rounded-(--radius) border border-border/80 bg-muted/40 p-2.5",
};

export interface SurfaceProps extends ViewProps {
  variant?: SurfaceVariant;
}

export function Surface(props: SurfaceProps): JSX.Element {
  const [own, rest] = split(props, ["variant", "class", "children"]);
  const variant = () => own.variant ?? "card";
  return (
    <View {...rest} class={`${SURFACE_CLASSES[variant()]} ${own.class ?? ""}`}>
      {own.children}
    </View>
  );
}

export type BadgeTone = "neutral" | "positive" | "warning" | "danger";

const BADGE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  positive: "border-positive/35 bg-positive/12 text-positive",
  warning: "border-warning/40 bg-warning/15 text-warning",
  danger: "border-destructive/40 bg-destructive/12 text-destructive",
};

const BADGE_TEXT_CLASSES: Record<BadgeTone, string> = {
  neutral: "font-mono text-xs font-medium text-muted-foreground",
  positive: "font-mono text-xs font-semibold text-positive",
  warning: "font-mono text-xs font-semibold text-warning",
  danger: "font-mono text-xs font-semibold text-destructive",
};

export interface BadgeProps extends Omit<ViewProps, "children"> {
  label: string;
  tone?: BadgeTone;
}

/**
 * Compact status/provenance badge. Always carries explicit text (never color alone).
 */
export function Badge(props: BadgeProps): JSX.Element {
  const [own, rest] = split(props, ["label", "tone", "class"]);
  const tone = () => own.tone ?? "neutral";
  return (
    <View
      {...rest}
      class={`flex-row items-center rounded-(--radius-sm) border px-1.5 py-0.5 ${BADGE_CLASSES[tone()]} ${own.class ?? ""}`}
    >
      <Text class={BADGE_TEXT_CLASSES[tone()]}>{own.label}</Text>
    </View>
  );
}

export function SectionHeader(props: {
  title: string;
  trailing?: string;
}): JSX.Element {
  return (
    <View class="flex-row items-baseline justify-between gap-2">
      <Text role="header" class="text-xs font-semibold text-muted-foreground">
        {props.title}
      </Text>
      <If when={props.trailing}>
        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
          {props.trailing}
        </Text>
      </If>
    </View>
  );
}

export function Separator(): JSX.Element {
  return <View class="h-px bg-border" />;
}

export type NoticeKind = "loading" | "empty" | "unavailable";

/**
 * Consistent loading, empty, and error state presentation with optional
 * recovery action ("Start from the task" & "Interface language").
 */
export function StateNotice(props: {
  kind: NoticeKind;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <View class="flex-1 items-start justify-center gap-2 p-4">
      <View class="flex-row items-center gap-2">
        <Badge
          label={
            props.kind === "loading"
              ? "LOADING"
              : props.kind === "empty"
                ? "EMPTY"
                : "UNAVAILABLE"
          }
          tone={props.kind === "unavailable" ? "danger" : "neutral"}
        />
        <Text
          role="header"
          class={
            props.kind === "unavailable"
              ? "text-sm font-semibold text-destructive"
              : "text-sm font-semibold text-foreground"
          }
        >
          {props.title}
        </Text>
      </View>
      <If when={props.detail}>
        <Text class="font-mono text-xs text-muted-foreground">
          {props.detail}
        </Text>
      </If>
      <If when={props.actionLabel && props.onAction}>
        <DeskButton
          label={props.actionLabel ?? "Refresh"}
          variant="outline"
          size="sm"
          onPress={props.onAction}
        />
      </If>
    </View>
  );
}
