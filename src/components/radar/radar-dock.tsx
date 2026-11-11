"use client";

/**
 * Radar on the dashboard starts as a small card beside the page header. Opening it swaps it
 * for the full morning briefing below the header: the small card steps aside while the big
 * one is up, and the ^ at the big card's top right puts it back. Four pieces share one flag:
 *
 * - `RadarDockProvider` is the page's root element (it renders the `div` itself, so it adds no
 *   wrapper that could disturb the page's `space-y` rhythm).
 * - `RadarWidget` is the small card in the header's corner. It opens the briefing.
 * - `RadarDrawer` wraps the existing briefing and animates it open.
 * - `RadarCollapseButton` sits in the briefing's own header and closes it again.
 *
 * Focus follows the swap for keyboard users: opening moves it to the ^ (the control that just
 * replaced the card they pressed), closing hands it back to the card, so they are never left on
 * something that went away. A mouse click moves nothing: script-driven focus draws the focus
 * ring as if a key had been pressed, a stray outline around a button nobody tabbed to.
 *
 * It starts closed on every visit rather than remembering: a remembered "open" would have to
 * be read after hydration and would slide the panel down over content that had already
 * painted, the layout shift this page has been tuned to avoid.
 *
 * Below `lg` there is no room for a corner card, so the widget is hidden and the drawer is
 * always open: phones and tablets keep the full briefing exactly as before.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Radar } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { briefingHeadline, briefingSubline, type ChangeLine } from "@/lib/radar/briefing";
import { cn } from "@/lib/utils";

const PANEL_ID = "radar-briefing-panel";
/** Lines of "what changed" the small card has room for; the rest are a count. */
const WIDGET_CHANGES = 2;

/**
 * The open flag lives in a tiny store read with `useSyncExternalStore`, not in React state
 * shared through context. The page streams in as separate boundaries that hydrate on their
 * own schedule, so the card in the header can be clicked before the briefing below it has
 * hydrated. A context value would then reach the late boundary as "open" while its server
 * HTML says "closed", and React keeps the server's attribute: both cards end up hidden.
 * The server snapshot below is always "closed", so a late boundary hydrates to match its
 * HTML first and is then brought to the real state.
 */
type Store = { get: () => boolean; set: (v: boolean) => void; subscribe: (l: () => void) => () => void };

function createStore(initial = false): Store {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

type Dock = {
  store: Store;
  /** Takes the click so it can tell a keyboard activation (detail 0) from a pointer one. */
  toggle: (e: MouseEvent<HTMLButtonElement>) => void;
  widgetRef: RefObject<HTMLButtonElement | null>;
  collapseRef: RefObject<HTMLButtonElement | null>;
};

// No provider means nothing to open it from, so the panel just shows, as it always did.
const DEFAULT_STORE = createStore(true);
const DockContext = createContext<Dock>({
  store: DEFAULT_STORE,
  toggle: () => {},
  widgetRef: { current: null },
  collapseRef: { current: null },
});

function useExpanded(): boolean {
  const { store } = useContext(DockContext);
  return useSyncExternalStore(store.subscribe, store.get, () => false);
}

export function RadarDockProvider({ children, className }: { children: ReactNode; className?: string }) {
  const [store] = useState(() => createStore());
  const viaKeyboard = useRef(false);
  const toggle = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Enter and Space reach a button's onClick with detail 0; a real click has detail >= 1.
      viaKeyboard.current = e.detail === 0;
      store.set(!store.get());
    },
    [store]
  );
  const widgetRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const value = useMemo(() => ({ store, toggle, widgetRef, collapseRef }), [store, toggle]);
  const expanded = useSyncExternalStore(store.subscribe, store.get, () => false);

  // Not on first render: nothing has been pressed yet, and stealing focus on load is worse.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!viaKeyboard.current) return;
    // Not synchronously: the control being focused was `invisible` until this very change,
    // and an invisible element refuses focus. It turns visible once its transition has begun,
    // which on a busy first open can be a few frames away, so keep trying briefly. A timer
    // rather than a frame, because a background tab never runs animation frames.
    const target = expanded ? collapseRef : widgetRef;
    let tries = 0;
    const id = window.setInterval(() => {
      const el = target.current;
      el?.focus({ preventScroll: true });
      if (!el || document.activeElement === el || ++tries >= 15) window.clearInterval(id);
    }, 30);
    return () => window.clearInterval(id);
  }, [expanded]);

  return (
    <DockContext.Provider value={value}>
      <div className={className}>{children}</div>
    </DockContext.Provider>
  );
}

export type RadarWidgetProps = {
  /** Today's section on `/radar`. */
  today: number;
  /** Everyone on Radar's list. */
  total: number;
  drafts: number;
  paused: boolean;
  /** The first few people on today's list, for the avatar stack. */
  people: { contactId: string; name: string; avatarUrl?: string | null }[];
  /** What changed overnight, the same lines the big card lists. */
  changes: Pick<ChangeLine, "id" | "contactName" | "label">[];
};

export function RadarWidget({ today, total, drafts, paused, people, changes }: RadarWidgetProps) {
  const { toggle, widgetRef } = useContext(DockContext);
  const expanded = useExpanded();
  const sub = briefingSubline({ drafts, total, today, paused });
  const shown = changes.slice(0, WIDGET_CHANGES);

  return (
    // The wrapper animates the card's room away while the big card is up, so the header row
    // shrinks back to the title instead of keeping a card-sized hole above the briefing. The
    // padding and negative margin give the button's focus ring room inside `overflow-hidden`.
    <div
      className={cn(
        "hidden transition-[grid-template-rows] duration-slow ease-house motion-reduce:transition-none lg:grid",
        expanded ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
      )}
    >
      <div className="-m-1 min-h-0 overflow-hidden p-1">
        <button
          ref={widgetRef}
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={PANEL_ID}
          className={cn(
            "flex w-[24rem] flex-col gap-1 rounded-2xl border border-border/70 bg-card p-3 text-left transition-[opacity,visibility,border-color] duration-base motion-reduce:transition-none",
            // While the big card is up this one is gone, not dimmed: invisible also takes it
            // out of the tab order.
            expanded ? "pointer-events-none invisible opacity-0" : "hover:border-primary/40"
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary uppercase">
              <Radar className="size-3.5" aria-hidden />
              Radar
            </span>
            <span className="flex items-center gap-2">
              {people.length > 0 && (
                <span className="flex -space-x-2" aria-hidden>
                  {people.map((p) => (
                    <ContactAvatar
                      key={p.contactId}
                      contactId={p.contactId}
                      fullName={p.name}
                      profileImageUrl={p.avatarUrl}
                      size="sm"
                      className="ring-2 ring-card"
                    />
                  ))}
                </span>
              )}
              <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
            </span>
          </span>
          <span className="font-[family-name:var(--font-display)] text-lg leading-snug text-ink">
            {briefingHeadline(today)}
          </span>
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
          {shown.length > 0 && (
            <span className="mt-1 flex flex-col gap-0.5 border-t border-border/50 pt-2">
              <span className="flex items-center justify-between text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                What changed overnight
                {changes.length > shown.length && (
                  <span className="font-normal normal-case">+{changes.length - shown.length} more</span>
                )}
              </span>
              {shown.map((c) => (
                <span key={c.id} className="truncate text-xs text-ink/90">
                  <span className="font-medium text-ink">{c.contactName}</span>
                  <span className="text-muted-foreground"> · </span>
                  {c.label}
                </span>
              ))}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

/** The ^ in the big card's top right: hides it and brings the small card back. */
export function RadarCollapseButton() {
  const { toggle, collapseRef } = useContext(DockContext);
  return (
    <button
      ref={collapseRef}
      type="button"
      onClick={toggle}
      aria-expanded
      aria-controls={PANEL_ID}
      aria-label="Collapse Radar"
      title="Collapse"
      className="hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-ink lg:inline-flex"
    >
      <ChevronUp className="size-4" aria-hidden />
    </button>
  );
}

/**
 * The briefing, animated open and shut. Closed it is zero height, gives back the page's
 * `space-y` gap (the margin it would otherwise leave is cancelled, or the closed state would
 * leave a double gap), and is `invisible` so nothing inside it can be tabbed to.
 */
export function RadarDrawer({ children }: { children: ReactNode }) {
  const expanded = useExpanded();
  return (
    <div
      id={PANEL_ID}
      data-open={expanded}
      className="grid transition-[grid-template-rows,margin,visibility] duration-slow ease-house motion-reduce:transition-none lg:grid-rows-[0fr] lg:data-[open=false]:invisible lg:data-[open=false]:mb-0 lg:data-[open=true]:grid-rows-[1fr]"
    >
      {/* `overflow-hidden` is what lets the height animate, and it clips anything drawn outside
          the card's box: the Card's outline is a `ring` (a shadow just outside it), which was
          cut off on all four sides. The padding gives the ring room, and the equal negative
          margin takes that room back so the layout does not move. */}
      <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
    </div>
  );
}
