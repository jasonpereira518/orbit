"use client";

/**
 * Radar on the dashboard starts as a small card beside the page header and opens into the
 * full morning briefing below it. Three pieces share one open/closed flag:
 *
 * - `RadarDockProvider` is the page's root element (it renders the `div` itself, so it adds no
 *   wrapper that could disturb the page's `space-y` rhythm).
 * - `RadarWidget` is the card in the header's corner. It is the only control: it opens and
 *   closes the panel.
 * - `RadarDrawer` wraps the existing briefing and animates it open.
 *
 * It starts closed on every visit rather than remembering: a remembered "open" would have to
 * be read after hydration and would slide the panel down over content that had already
 * painted, the layout shift this page has been tuned to avoid.
 *
 * Below `lg` there is no room for a corner card, so the widget is hidden and the drawer is
 * always open: phones and tablets keep the full briefing exactly as before.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Radar } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { cn } from "@/lib/utils";

const PANEL_ID = "radar-briefing-panel";

type Dock = { expanded: boolean; toggle: () => void };

// No provider means nothing to open it from, so the panel just shows, as it always did.
const DockContext = createContext<Dock>({ expanded: true, toggle: () => {} });

export function RadarDockProvider({ children, className }: { children: ReactNode; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const value = useMemo(() => ({ expanded, toggle }), [expanded, toggle]);
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
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function RadarWidget({ today, total, drafts, paused, people }: RadarWidgetProps) {
  const { expanded, toggle } = useContext(DockContext);
  const headline = today > 0 ? `${plural(today, "person", "people")} worth a message today` : "All clear today";
  const sub =
    drafts > 0
      ? `${plural(drafts, "draft", "drafts")} ready`
      : paused
        ? "Radar is paused"
        : total > today
          ? `${total - today} more queued`
          : null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={expanded}
      aria-controls={PANEL_ID}
      className={cn(
        "hidden w-[22rem] shrink-0 flex-col gap-2 rounded-2xl border bg-card p-3.5 text-left transition-colors lg:flex",
        expanded ? "border-primary" : "border-border/70 hover:border-primary/40"
      )}
    >
      <span className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary uppercase">
          <Radar className="size-3.5" aria-hidden />
          Radar
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-base motion-reduce:transition-none",
            expanded && "rotate-180 text-primary"
          )}
          aria-hidden
        />
      </span>
      <span className="font-[family-name:var(--font-display)] text-lg leading-snug text-ink">{headline}</span>
      {(people.length > 0 || sub) && (
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
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        </span>
      )}
    </button>
  );
}

/**
 * The briefing, animated open and shut. Closed it is zero height, gives back the page's
 * `space-y` gap (the margin it would otherwise leave is cancelled, or the closed state would
 * leave a double gap), and is `invisible` so nothing inside it can be tabbed to.
 */
export function RadarDrawer({ children }: { children: ReactNode }) {
  const { expanded } = useContext(DockContext);
  return (
    <div
      id={PANEL_ID}
      data-open={expanded}
      className="grid transition-[grid-template-rows,margin,visibility] duration-slow ease-house motion-reduce:transition-none lg:grid-rows-[0fr] lg:data-[open=false]:invisible lg:data-[open=false]:mb-0 lg:data-[open=true]:grid-rows-[1fr]"
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
