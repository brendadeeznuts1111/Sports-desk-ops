import { reduceMotion, Scroll, Text, View, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { DeskButton } from "./Button";
import { SCRIM_BACKDROP_CLASS } from "./tokens";

export interface DeskDialogProps {
  open: boolean;
  title: string;
  subtitle?: string;
  testID?: string;
  onOpenChange: (open: boolean) => void;
  children?: JSX.Element;
}

export function DeskDialog(props: DeskDialogProps): JSX.Element {
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation={reduceMotion() ? "none" : "fade"}
      closeOnEscape={true}
      closeOnBackdropPress={true}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      backdropClass={SCRIM_BACKDROP_CLASS}
      class="m-auto h-[84%] max-h-[640px] w-[92%] max-w-2xl overflow-hidden rounded-(--radius-lg) border border-border bg-popover shadow-lg"
    >
      <View class="flex-row items-center justify-between gap-3 border-b border-border px-4 py-3">
        <View class="flex-1 gap-0.5">
          <Text
            role="header"
            class="text-sm font-semibold text-popover-foreground"
          >
            {props.title}
          </Text>
          <If when={props.subtitle}>
            <Text class="text-xs text-muted-foreground">{props.subtitle}</Text>
          </If>
        </View>
        <DeskButton
          label="Done"
          variant="outline"
          size="sm"
          onPress={() => props.onOpenChange(false)}
        />
      </View>
      <Scroll class="min-h-0 flex-1">
        <View class="gap-4 p-4">{props.children}</View>
      </Scroll>
    </Dialog>
  );
}
