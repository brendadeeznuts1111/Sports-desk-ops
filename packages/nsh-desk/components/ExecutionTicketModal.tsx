import { platform, Text, View, windowSize, type JSX } from "nsh";
import { formatUsd } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  animateUserLayoutChange,
  Badge,
  DeskButton,
  DeskDialog,
  DeskSheet,
  SegmentedTabs,
  Separator,
  SpringBar,
  Surface,
  type SegmentedTabItem,
} from "../ui";

const SIDE_ITEMS: readonly SegmentedTabItem<"yes" | "no">[] = [
  { id: "yes", label: "Buy YES" },
  { id: "no", label: "Sell / Buy NO" },
];

const STYLE_ITEMS: readonly SegmentedTabItem<"auto" | "maker" | "taker">[] = [
  { id: "auto", label: "Auto" },
  { id: "maker", label: "Maker" },
  { id: "taker", label: "Taker" },
];

const STAKE_CHIPS = [100, 250, 500, 1000, 2500] as const;

function TicketBody(props: { store: DeskStore }): JSX.Element {
  const { store } = props;
  const inst = () => store.selectedInstrument();
  const planSnap = () => store.executionPlanSnap();

  const estimatedContracts = () => {
    const cents = Math.max(1, store.ticketLimitCents());
    return Math.max(1, Math.floor((store.ticketStakeUsd() * 100) / cents));
  };

  const dailyCapRatio = () => {
    const p = planSnap();
    if (
      p.status !== "ready" ||
      !p.data.maxDailyUsd ||
      p.data.maxDailyUsd <= 0
    ) {
      return Math.min(1, store.ticketStakeUsd() / 5_000);
    }
    return Math.min(1, store.ticketStakeUsd() / p.data.maxDailyUsd);
  };

  return (
    <View class="gap-3">
      <If when={inst()}>
        {(active) => (
          <Surface variant="inset" class="gap-1">
            <View class="flex-row items-baseline justify-between gap-2">
              <Text class="font-mono text-xs font-semibold text-foreground">
                {`${active().code} · ${active().league}`}
              </Text>
              <Text class="font-mono text-xs tabular-nums text-positive">
                {`Fair ${active().quote.last.toFixed(1)}¢ · Prev ${active().quote.prevClose.toFixed(1)}¢`}
              </Text>
            </View>
            <Text class="text-xs text-muted-foreground truncate">
              {active().name}
            </Text>
          </Surface>
        )}
      </If>

      <Surface variant="inset" class="gap-2">
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <Text class="text-xs font-semibold text-muted-foreground">
            Engine Mode (/api/execution/mode)
          </Text>
          <View class="flex-row items-center gap-1.5">
            <Badge
              label={(() => {
                const p = planSnap();
                return p.status === "ready"
                  ? `MODE · ${p.data.mode.toUpperCase()}`
                  : "MODE · PAPER";
              })()}
              tone={(() => {
                const p = planSnap();
                return p.status === "ready" && p.data.mode === "paused"
                  ? "warning"
                  : "positive";
              })()}
            />
            <DeskButton
              testID="ticket-mode-paper"
              label="Set Paper"
              size="xs"
              variant="outline"
              disabled={store.ticketBusy()}
              onPress={() => {
                void store.setExecutionModeAction("paper");
              }}
            />
            <DeskButton
              testID="ticket-mode-paused"
              label="Pause"
              size="xs"
              variant="outline"
              disabled={store.ticketBusy()}
              onPress={() => {
                void store.setExecutionModeAction("paused");
              }}
            />
          </View>
        </View>
        <If when={planSnap().status === "unavailable"}>
          <Text class="font-mono text-xs text-warning">
            {(() => {
              const p = planSnap();
              return p.status === "unavailable" ? p.cause : "";
            })()}
          </Text>
        </If>
      </Surface>

      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <SegmentedTabs
          accessibilityLabel="Order side"
          items={SIDE_ITEMS}
          value={store.ticketSide()}
          onChange={(s) => store.setTicketSide(s)}
        />
        <SegmentedTabs
          accessibilityLabel="Execution style"
          items={STYLE_ITEMS}
          value={store.ticketStyle()}
          onChange={(st) => store.setTicketStyle(st)}
        />
      </View>

      <Surface variant="card" class="gap-2.5">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-xs font-medium text-muted-foreground">
            Limit price (cents)
          </Text>
          <View class="flex-row items-center gap-1.5">
            <DeskButton
              testID="ticket-limit-minus"
              label="−"
              size="xs"
              variant="outline"
              accessibilityLabel="Decrease limit price"
              onPress={() => store.stepTicketLimitCents(-1)}
            />
            <Text class="w-16 text-center font-mono text-sm font-semibold tabular-nums text-foreground">
              {`${store.ticketLimitCents()}¢`}
            </Text>
            <DeskButton
              testID="ticket-limit-plus"
              label="+"
              size="xs"
              variant="outline"
              accessibilityLabel="Increase limit price"
              onPress={() => store.stepTicketLimitCents(1)}
            />
          </View>
        </View>

        <Separator />

        <View class="gap-1.5">
          <View class="flex-row items-baseline justify-between">
            <Text class="text-xs font-medium text-muted-foreground">
              Notional stake (paper USD)
            </Text>
            <Text class="font-mono text-sm font-semibold tabular-nums text-foreground">
              {`${formatUsd(store.ticketStakeUsd())} · ~${estimatedContracts()} contracts`}
            </Text>
          </View>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={STAKE_CHIPS} key={(amt) => String(amt)}>
              {(amt) => (
                <DeskButton
                  label={formatUsd(amt())}
                  size="xs"
                  variant="outline"
                  selected={store.ticketStakeUsd() === amt()}
                  onPress={() => store.setTicketStakeUsd(amt())}
                />
              )}
            </Each>
          </View>
        </View>

        <View class="gap-1">
          <View class="flex-row items-baseline justify-between">
            <Text class="text-xs text-muted-foreground">
              Daily risk cap utilization
            </Text>
            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
              {`${Math.round(dailyCapRatio() * 100)}%`}
            </Text>
          </View>
          <SpringBar
            ratio={dailyCapRatio()}
            tone={dailyCapRatio() > 0.75 ? "warning" : "primary"}
          />
        </View>
      </Surface>

      <If
        when={store.ticketReviewOpen()}
        else={
          <DeskButton
            testID="ticket-review-btn"
            label="Review Paper Order"
            variant="primary"
            onPress={() => {
              animateUserLayoutChange();
              store.setTicketReviewOpen(true);
            }}
          />
        }
      >
        <Surface variant="inset" class="gap-2">
          <View class="flex-row items-center justify-between">
            <Badge label="LIMIT · PAPER" tone="positive" />
            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
              POST /api/execution/run
            </Text>
          </View>
          <Text class="font-mono text-xs tabular-nums text-foreground">
            {`${store.ticketSide().toUpperCase()} ~${estimatedContracts()} contracts @ ${store.ticketLimitCents()}¢ (${formatUsd(store.ticketStakeUsd())} · style=${store.ticketStyle()})`}
          </Text>
          <View class="flex-row items-center justify-end gap-2">
            <DeskButton
              label="Back"
              size="sm"
              variant="outline"
              onPress={() => {
                animateUserLayoutChange();
                store.setTicketReviewOpen(false);
              }}
            />
            <DeskButton
              testID="ticket-execute-btn"
              label={store.ticketBusy() ? "Executing…" : "Execute Paper Fill"}
              size="sm"
              variant="primary"
              loading={store.ticketBusy()}
              onPress={() => {
                void store.submitPaperExecution();
              }}
            />
          </View>
        </Surface>
      </If>
    </View>
  );
}

/**
 * Responsive order ticket modeled on NSH Gallery `Stocks` `Ticket.tsx`:
 * renders as a `DeskDialog` on desktop and a swipe-dismissable `DeskSheet` on compact mobile.
 */
export function ExecutionTicketModal(
  props: { store?: DeskStore } = {},
): JSX.Element {
  const store = useDeskStore(props.store);
  const compact = () => !platform.desktop || windowSize().width < 680;

  return (
    <If
      when={compact()}
      else={
        <DeskDialog
          testID="execution-ticket-dialog"
          open={store.ticketOpen()}
          onOpenChange={(open) => store.setTicketOpen(open)}
          title="Execution Ticket — Paper Venue"
          subtitle="Evaluates /api/execution/plan risk gates and dispatches paper-only fills."
        >
          <TicketBody store={store} />
        </DeskDialog>
      }
    >
      <DeskSheet
        testID="execution-ticket-sheet"
        open={store.ticketOpen()}
        onOpenChange={(open) => store.setTicketOpen(open)}
        title="Execution Ticket — Paper Venue"
        subtitle="Swipe down or press Done to dismiss."
      >
        <TicketBody store={store} />
      </DeskSheet>
    </If>
  );
}
