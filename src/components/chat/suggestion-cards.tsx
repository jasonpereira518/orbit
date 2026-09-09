"use client";

/**
 * The row of suggested questions under the composer.
 *
 * Presentation only: it holds no state and fetches nothing, so the chat panel and the
 * floating ask bar can render the same suggestions at the two sizes their layouts allow.
 *
 * One line each, with the reason on hover. The reason is what makes a personalised
 * suggestion feel earned rather than random, but on a permanently visible row it was
 * paying for that with a second line of height — and the composer footer is `shrink-0`
 * above a message list with no floor, so every pixel it takes comes out of the answers.
 * A tooltip keeps the reason and gives the height back.
 */

import {
  Bell,
  Clock,
  Handshake,
  Link2,
  MessageSquare,
  Sparkles,
  Target,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { interactionTypeIcon } from "@/lib/interaction-types";
import type { ChatSuggestion, SuggestionKind } from "@/lib/chat-suggestions";
import { cn } from "@/lib/utils";

/**
 * Fixed height, intrinsic width.
 *
 * The height is the contract — the row must measure the same before and after the fetch,
 * or the message list above it resizes when data lands. The width is free because the row
 * scrolls: uniform boxes would pad a three-word question out to the size of a long one.
 */
const PILL_BOX = "h-8 shrink-0 rounded-full";
/**
 * A ceiling, not a target.
 *
 * The row scrolls, so width is not scarce and nothing here needs to be uniform — this only
 * stops one pathological question (a contact whose "name" is a pasted headline) from
 * running the full width of the composer. Every generic and every ordinary personalised
 * question fits well inside it; the longest generic measures 272px against this 352.
 */
const PILL_MAX_W = "max-w-[22rem]";
/** globals.css caps the cascade around 240ms; 30ms x 8 is the house step. */
const STAGGER_STEP_MS = 30;
const STAGGER_LIMIT = 8;

const ICON_FOR: Record<Exclude<SuggestionKind, "recent_interaction">, LucideIcon> = {
  overdue: Bell,
  commitment: Handshake,
  company_cluster: Users,
  // Two people, one question — the only card that attaches a pair.
  mention: Link2,
  gone_quiet: Clock,
  asked_about: MessageSquare,
  goal_match: Target,
  new_contact: UserRound,
  // The cold-start tier borrows the icon of the rung it stands in for, so the row does not
  // announce which tier it came from.
  starter_company: Users,
  newest_contact: UserRound,
  generic: Sparkles,
};

function iconFor(s: ChatSuggestion): LucideIcon {
  // A recent interaction shows its own type's glyph — a coffee cup, a phone — which says
  // more about why the card is there than any generic mark could.
  if (s.kind === "recent_interaction") return interactionTypeIcon(s.interactionType);
  return ICON_FOR[s.kind];
}

function revealDelay(i: number) {
  return {
    "--reveal-delay": `${Math.min(i, STAGGER_LIMIT) * STAGGER_STEP_MS}ms`,
  } as React.CSSProperties;
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
        "-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-2rem),transparent_100%)]",
      )}
    >
      {children}
    </div>
  );
}

const PILL_CLASS = cn(
  "reveal-mount inline-flex items-center gap-1.5 border border-border/70 bg-card/80 px-3 text-left",
  PILL_BOX,
  PILL_MAX_W,
  "transition-[border-color,box-shadow,background-color]",
  "hover:border-primary/30 hover:bg-card hover:shadow-sm",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
  "disabled:opacity-50",
);

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
    // One provider for the row, so moving between pills does not re-pay the open delay.
    <TooltipProvider>
      <Scroller>
        {items.map((s, i) => {
          const Icon = iconFor(s);
          // Both branches must hand the scroller the *button* as its flex item. Wrapping
          // the untooltipped ones in a span put an element without `shrink-0` in the row,
          // so those pills would squash under width pressure while their neighbours held.
          const pill = (key?: string) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              style={revealDelay(i)}
              onClick={() => onPick(s)}
              className={PILL_CLASS}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {/* `text-ink`, not `text-primary`: primary is an accent that flips hue
                  between themes, so a label in it turns saturated blue in dark mode. */}
              <span className="truncate text-xs font-medium text-ink">{s.question}</span>
            </button>
          );

          // A generic suggestion has no reason to give — it is what shows when nothing
          // specific fired — so it gets no tooltip rather than an invented one.
          if (!s.basis) return pill(s.id);

          return (
            <Tooltip key={s.id}>
              <TooltipTrigger render={pill()} />
              <TooltipContent>{s.basis}</TooltipContent>
            </Tooltip>
          );
        })}
      </Scroller>
    </TooltipProvider>
  );
}

/**
 * Placeholders while the suggestions load.
 *
 * Same height as the real pills, so the footer measures identically before and after the
 * fetch and the message list above never resizes. Widths are hand-varied the way the rest
 * of `page-skeletons.tsx` varies them — a row of identical boxes reads as a loading bar.
 */
const SKELETON_WIDTHS = ["w-52", "w-44", "w-56"];

export function SuggestionCardsSkeleton() {
  return (
    <Scroller>
      {SKELETON_WIDTHS.map((w) => (
        <div
          key={w}
          aria-hidden
          className={cn("animate-pulse border border-border/40 bg-muted/50", PILL_BOX, w)}
        />
      ))}
    </Scroller>
  );
}

/**
 * The same suggestions as plain pills, for the floating ask bar.
 *
 * Its popover is `w-80` inside a 48vh cap, so this variant wraps instead of scrolling and
 * the caller caps how many it shows. No tooltip: a tooltip inside a popover has to escape
 * two stacking contexts to be read, and the bar is a transient surface people type in
 * rather than browse. The reason rides on `title` instead, which costs nothing.
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
          className="max-w-full truncate rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {s.question}
        </button>
      ))}
    </div>
  );
}
