"use client";

import { useState } from "react";
import Link from "next/link";
import {
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "motion/react";
import type { ParsedNote } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type SwipeDecision = "accepted" | "discarded";

export type CaptureReviewItem = {
  key: string;
  notes: string;
  parsed: ParsedNote;
  duplicates: Array<{
    id: string;
    fullName: string;
    company: string | null;
    title: string | null;
    reason: string;
    confidence: number;
  }>;
  suggestedMergeId: string | null;
  sharedNoteTexts: string[];
  interactionDate: string | null;
  interactionType: string | null;
  decision: "pending" | "accepted" | "discarded";
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
};

const SWIPE_DISTANCE = 120;
const SWIPE_VELOCITY = 550;

function stopDragPropagation(e: React.SyntheticEvent) {
  e.stopPropagation();
}

export function CaptureSwipeCard({
  item,
  compact,
  preferredContactId,
  preferredContactName,
  reduceMotion,
  exiting,
  exitDirection,
  disabled,
  onChange,
  onSwipeCommit,
  onExitComplete,
}: {
  item: CaptureReviewItem;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  reduceMotion?: boolean | null;
  /** When set, card flies off in exitDirection before unmount. */
  exiting: SwipeDecision | null;
  /** 1 = right (accept), -1 = left (discard) */
  exitDirection: 1 | -1;
  disabled?: boolean;
  onChange: (next: CaptureReviewItem) => void;
  onSwipeCommit: (decision: SwipeDecision) => void;
  onExitComplete: () => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-220, 0, 220], [-10, 0, 10]);
  const acceptOpacity = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);
  const discardOpacity = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);

  function handleDragEnd(_: unknown, info: PanInfo) {
    if (disabled || exiting || reduceMotion) return;
    const dx = info.offset.x;
    const vx = info.velocity.x;
    if (dx > SWIPE_DISTANCE || vx > SWIPE_VELOCITY) {
      onSwipeCommit("accepted");
      return;
    }
    if (dx < -SWIPE_DISTANCE || vx < -SWIPE_VELOCITY) {
      onSwipeCommit("discarded");
    }
  }

  const flyX = exiting ? exitDirection * (compact ? 420 : 560) : 0;
  const flyRotate = exiting ? exitDirection * 14 : 0;

  return (
    <motion.div
      className="relative touch-pan-y will-change-transform"
      style={exiting || reduceMotion ? undefined : { x, rotate }}
      drag={reduceMotion || exiting || disabled ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.92}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      animate={
        exiting
          ? {
              x: flyX,
              opacity: 0,
              rotate: reduceMotion ? 0 : flyRotate,
            }
          : { opacity: 1 }
      }
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
      transition={
        exiting
          ? { duration: reduceMotion ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] }
          : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
      }
      onAnimationComplete={() => {
        if (exiting) onExitComplete();
      }}
    >
      {!reduceMotion && !exiting && (
        <>
          <motion.div
            aria-hidden
            style={{ opacity: acceptOpacity }}
            className="pointer-events-none absolute inset-0 z-10 flex items-start justify-end rounded-2xl border-2 border-emerald-500/70 bg-emerald-500/10 p-4"
          >
            <span className="rounded-md border border-emerald-600 bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
              Accept
            </span>
          </motion.div>
          <motion.div
            aria-hidden
            style={{ opacity: discardOpacity }}
            className="pointer-events-none absolute inset-0 z-10 flex items-start justify-start rounded-2xl border-2 border-rose-500/70 bg-rose-500/10 p-4"
          >
            <span className="rounded-md border border-rose-600 bg-rose-500/20 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-rose-800 dark:text-rose-200">
              Discard
            </span>
          </motion.div>
        </>
      )}

      <PersonReviewCard
        item={item}
        compact={compact}
        preferredContactId={preferredContactId}
        preferredContactName={preferredContactName}
        onChange={onChange}
      />
    </motion.div>
  );
}

function PersonReviewCard({
  item,
  onChange,
  compact,
  preferredContactId,
  preferredContactName,
}: {
  item: CaptureReviewItem;
  onChange: (next: CaptureReviewItem) => void;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const updateParsed = (patch: Partial<ParsedNote>) =>
    onChange({ ...item, parsed: { ...item.parsed, ...patch } });

  const showPreferred =
    preferredContactId &&
    preferredContactName &&
    !item.duplicates.some((d) => d.id === preferredContactId);

  const subtitle = [item.parsed.role, item.parsed.company]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "space-y-3 rounded-2xl border border-border/70 bg-card shadow-sm",
        compact ? "p-3.5" : "p-5 space-y-4"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p
            className={cn(
              "font-semibold text-foreground",
              compact ? "text-base" : "text-lg"
            )}
          >
            {item.parsed.name || "Unnamed person"}
          </p>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
          {item.parsed.met_at ? (
            <p className="text-xs text-muted-foreground">
              Met at {item.parsed.met_at}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {item.sharedNoteTexts.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              Shared note
            </Badge>
          )}
          {item.suggestedMergeId && (
            <Badge variant="secondary" className="text-[10px]">
              Likely existing
            </Badge>
          )}
        </div>
      </div>

      {!editing && (
        <p className="text-[11px] text-muted-foreground">
          Drag the card right to accept, left to discard
        </p>
      )}

      {(item.tagNames || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tagNames
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
        </div>
      )}

      <div
        className="space-y-2"
        onPointerDown={stopDragPropagation}
        onMouseDown={stopDragPropagation}
        onTouchStart={stopDragPropagation}
      >
        <Field label="What you talked about">
          <Textarea
            className={cn(compact ? "min-h-[100px] text-sm" : "min-h-[130px]")}
            value={item.parsed.summary || ""}
            placeholder="Detailed conversation recap — advice, frameworks, action items, next steps…"
            onChange={(e) => updateParsed({ summary: e.target.value })}
          />
        </Field>
        {(item.parsed.topics || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.parsed.topics.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {item.sharedNoteTexts.length > 0 && (
        <div className="rounded-xl border border-sky-200/70 bg-sky-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-sky-900/40 dark:bg-sky-950/15">
          <p className="mb-1 font-medium text-foreground">Shared with others</p>
          {item.sharedNoteTexts.map((text) => (
            <p key={text.slice(0, 40)} className="whitespace-pre-wrap">
              {text}
            </p>
          ))}
        </div>
      )}

      <div
        className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 p-2.5"
        onPointerDown={stopDragPropagation}
        onMouseDown={stopDragPropagation}
        onTouchStart={stopDragPropagation}
      >
        <p className="text-xs font-medium">Save as</p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="radio"
            name={`merge-${item.key}`}
            checked={!item.mergeContactId}
            onChange={() => onChange({ ...item, mergeContactId: null })}
          />
          Create new contact
        </label>
        {showPreferred && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name={`merge-${item.key}`}
              checked={item.mergeContactId === preferredContactId}
              onChange={() =>
                onChange({ ...item, mergeContactId: preferredContactId })
              }
            />
            Merge into {preferredContactName}
          </label>
        )}
        {item.duplicates.map((d) => (
          <label key={d.id} className="flex items-start gap-2 text-xs">
            <input
              type="radio"
              className="mt-0.5"
              name={`merge-${item.key}`}
              checked={item.mergeContactId === d.id}
              onChange={() => onChange({ ...item, mergeContactId: d.id })}
            />
            <span>
              Update{" "}
              <Link
                href={`/contacts/${d.id}`}
                className="text-primary underline"
                onClick={(e) => e.stopPropagation()}
              >
                {d.fullName}
              </Link>
              {d.company ? ` (${d.company})` : ""}
            </span>
          </label>
        ))}
      </div>

      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-2" : "sm:grid-cols-3 gap-3"
        )}
        onPointerDown={stopDragPropagation}
        onMouseDown={stopDragPropagation}
        onTouchStart={stopDragPropagation}
      >
        <Field label="Closeness">
          <Input
            type="number"
            min={1}
            max={5}
            value={item.relationshipScore}
            onChange={(e) =>
              onChange({
                ...item,
                relationshipScore: Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Follow-up days">
          <Input
            type="number"
            min={1}
            value={item.followUpDays}
            onChange={(e) =>
              onChange({ ...item, followUpDays: Number(e.target.value) })
            }
          />
        </Field>
        <label
          className={cn(
            "flex items-center gap-2 text-xs",
            compact ? "col-span-2" : "items-end pb-2 text-sm"
          )}
        >
          <Checkbox
            checked={item.createReminder}
            onCheckedChange={(v) =>
              onChange({ ...item, createReminder: Boolean(v) })
            }
          />
          Reminder
        </label>
      </div>

      <div
        onPointerDown={stopDragPropagation}
        onMouseDown={stopDragPropagation}
        onTouchStart={stopDragPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-0 text-xs text-muted-foreground"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Hide details" : "Edit details"}
        </Button>
        {editing && (
          <div
            className={cn(
              "mt-2 grid gap-2.5",
              compact ? "grid-cols-1" : "sm:grid-cols-2 gap-3"
            )}
          >
            <Field label="Name">
              <Input
                value={item.parsed.name || ""}
                onChange={(e) => updateParsed({ name: e.target.value })}
              />
            </Field>
            <Field label="Company">
              <Input
                value={item.parsed.company || ""}
                onChange={(e) => updateParsed({ company: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <Input
                value={item.parsed.role || ""}
                onChange={(e) => updateParsed({ role: e.target.value })}
              />
            </Field>
            <Field label="Met at">
              <Input
                value={item.parsed.met_at || ""}
                onChange={(e) => updateParsed({ met_at: e.target.value })}
              />
            </Field>
            <Field label="Tags">
              <Input
                value={item.tagNames}
                onChange={(e) =>
                  onChange({ ...item, tagNames: e.target.value })
                }
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
