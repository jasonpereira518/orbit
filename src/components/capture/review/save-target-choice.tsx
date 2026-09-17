"use client";

/**
 * Where this person goes: onto an existing contact, or in as a new one. Defaults to the
 * existing contact whenever the parse found one ("save to the same contact if they're
 * already there"), switchable with one click.
 */
import Link from "next/link";
import { motion } from "motion/react";
import type { BulkNoteDuplicate } from "@/lib/capture/types";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function SaveTargetChoice({
  candidates,
  value,
  onChange,
  name,
  lockedName,
}: {
  candidates: BulkNoteDuplicate[];
  /** A contact id to update, or null to create. */
  value: string | null;
  onChange: (next: string | null) => void;
  name: string;
  /** Opened from this contact's profile: the choice is made. */
  lockedName?: string | null;
}) {
  if (lockedName) {
    return (
      <p className="text-xs text-muted-foreground">
        Logging on <span className="font-medium text-foreground">{lockedName}</span>&apos;s timeline
      </p>
    );
  }
  if (!candidates.length) {
    return (
      <p className="text-xs text-muted-foreground">
        Nobody by this name yet — they&apos;ll be added as a <span className="font-medium text-foreground">new contact</span>.
      </p>
    );
  }
  const selected = candidates.find((c) => c.id === value) ?? null;
  const updating = value !== null;
  const lowConfidence = selected ? selected.confidence < 0.85 : false;
  return (
    <div className="space-y-2">
      <div className="inline-flex w-full rounded-lg bg-muted p-[3px]" role="radiogroup" aria-label="Save as">
        <Segment name={name} active={updating} onSelect={() => onChange(selected?.id ?? candidates[0]!.id)} pill={`${name}-target`}>
          Update {selected ? shortName(selected.fullName) : "existing"}
        </Segment>
        <Segment name={name} active={!updating} onSelect={() => onChange(null)} pill={`${name}-target`}>
          Create new
        </Segment>
      </div>
      {updating && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {candidates.length > 1 ? (
            <select
              aria-label="Which contact to update"
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={value ?? ""}
              onChange={(e) => onChange(e.target.value || null)}
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                  {c.company ? ` · ${c.company}` : c.title ? ` · ${c.title}` : ""}
                </option>
              ))}
            </select>
          ) : (
            selected && (
              <span>
                {selected.company ? `${selected.company} · ` : selected.title ? `${selected.title} · ` : ""}
                {selected.reason.toLowerCase()}
              </span>
            )
          )}
          {selected && (
            <Link href={`/contacts/${selected.id}`} className="font-medium text-primary underline-offset-2 hover:underline" target="_blank">
              Open profile
            </Link>
          )}
          {lowConfidence && (
            <span className="text-amber-700 dark:text-amber-400">Looks like a match — worth a glance</span>
          )}
        </div>
      )}
    </div>
  );
}

function shortName(full: string) {
  const first = full.trim().split(/\s+/)[0] ?? full;
  return first.length > 14 ? `${first.slice(0, 13)}…` : first;
}

function Segment({
  name,
  active,
  onSelect,
  pill,
  children,
}: {
  name: string;
  active: boolean;
  onSelect: () => void;
  pill: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <input type="radio" name={name} checked={active} onChange={onSelect} className="peer sr-only" />
      {active && (
        <motion.span
          layoutId={pill}
          className="absolute inset-0 rounded-md bg-background shadow-sm peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50"
          transition={SPRING_PILL}
        />
      )}
      <span className="relative z-10 truncate">{children}</span>
    </label>
  );
}
