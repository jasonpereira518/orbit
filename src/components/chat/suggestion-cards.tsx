"use client";

/**
 * The row of suggested questions under the composer.
 *
 * Presentation only: it holds no state and fetches nothing, so the chat panel and the
 * floating ask bar can render the same suggestions at the two sizes their layouts allow —
 * cards on `/chat`, pills in the bar's `w-80` popover.
 *
 * The card treatment is `StatCard`'s (dashboard-sections.tsx) and the entrance is the
 * `.reveal-mount` cascade the contact timeline uses, capped the same way.
 */

import {
  Bell,
  Clock,
  MessageSquare,
  Sparkles,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

import { interactionTypeIcon } from "@/lib/interaction-types";
import type { ChatSuggestion, SuggestionKind } from "@/lib/chat-suggestions";
import { cn } from "@/lib/utils";

/** Fixed, so the row's height never depends on what the rules happened to produce. */
const CARD_BOX = "h-[4.5rem] w-56 shrink-0 rounded-xl";
/** globals.css caps the cascade around 240ms; 30ms x 8 is the house step. */
const STAGGER_STEP_MS = 30;
const STAGGER_LIMIT = 8;

const ICON_FOR: Record<Exclude<SuggestionKind, "recent_interaction">, LucideIcon> = {
  overdue: Bell,
  company_cluster: Users,
  gone_quiet: Clock,
  asked_about: MessageSquare,
  new_contact: UserRound,
  generic: Sparkles,
};

function iconFor(s: ChatSuggestion): LucideIcon {
  // A recent interaction shows its own type's glyph — a coffee cup, a phone — which says
  // more about why the card is there than any generic mark could.
  if (s.kind === "recent_interaction") return interactionTypeIcon(s.interactionType);
  return ICON_FOR[s.kind];
}

function revealDelay(i: number) {
  return { "--reveal-delay": `${Math.min(i, STAGGER_LIMIT) * STAGGER_STEP_MS}ms` } as React.CSSProperties;
}

/**
 * The scroller.
 *
 * The trailing fade is a `mask-image`, not an overlay: an overlay would need a colour to
 * fade to, and the composer sits on `bg-card`, which inverts between themes.
 */
function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="chat-suggestions"
      className={cn(
        "-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-2rem),transparent_100%)]",
      )}
    >
      {children}
    </div>
  );
}

export function SuggestionCards({
  items,
  disabled,
  onPick,
}: {
  items: readonly ChatSuggestion[];
  disabled?: boolean;
  onPick: (suggestion: ChatSuggestion) => void;
}) {
  if (!items.length) return null;
  return (
    <Scroller>
      {items.map((s, i) => {
        const Icon = iconFor(s);
        return (
          <button
            key={s.id}
            type="button"
            disabled={disabled}
            style={revealDelay(i)}
            onClick={() => onPick(s)}
            className={cn(
              "reveal-mount flex items-start gap-2 border border-border/70 bg-card/80 p-2.5 text-left",
              CARD_BOX,
              "transition-[border-color,box-shadow,background-color]",
              "hover:border-primary/30 hover:bg-card hover:shadow-md",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              "disabled:opacity-50",
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              {/* `text-ink`, not `text-primary`: primary is an accent that flips hue between
                  themes, so a title in it turns saturated blue in dark mode. */}
              <span className="line-clamp-2 block text-xs font-medium text-ink">
                {s.question}
              </span>
              {s.basis && (
                <span className="mt-0.5 line-clamp-1 block text-[11px] text-muted-foreground">
                  {s.basis}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </Scroller>
  );
}

/**
 * Placeholders while the suggestions load.
 *
 * Same boxes as the real cards, so the footer's height is identical before and after the
 * fetch and the message list above never resizes.
 */
export function SuggestionCardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Scroller>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden
          className={cn("animate-pulse border border-border/40 bg-muted/50", CARD_BOX)}
        />
      ))}
    </Scroller>
  );
}

/**
 * The same suggestions as pills, for the floating ask bar.
 *
 * Its popover is `w-80` inside a 48vh cap — too narrow for a card — so the reason line is
 * dropped and only the question shows. Deliberately the same markup the bar's hardcoded
 * chips used, so nothing about that surface changes except where the strings come from.
 */
export function SuggestionPills({
  items,
  disabled,
  onPick,
}: {
  items: readonly ChatSuggestion[];
  disabled?: boolean;
  onPick: (suggestion: ChatSuggestion) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={disabled}
          title={s.basis || undefined}
          onClick={() => onPick(s)}
          className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {s.question}
        </button>
      ))}
    </div>
  );
}
