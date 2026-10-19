"use client";

import dynamic from "next/dynamic";
import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import { useEffect, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useActiveBackgroundJobCount } from "@/lib/background-jobs";
import {
  markKeptNotificationsRead,
  useKeptNotifications,
} from "@/lib/kept-notifications";
import { PANEL_ORIGIN_FALLBACK, originFromTrigger } from "@/lib/floating-panel";

/**
 * The bell lives in every signed-in page; what the panel shows (and its actions, rows and
 * date formatting) is only needed once it opens. Loaded then, and warmed when the pointer or
 * focus reaches the bell, so it is usually there before the click lands.
 */
const loadBody = () => import("@/components/notifications/notifications-panel-body");
const NotificationsPanelBody = dynamic(() => loadBody().then((m) => m.NotificationsPanelBody), {
  ssr: false,
  loading: () => (
    <div className="min-h-[7rem] flex-1 px-3 py-3">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  ),
});

/* -------------------------------------------------------------------------- */
/* Shared panel state                                                         */
/* -------------------------------------------------------------------------- */

// The panel is one slice of the app pulse (`src/lib/app-pulse-store.ts`): one poll per
// tab shared with the desktop-notification and plan-celebration watchers, rather than the
// three separate timers that used to run.
const refreshPanel = (force = false) => refreshPulse(force);

export function NotificationsPanelButton({
  tooltip = false,
}: {
  /**
   * Desktop rail only, mirroring `FeedbackTrigger`. Touch has no hover, so a tooltip on
   * the mobile header copy would be dead weight — the `aria-label` is the accessible name
   * either way.
   */
  tooltip?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  // Captured on click rather than read during render: there are two bells mounted (mobile
  // header and desktop fixed, hidden from each other by CSS), and this resolves to
  // whichever one the user actually pressed.
  const [origin, setOrigin] = useState(PANEL_ORIGIN_FALLBACK);
  const { pulse } = useAppPulse();
  const data = pulse?.panel ?? null;

  useEffect(() => {
    void refreshPanel();
  }, []);

  useEffect(() => {
    if (open) void refreshPanel();
  }, [open]);

  // Opening the panel is what "seen" means here. The entries stay in the list —
  // only the badge stops counting them.
  useEffect(() => {
    if (open) markKeptNotificationsRead();
  }, [open]);

  const activeJobCount = useActiveBackgroundJobCount();
  const kept = useKeptNotifications();
  const unreadKeptCount = useMemo(
    () => kept.filter((entry) => !entry.read).length,
    [kept]
  );
  const dueCount = data?.dueCount ?? 0;
  // Unread missed notifications count toward the badge — that is the whole
  // point of keeping them; a failure nobody saw should say so on the bell.
  // They stop counting once the panel has been opened, but stay in the list.
  const badgeCount = dueCount + activeJobCount + unreadKeptCount;
  const [lastCount, setLastCount] = useState(badgeCount);
  if (badgeCount > 0 && badgeCount !== lastCount) setLastCount(badgeCount);
  const shownCount = badgeCount > 0 ? badgeCount : lastCount;

  const button = (
    <Button
      type="button"
        variant="outline"
        size="icon"
        className={cn(
          "relative size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md transition-opacity hover:bg-background",
          // The open window covers this exact spot, and the glass is see-through enough
          // that the bell would read as a smudge underneath it. Hiding it also sells the
          // illusion that the button became the panel. Opacity rather than `hidden` so it
          // stays focusable for the focus base-ui returns here on close.
          open
            ? "pointer-events-none opacity-0 duration-fast"
            : // Held back until the closing window has almost finished collapsing onto
              // this spot, so the two are never on screen together — the button appears to
              // be what the panel turned back into, rather than something waiting behind it.
              "opacity-100 delay-100 duration-base"
        )}
        aria-label={[
          "Open notifications",
          dueCount + activeJobCount > 0
            ? `${dueCount + activeJobCount} due or in progress`
            : null,
          // Counted separately from the phrase above: a missed failure is not
          // "due", and rolling it into that number would misdescribe it to a
          // screen reader even though the badge shows the two added together.
          unreadKeptCount > 0 ? `${unreadKeptCount} missed` : null,
          data?.alertDot ? "account needs attention" : null,
        ]
          .filter(Boolean)
          .join(", ")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={() => void loadBody()}
        onFocus={() => void loadBody()}
        onClick={(e) => {
          setOrigin(originFromTrigger(e.currentTarget));
          setOpen(true);
        }}
      >
        <Bell className="h-4 w-4" />
        {/* Always mounted so the count can pop OUT as well as in (`.t-badge` in
            globals.css). `shownCount` holds the last non-zero value through the exit, or
            the number would blank to nothing while the badge is still shrinking. */}
        <span
          aria-hidden
          className="t-badge absolute -right-1 -top-1"
          data-open={badgeCount > 0}
        >
          <span className="t-badge-dot flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold text-primary-foreground">
            {shownCount > 99 ? "99+" : shownCount}
          </span>
        </span>
        {/* Opposite corner from the count on purpose: alerts never add to the badge, and a
            dot sharing a corner with a two-digit number would collide with it. */}
        {data?.alertDot && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
          />
        )}
    </Button>
  );

  return (
    <>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent side="left">Notifications</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="floating"
          className="liquid-glass liquid-glass-panel gap-0 p-0"
          style={{ transformOrigin: origin }}
          showCloseButton
        >
          <SheetHeader className="border-b border-border/60 pr-12">
            <SheetTitle className="font-[family-name:var(--font-display)] text-lg text-ink">
              Notifications
            </SheetTitle>
            <SheetDescription>
              What needs your attention right now.
            </SheetDescription>
          </SheetHeader>

          <NotificationsPanelBody onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
