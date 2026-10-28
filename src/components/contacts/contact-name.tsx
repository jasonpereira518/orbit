"use client";

import { useState, useTransition, type ReactNode } from "react";
import { reviewContactName } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NameGuess } from "@/lib/contact-name-guess";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

/**
 * A contact's name, with a small "?" at its top right when Orbit read the name from a handle
 * and is not sure (`@/lib/contact-name-sweep`). Shown on hover, always on touch screens.
 * Confirm keeps the name; Change saves a new one.
 *
 * Pass the name's own link as `children` when it has one: the "?" is a button and sits beside
 * the link, never inside it.
 */
export function ContactName({
  contactId,
  name,
  guess,
  children,
  className,
}: {
  contactId: string;
  name: string;
  guess: NameGuess | null | undefined;
  children?: ReactNode;
  className?: string;
}) {
  // A changed name shows at once; the page's own data catches up on the action's refresh.
  const [renamed, setRenamed] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [pending, startTransition] = useTransition();

  function save(names?: { firstName: string; lastName: string }) {
    startTransition(async () => {
      try {
        await reviewContactName(contactId, names);
        if (names) setRenamed([names.firstName.trim(), names.lastName.trim()].filter(Boolean).join(" "));
        setSettled(true);
        setOpen(false);
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  return (
    // Not `relative`: a row's stretched link (`after:absolute after:inset-0`) must still
    // measure the whole row, not this span. The "?" is placed relative to itself instead.
    <span className={cn("group/name", className)}>
      {children && renamed === null ? children : (renamed ?? name)}
      {guess?.weak && !settled ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) {
              const words = name.trim().split(/\s+/);
              const blank = guess.source === "none";
              setFirst(blank ? "" : (words[0] ?? ""));
              setLast(blank ? "" : words.slice(1).join(" "));
              setEditing(blank);
            }
          }}
        >
          <PopoverTrigger
            type="button"
            aria-label="Is this name right?"
            title="Is this name right?"
            // A row or card around the name may navigate on click; this click is only ours.
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "relative z-10 ml-0.5 inline-flex size-4 align-text-top items-center justify-center rounded-full border border-border bg-card font-sans text-3xs leading-none font-semibold text-muted-foreground shadow-sm transition-opacity",
              "opacity-0 group-hover/name:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100",
              "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            )}
          >
            ?
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-64 font-sans text-sm font-normal tracking-normal"
            // React events bubble through the portal to whatever row holds the name.
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-muted-foreground">
              {guess.source === "none" ? "Orbit couldn’t read a name from " : "Orbit read this name from "}
              <bdi className="font-medium wrap-anywhere text-foreground">{guess.from || "an empty name"}</bdi>.
            </p>
            {editing ? (
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (first.trim()) save({ firstName: first, lastName: last });
                }}
              >
                <Input aria-label="First name" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus maxLength={100} />
                <Input aria-label="Last name" placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} maxLength={100} />
                <div className="flex justify-end gap-2 pt-1">
                  {guess.source !== "none" ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
                      Cancel
                    </Button>
                  ) : null}
                  <Button type="submit" size="sm" disabled={pending || !first.trim()}>
                    Save
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={pending}>
                  Change
                </Button>
                <Button type="button" size="sm" onClick={() => save()} disabled={pending}>
                  Confirm
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
