"use client";

import { forwardRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TourStop } from "@/lib/tour/tour-stops";
import { cn } from "@/lib/utils";

export type CoachRailProps = {
  stop: TourStop;
  index: number;
  total: number;
  /** The stop's predicate is met (or it has none). */
  done: boolean;
  /** The stop's control is not on this screen; copy stands in. */
  missing: boolean;
  /**
   * The person wandered off the stop's page: offer the way back rather than fight them. `message` replaces "This stop lives on …" when there is nowhere
   * specific to send them; `canGo` hides the button when it would go where they already are.
   */
  offRoute: { page: string; message?: string; canGo: boolean } | null;
  pending: boolean;
  /** The guide cursor is about to do this stop's click itself (a harmless step). */
  cursorWillClick?: boolean;
  onBack: (() => void) | null;
  onNext: () => void;
  onGoThere: () => void;
  onExit: () => void;
  /** The finish card replaces the stop copy on the last stop. */
  finish?: ReactNode;
};

/**
 * The coach rail: a floating glass card on desktop, a collapsible panel above the tab bar
 * on phones. Both variants are always rendered and CSS picks one (`md:hidden` /
 * `hidden md:block`), because a hook that reads the viewport is empty for one render and
 * would leave the person with no rail at all on that frame.
 *
 * It floats rather than pushing content: Tailwind breakpoints are viewport-based, so a
 * rail that took 20rem from the content column would break every `md:`/`lg:` layout
 * between 768 and 1279px.
 */
export const CoachRail = forwardRef<
  HTMLDivElement,
  CoachRailProps & {
    desktopStyle: React.CSSProperties;
    flipped: boolean;
    /** Desktop: shrunk to a one-line pill because the card would sit on the anchor. */
    collapsed: boolean;
    onToggleCollapsed: () => void;
    phoneRef: React.Ref<HTMLDivElement>;
  }
>(function CoachRail(
  {
    desktopStyle,
    flipped,
    collapsed: desktopCollapsed,
    onToggleCollapsed,
    phoneRef,
    ...props
  },
  desktopRef,
) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <>
      {/* Positioning and glass live on different elements on purpose: `.liquid-glass` is
          unlayered CSS that sets `position: relative`, which would beat the `fixed` utility
          and drop the card into the page flow beside the sidebar. */}
      <div
        ref={desktopRef}
        role="complementary"
        aria-label="Guided tour"
        data-tour-rail
        tabIndex={-1}
        style={desktopStyle}
        className={cn(
          "fixed bottom-5 z-[60] hidden outline-none md:block",
          flipped && "right-5",
        )}
      >
        <div
          className={cn(
            "liquid-glass flex max-h-[min(60vh,32rem)] flex-col overflow-y-auto rounded-2xl",
            desktopCollapsed ? "w-auto max-w-[24rem] p-1.5" : "w-[20rem] p-4",
          )}
        >
          {desktopCollapsed && !props.finish ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                aria-expanded={false}
                onClick={onToggleCollapsed}
              >
                <span className="tabular-nums text-muted-foreground">
                  {props.index + 1}/{props.total}
                </span>
                <span className="min-w-0 truncate font-medium text-ink">
                  {props.stop.title}
                </span>
                <ChevronUp
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </button>
              <Button
                type="button"
                size="sm"
                disabled={props.pending}
                onClick={props.onNext}
              >
                {props.index === props.total - 1
                  ? "Finish"
                  : props.stop.doneWhen && !props.done
                    ? "Skip this"
                    : "Next"}
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </div>
          ) : (
            <RailBody
              {...props}
              onCollapse={props.finish ? undefined : onToggleCollapsed}
            />
          )}
        </div>
      </div>

      <div
        ref={phoneRef}
        role="complementary"
        aria-label="Guided tour"
        data-tour-rail
        tabIndex={-1}
        className={cn(
          "fixed inset-x-3 z-[45] outline-none md:hidden",
          "bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]",
        )}
      >
        <div className="liquid-glass rounded-2xl">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <span className="min-w-0 truncate text-sm">
              <span className="tabular-nums text-muted-foreground">
                {props.index + 1} of {props.total}
              </span>
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium text-ink">{props.stop.title}</span>
            </span>
            {collapsed ? (
              <ChevronUp
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            ) : (
              <ChevronDown
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            )}
          </button>
          {!collapsed && (
            <div className="max-h-[50vh] overflow-y-auto px-4 pb-4">
              <RailBody {...props} compact />
            </div>
          )}
        </div>
      </div>
    </>
  );
});

function RailBody({
  stop,
  index,
  total,
  done,
  missing,
  offRoute,
  pending,
  cursorWillClick,
  onBack,
  onNext,
  onGoThere,
  onExit,
  finish,
  compact,
  onCollapse,
}: CoachRailProps & { compact?: boolean; onCollapse?: () => void }) {
  const [confirmExit, setConfirmExit] = useState(false);
  const last = index === total - 1;
  const predicate = stop.doneWhen != null;

  return (
    <div className="relative flex flex-col gap-3">
      {!compact && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Stop {index + 1} of {total}
          </p>
          <div className="-mr-1 -mt-1 flex items-center">
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Shrink the tour card"
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronDown className="size-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmExit(true)}
              aria-label="Exit the tour"
              className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {finish ? (
        finish
      ) : (
        <>
          {!compact && (
            <h2 className="font-[family-name:var(--font-display)] text-xl leading-tight text-ink">
              {stop.title}
            </h2>
          )}
          <p className="text-sm text-muted-foreground text-pretty">
            {stop.body}
          </p>
          {offRoute ? (
            <div className="rounded-xl border border-border/70 bg-card/70 p-3 text-sm">
              <p className="text-foreground">
                {offRoute.message ?? (
                  <>
                    This stop lives on{" "}
                    <span className="font-medium">{offRoute.page}</span>.
                  </>
                )}
              </p>
              {offRoute.canGo && (
                <Button
                  type="button"
                  size="sm"
                  className="mt-2"
                  onClick={onGoThere}
                >
                  Take me there
                  <ArrowRight className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
          ) : (
            <>
              {stop.tryThis && (
                <p className="text-sm text-foreground">
                  <span className="font-medium text-primary">Try this → </span>
                  {stop.tryThis}
                </p>
              )}
              {cursorWillClick && (
                <p className="text-xs text-muted-foreground">
                  Orbit will do this one for you, or do it yourself.
                </p>
              )}
              {/* Under the instruction, not instead of it: the person still needs to know
                  what to do once they find it. */}
              {missing && (
                <p className="text-xs text-muted-foreground">
                  {stop.missingHint ?? "It isn’t on this screen right now."}
                </p>
              )}
            </>
          )}
          {predicate && stop.doneLabel && (
            <p
              className={cn(
                "flex items-center gap-2 text-xs",
                done ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border",
                  done
                    ? "border-tier-lifetime/50 bg-tier-lifetime/10 text-tier-lifetime"
                    : "border-border/80",
                )}
                aria-hidden
              >
                {done && <Check className="size-3" strokeWidth={3} />}
              </span>
              {done ? stop.doneLabel.done : stop.doneLabel.pending}
            </p>
          )}
        </>
      )}

      {!finish && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <Pips index={index} total={total} />
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!onBack || pending}
              onClick={() => onBack?.()}
              aria-label="Previous stop"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={onNext}>
              {last ? "Finish" : predicate && !done ? "Skip this" : "Next"}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {compact && !finish && (
        <button
          type="button"
          onClick={() => setConfirmExit(true)}
          className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Exit the tour
        </button>
      )}

      {confirmExit && (
        <div
          role="alertdialog"
          aria-label="Exit the tour?"
          className="absolute inset-0 z-10 flex flex-col justify-center gap-3 rounded-xl bg-card/95 p-3 text-sm backdrop-blur-sm"
        >
          <p className="text-foreground">
            Exit for now? The example people are removed; resume any time from
            your dashboard.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={onExit}
            >
              Exit tour
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmExit(false)}
            >
              Keep going
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Pips({ index, total }: { index: number; total: number }) {
  return (
    <ol className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <li
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-[width,background-color] duration-300",
            i === index
              ? "w-4 bg-primary"
              : i < index
                ? "w-1.5 bg-primary/50"
                : "w-1.5 bg-muted-foreground/25",
          )}
        />
      ))}
    </ol>
  );
}
