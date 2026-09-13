"use client";

/**
 * The review deck: one person at a time, the next one peeking out from behind.
 *
 * Three ways to decide, all landing in the same `decide()`: drag the header band past
 * the threshold (motion's `drag="x"`, started from the band only so a pointer-down in a
 * field never moves the card), the buttons under the card, or the arrow keys. Every
 * decision is written to the server as it is made; the deck itself keeps only the
 * per-card drafts (what you edited) and the animation state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion, useTransform, type PanInfo } from "motion/react";
import { ArrowLeft, Check, Clock, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DecisionStamp } from "@/components/capture/review/decision-stamp";
import { PersonCardBody, type PersonDraft } from "@/components/capture/review/person-card";
import { PlanetBadge } from "@/components/capture/review/planet-badge";
import { clampCloseness } from "@/lib/capture/closeness";
import { planetForIndex } from "@/lib/capture/planets";
import { defaultMergeId, parseTagNames, peopleDecisions } from "@/lib/capture/review-reducer";
import type { BulkNotePersonPreview, CaptureDecision, CaptureDecisionKind, CaptureDecisions } from "@/lib/capture/types";
import { useCornerClearanceAbove } from "@/lib/corner-clearance";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

const COMMIT_DISTANCE = 120;
const COMMIT_VELOCITY = 600;

export function draftFromItem(item: BulkNotePersonPreview, decision: CaptureDecision | undefined, preferredContactId?: string | null): PersonDraft {
  const edits = decision?.edits ?? {};
  return {
    fields: {
      name: edits.name ?? item.parsed.name ?? "",
      company: edits.company ?? item.parsed.company ?? "",
      role: edits.role ?? item.parsed.role ?? "",
      metAt: edits.metAt ?? item.parsed.met_at ?? "",
      tags: (decision?.tagNames?.length ? decision.tagNames : item.parsed.tags ?? []).join(", "),
      summary: edits.summary ?? item.parsed.summary ?? "",
    },
    mergeContactId: decision ? decision.mergeContactId : defaultMergeId(item, preferredContactId),
    closeness: clampCloseness(decision?.relationshipScore ?? item.parsed.relationship_score_suggestion),
  };
}

export function decisionFromDraft(kind: CaptureDecisionKind, index: number, draft: PersonDraft): CaptureDecision {
  return {
    decision: kind,
    index,
    mergeContactId: draft.mergeContactId,
    relationshipScore: draft.closeness,
    tagNames: parseTagNames(draft.fields.tags),
    edits: {
      name: draft.fields.name.trim() || null,
      company: draft.fields.company.trim() || null,
      role: draft.fields.role.trim() || null,
      metAt: draft.fields.metAt.trim() || null,
      summary: draft.fields.summary.trim() || null,
    },
    decidedAt: new Date().toISOString(),
  };
}

type Custom = { dir: 1 | -1; leaving: CaptureDecisionKind | "back"; reduced: boolean };
type Leaving = { key: string; kind: CaptureDecisionKind } | null;

const cardVariants = {
  enter: ({ dir, reduced }: Custom) =>
    reduced ? { opacity: 0, x: 0, rotate: 0, y: 0, scale: 1 } : { opacity: 0, x: dir >= 0 ? 48 : -48, rotate: dir >= 0 ? 1.5 : -1.5, y: 0, scale: 1 },
  center: { opacity: 1, x: 0, rotate: 0, y: 0, scale: 1 },
  // Reduced motion: a crossfade. MotionConfig would otherwise apply the fly-out's transform
  // instantly (a 520px teleport) while only the opacity eased.
  exit: ({ leaving, reduced }: Custom) =>
    reduced
      ? { opacity: 0 }
      : leaving === "accept"
        ? { opacity: 0, x: 520, rotate: 14 }
        : leaving === "reject"
          ? { opacity: 0, x: -520, rotate: -14 }
          : leaving === "skip"
            ? { opacity: 0, y: 56, scale: 0.96 }
            : { opacity: 0, x: 56, rotate: 2 },
};

export function PersonDeck({
  items,
  decisions,
  index,
  preferredContactId,
  lockedName,
  onDecide,
  onBack,
  onStartOver,
}: {
  items: BulkNotePersonPreview[];
  decisions: CaptureDecisions;
  /** The current card. Derived by the flow from the decisions, so a reload lands here too. */
  index: number;
  preferredContactId?: string | null;
  lockedName?: string | null;
  onDecide: (key: string, decision: CaptureDecision) => void;
  /** Reopen the previous card (its decision is cleared). */
  onBack: (key: string) => void;
  /** Abandon the whole capture. */
  onStartOver?: () => void;
}) {
  const people = peopleDecisions(decisions);
  const [drafts, setDrafts] = useState<Record<string, PersonDraft>>({});
  const reduced = useReducedMotion() ?? false;
  const [custom, setCustom] = useState<Custom>({ dir: 1, leaving: "back", reduced });
  /** The card whose stamp is forced on for its fly-out — only that card, never the next. */
  const [leaving, setLeaving] = useState<Leaving>(null);
  const [announce, setAnnounce] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const actionRowRef = useRef<HTMLDivElement>(null);
  useCornerClearanceAbove(actionRowRef, true);

  const current = items[index] ?? null;
  const next = items[index + 1] ?? null;
  const previousDecided = useMemo(() => {
    for (let i = index - 1; i >= 0; i--) if (people[items[i]!.key]) return i;
    return -1;
  }, [index, items, people]);

  const draftFor = useCallback(
    (item: BulkNotePersonPreview) => drafts[item.key] ?? draftFromItem(item, people[item.key], preferredContactId),
    [drafts, people, preferredContactId]
  );

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [index]);

  const decide = useCallback(
    (kind: CaptureDecisionKind) => {
      if (!current) return;
      const draft = draftFor(current);
      setCustom({ dir: 1, leaving: kind, reduced });
      // Two renders on purpose: first the stamp lands on THIS card, then the card leaves.
      // Done in one render, AnimatePresence would keep the card's previous props (no stamp)
      // for the fly-out.
      setLeaving({ key: current.key, kind });
      const name = draft.fields.name.trim() || "This person";
      const verb = kind === "accept" ? "kept" : kind === "reject" ? "set aside" : "left for later";
      setAnnounce(next ? `${name} ${verb}. Next: ${next.parsed.name || "Unnamed person"}, ${index + 2} of ${items.length}.` : `${name} ${verb}. That was the last card.`);
      const decision = decisionFromDraft(kind, index, draft);
      window.setTimeout(() => onDecide(current.key, decision), 40);
    },
    [current, draftFor, index, items.length, next, onDecide]
  );

  const back = useCallback(() => {
    if (previousDecided < 0) return;
    setCustom({ dir: -1, leaving: "back", reduced });
    const prev = items[previousDecided]!;
    setAnnounce(`Back to ${prev.parsed.name || "the previous person"}, ${previousDecided + 1} of ${items.length}.`);
    onBack(prev.key);
  }, [items, onBack, previousDecided]);


  function onKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "ArrowRight") decide("accept");
    else if (e.key === "ArrowLeft") decide("reject");
    else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") decide("skip");
    else if (e.key === "Backspace" || e.key.toLowerCase() === "z") back();
    else return;
    e.preventDefault();
  }

  if (!current) return null;
  const planet = planetForIndex(index);

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="space-y-3 outline-none">
      {/* Progress: one segment per card, the current one in its planet's colour. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-1 gap-1" aria-hidden>
          {items.map((it, i) => {
            const d = people[it.key]?.decision;
            return (
              <span
                key={it.key}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  d === "accept" && "bg-primary",
                  d === "reject" && "bg-destructive/50",
                  d === "skip" && "bg-muted-foreground/30",
                  !d && i !== index && "bg-muted",
                  !d && i === index && "bg-foreground/60"
                )}
                style={i === index ? { background: planet.glow.replace(/[\d.]+\)$/, "1)") } : undefined}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={previousDecided < 0} onClick={back}>
            <Undo2 className="size-3.5" /> Back
          </Button>
          {onStartOver && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onStartOver}>
              Start over
            </Button>
          )}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div className="relative">
        {next && (
          <motion.div
            key={`peek-${next.key}`}
            aria-hidden
            inert
            initial={{ opacity: 0, scale: 0.94, y: 14 }}
            animate={{ opacity: 0.85, scale: 0.96, y: 10 }}
            transition={SPRING_PILL}
            className="pointer-events-none absolute inset-x-0 top-0 z-0 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"
          >
            <div className="flex items-center gap-3 pr-16">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Up next</p>
                <p className="truncate font-[family-name:var(--font-display)] text-xl text-ink">{next.parsed.name || "Unnamed person"}</p>
              </div>
            </div>
            <PlanetBadge index={index + 1} size="sm" className="absolute right-5 top-4 opacity-80" />
          </motion.div>
        )}

        <AnimatePresence initial={false} custom={custom} mode="popLayout">
          <DeckCard
            key={current.key}
            item={current}
            index={index}
            total={items.length}
            custom={custom}
            leaving={leaving?.key === current.key ? leaving.kind : null}
            draft={draftFor(current)}
            onDraft={(patch) => setDrafts((prev) => ({ ...prev, [current.key]: { ...draftFor(current), ...patch } }))}
            lockedName={lockedName}
            onSwipe={decide}
          />
        </AnimatePresence>
      </div>

      {/*
        The three actions. Sticky on phones so a long card never hides them — parked just
        above the fixed bottom nav (the shell's mobile tab bar is ~4rem tall plus the safe
        area), not at the viewport edge where the nav would cover it.
      */}
      <div
        ref={actionRowRef}
        className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 -mx-4 flex items-center justify-center gap-3 rounded-2xl border border-border/60 bg-card/95 px-4 py-3 shadow-lg backdrop-blur md:static md:mx-0 md:rounded-none md:border-0 md:bg-transparent md:py-1 md:shadow-none md:backdrop-blur-none"
      >
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-label="Not this person"
          title="Not this person (←)"
          className="size-12 rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => decide("reject")}
        >
          <X className="size-5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" title="Decide later (↓)" onClick={() => decide("skip")}>
          <Clock className="size-3.5" /> Later
        </Button>
        <Button
          type="button"
          size="icon-lg"
          aria-label="Keep this person"
          title="Keep (→)"
          className="size-14 rounded-full bg-primary text-primary-foreground shadow-md hover:bg-primary/90"
          onClick={() => decide("accept")}
        >
          <Check className="size-6" />
        </Button>
      </div>
      <p className="hidden text-center text-[11px] text-muted-foreground md:block">
        <ArrowLeft className="inline size-3" /> not now · <span className="font-medium">→</span> keep · <span className="font-medium">↓</span> later · drag the name to swipe
      </p>
    </div>
  );
}

/**
 * One card in the deck, with its own drag state. Per card on purpose: a MotionValue shared
 * between the card flying out and the card sliding in makes the two fight, and the exit
 * never completes.
 */
function DeckCard({
  item,
  index,
  total,
  custom,
  leaving,
  draft,
  onDraft,
  lockedName,
  onSwipe,
}: {
  item: BulkNotePersonPreview;
  index: number;
  total: number;
  custom: Custom;
  leaving: CaptureDecisionKind | null;
  draft: PersonDraft;
  onDraft: (patch: Partial<PersonDraft>) => void;
  lockedName?: string | null;
  onSwipe: (kind: CaptureDecisionKind) => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-8, 8]);
  const keepOpacity = useTransform(x, [40, 140], [0, 1]);
  const notNowOpacity = useTransform(x, [-140, -40], [1, 0]);
  const controls = useDragControls();

  function onDragEnd(_: unknown, info: PanInfo) {
    const past = Math.abs(info.offset.x) > COMMIT_DISTANCE || Math.abs(info.velocity.x) > COMMIT_VELOCITY;
    if (!past) return;
    onSwipe(info.offset.x > 0 || info.velocity.x > 0 ? "accept" : "reject");
  }

  return (
    <motion.div
      role="group"
      aria-roledescription="review card"
      aria-label={`${index + 1} of ${total}: ${item.parsed.name || "Unnamed person"}`}
      data-leaving={leaving ?? undefined}
      custom={custom}
      variants={cardVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
      drag={leaving ? false : "x"}
      dragListener={false}
      dragControls={controls}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      dragMomentum={false}
      onDragEnd={onDragEnd}
      style={{ x, rotate, touchAction: "pan-y" }}
      className="relative z-10 rounded-2xl border border-border/70 bg-card p-5 shadow-md sm:p-6"
    >
      <DecisionStamp kind="accept" side="left" opacity={leaving === "accept" ? 1 : keepOpacity} />
      <DecisionStamp kind="reject" side="right" opacity={leaving === "reject" ? 1 : notNowOpacity} />
      {leaving === "skip" && <DecisionStamp kind="skip" side="center" opacity={1} />}
      <PersonCardBody
        item={item}
        index={index}
        total={total}
        draft={draft}
        onDraft={onDraft}
        lockedName={lockedName}
        idPrefix={`card-${index}`}
        handleProps={{ onPointerDown: (e) => controls.start(e) }}
      />
    </motion.div>
  );
}
