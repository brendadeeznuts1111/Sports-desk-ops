import { computed, signal, Text, View, type JSX } from "nsh";
import { useDeskStore, type DeskStore } from "../store";
import {
  createPanelReadyMotion,
  DeskXmlOddsTable,
  StateNotice,
  Surface,
} from "../ui";
import {
  readXmlOddsRow,
  xmlOddsFeedCount,
  xmlOddsUnknownLineCount,
  type XmlOddsFeed,
} from "../xml_odds_view";

export function XmlOddsPanel(props: { store?: DeskStore } = {}): JSX.Element {
  const store = useDeskStore(props.store);
  const readyMotion = createPanelReadyMotion();
  const selectedIndex = signal<number | null>(null);

  let memoFeed: XmlOddsFeed | null | undefined;
  let memoRevision = -1;
  let memoCount = 0;
  // The loader publishes whole new columns per snapshot, but `revision` is still
  // the generation marker (hydration can refill one set in place): both key the count.
  const feedCount = (): number => {
    const feed = store.xmlOddsFeed();
    const revision = store.xmlOddsRevision();
    if (memoFeed !== feed || memoRevision !== revision) {
      memoFeed = feed;
      memoRevision = revision;
      memoCount = xmlOddsFeedCount(feed);
    }
    return memoCount;
  };

  const selectedRow = computed(() => {
    const feed = store.xmlOddsFeed();
    const count = feedCount();
    const index = selectedIndex();
    if (feed === null || index === null || index < 0 || index >= count) {
      return null;
    }
    return readXmlOddsRow(feed, index);
  });

  const snapStatus = (): string => store.xmlOddsSnap().status;

  const unavailableDetail = (): string => {
    const snap = store.xmlOddsSnap();
    if (snap.status !== "unavailable") return "";
    return `${snap.code} — ${snap.cause}`;
  };

  const provenanceLine = (): string => {
    const snap = store.xmlOddsSnap();
    if (snap.status !== "ready") return "";
    const { basis, generatedAt, watermarkCursor, rowCount, stale } = snap.data;
    const base = `${basis} · ${generatedAt} · watermark ${watermarkCursor} · ${rowCount} ${rowCount === 1 ? "row" : "rows"}${stale ? " · stale (last good snapshot; refresh failed)" : ""}`;
    const unknown = xmlOddsUnknownLineCount(store.xmlOddsFeed());
    if (unknown === 0) return base;
    // The row-level phrase: an unknown line is not rendered as a number anywhere.
    return `${base} · Line unavailable (unit unconfirmed)`;
  };

  return (
    <Surface variant="panel" class="min-h-0 flex-1">
      <If
        when={snapStatus() === "ready"}
        else={
          <If
            when={snapStatus() === "loading"}
            else={
              <StateNotice
                kind="unavailable"
                title="XML odds feed unavailable"
                detail={unavailableDetail()}
                actionLabel="Retry"
                onAction={() => {
                  void store.refreshAll();
                }}
              />
            }
          >
            <StateNotice
              kind="loading"
              title="Loading XML odds feed"
              detail="Reading the published R2 snapshot through /api/xml-odds/soa."
            />
          </If>
        }
      >
        <View style={readyMotion.style} class="min-h-0 flex-1 gap-2.5 p-3">
          <Text class="min-w-0 truncate font-mono text-xs tabular-nums text-muted-foreground">
            {provenanceLine()}
          </Text>

          <If when={selectedRow()}>
            {(row) => (
              <Surface variant="inset" class="gap-1">
                <Text class="text-xs font-semibold text-foreground">
                  {`Event #${row().eventId}`}
                </Text>
                <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                  {row().lineKnown
                    ? `Combo key ${row().comboKey} · Line ${row().line} (${row().lineHundredths} hundredths)`
                    : `Combo key ${row().comboKey} · Line unavailable (unit unconfirmed)`}
                </Text>
              </Surface>
            )}
          </If>

          <DeskXmlOddsTable
            feed={store.xmlOddsFeed()}
            revision={store.xmlOddsRevision()}
            onRowSelect={(index) => selectedIndex.set(index)}
          />
        </View>
      </If>
    </Surface>
  );
}
