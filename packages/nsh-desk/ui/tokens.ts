import { createMotion, LayoutAnimation, reduceMotion } from "nsh";

export type ControlSize = "xs" | "sm" | "md";

export const MOTION = {
  instant: 100,
  fast: 150,
  base: 200,
  slow: 300,
  buttonTransitionClass:
    "transition duration-100 ease-out active:duration-150 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  iconButtonTransitionClass:
    "transition duration-100 ease-out active:duration-150 active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100",
  popupTransitionClass:
    "transition duration-150 ease-out motion-reduce:transition-none",
} as const;

export const FOCUS_RING_CLASS =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export const POPUP_SURFACE_CLASS =
  "min-w-52 rounded-(--radius) border border-border bg-popover p-1 shadow-lg";

export const POPUP_STARTING_CLASS =
  "opacity-0 scale-95 -translate-y-1 motion-reduce:opacity-100 motion-reduce:scale-100 motion-reduce:translate-y-0";

export const POPUP_ENDING_CLASS =
  "opacity-0 scale-95 -translate-y-1 motion-reduce:opacity-100 motion-reduce:scale-100 motion-reduce:translate-y-0";

export const SCRIM_BACKDROP_CLASS = "bg-foreground/30 dark:bg-background/70";

/**
 * Animates layout changes initiated directly by a user command (dock toggle,
 * layout reset). Never call on window resize or background data ticks.
 */
export function animateUserLayoutChange(): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext(
    LayoutAnimation.create(MOTION.base, "easeInEaseOut", "opacity"),
  );
}

/**
 * Component-owned entrance fade for panel content transitioning from initial
 * loading into ready state. Honors reduceMotion natively.
 */
export function createPanelReadyMotion() {
  return createMotion({ enter: "fadeIn", duration: MOTION.fast });
}
