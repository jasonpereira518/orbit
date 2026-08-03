"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { CompanyRoleLine } from "@/components/contacts/company-role-line";
import { ContactAvatarPreview } from "@/components/contacts/contact-preview-card";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import { FollowUpDraftSheet } from "@/components/follow-up/follow-up-draft-sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  closenessPercentChipClass,
} from "@/lib/closeness";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import { cn } from "@/lib/utils";

export type ContactListItem = {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName?: string | null;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileImageUrl?: string | null;
  relationshipScore: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  priorityLevel: number;
  nextFollowUpAt?: string | Date | null;
  lastInteractionAt?: string | Date | null;
  tags: string[];
};

const ALPHABET = [
  "#",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
] as const;

function lastNameOf(c: ContactListItem) {
  const fromField = c.lastName?.trim();
  if (fromField) return fromField;
  const parts = c.fullName.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : parts[0] || "";
}

function letterOf(lastName: string) {
  const ch = lastName.charAt(0).toLocaleUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

function detailLine(school: string | null, location: string | null) {
  return [school, location].filter(Boolean).join(" · ");
}

function isOverdue(nextFollowUpAt?: string | Date | null) {
  if (!nextFollowUpAt) return false;
  const due = new Date(nextFollowUpAt);
  if (Number.isNaN(due.getTime())) return false;
  return due <= new Date();
}

function dueLabel(nextFollowUpAt?: string | Date | null) {
  if (!nextFollowUpAt) return null;
  try {
    return new Date(nextFollowUpAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

function lastTouchLabel(lastInteractionAt?: string | Date | null) {
  if (!lastInteractionAt) return null;
  const d = new Date(lastInteractionAt);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Last touch today";
  return `Last touch ${days}d ago`;
}

function overdueFollowUpLabel(nextFollowUpAt?: string | Date | null) {
  if (!nextFollowUpAt) return null;
  const d = new Date(nextFollowUpAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d > now) return null;
  const days = Math.max(
    1,
    Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
  );
  return `Overdue ${days} day${days === 1 ? "" : "s"}`;
}

const TIER_TOOLTIP: Record<"inner" | "mid" | "outer", string> = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
};

export function ContactsList({
  initialContacts,
}: {
  initialContacts: ContactListItem[];
}) {
  const [contacts, setContacts] = useState(initialContacts);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const exitTimers = useRef<Map<string, number>>(new Map());
  const serverSignature = initialContacts
    .map((c) => `${c.id}:${c.nextFollowUpAt ?? ""}:${c.profileImageUrl ?? ""}`)
    .join(",");

  useEffect(() => {
    setContacts(initialContacts);
    setExitingId(null);
  }, [serverSignature, initialContacts]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const sections = useMemo(() => {
    const sorted = [...contacts].sort((a, b) => {
      const byLast = lastNameOf(a).localeCompare(lastNameOf(b), undefined, {
        sensitivity: "base",
      });
      if (byLast !== 0) return byLast;
      return a.fullName.localeCompare(b.fullName, undefined, {
        sensitivity: "base",
      });
    });

    const groups = new Map<string, ContactListItem[]>();
    for (const c of sorted) {
      const letter = letterOf(lastNameOf(c));
      const list = groups.get(letter) ?? [];
      list.push(c);
      groups.set(letter, list);
    }
    return ALPHABET.filter((letter) => groups.has(letter)).map((letter) => ({
      letter,
      contacts: groups.get(letter)!,
    }));
  }, [contacts]);

  const availableLetters = useMemo(
    () => new Set(sections.map((s) => s.letter)),
    [sections]
  );

  function scrollToLetter(letter: string) {
    const target =
      document.getElementById(`contact-letter-${letter}`) ??
      nearestSectionEl(letter, availableLetters);
    target?.scrollIntoView({ behavior: "auto", block: "start" });
    setActiveLetter(letter);
  }

  const confirmContact = contacts.find((c) => c.id === confirmId);

  function requestDelete(id: string) {
    setConfirmId(id);
  }

  function confirmDelete() {
    if (!confirmId) return;
    const id = confirmId;
    const name = confirmContact?.fullName ?? "Contact";
    setConfirmId(null);
    setExitingId(id);

    const timer = window.setTimeout(() => {
      setContacts((prev) => prev.filter((c) => c.id !== id));
      setExitingId((current) => (current === id ? null : current));
      exitTimers.current.delete(id);

      start(async () => {
        try {
          await deleteContact(id);
          toast.success(`${name} deleted`);
          router.refresh();
        } catch {
          toast.error("Could not delete contact");
          // Restore server list if delete failed.
          setContacts(initialContacts);
          router.refresh();
        }
      });
    }, 420);

    exitTimers.current.set(id, timer);
  }

  if (contacts.length === 0) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        No contacts match these filters. Clear search to see everyone, or{" "}
        <Link href="/capture" className="text-primary underline">
          capture notes
        </Link>{" "}
        /{" "}
        <Link href="/imports" className="text-primary underline">
          import LinkedIn
        </Link>
        .
      </div>
    );
  }

  return (
    <TooltipProvider>
      <>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl">
          {sections.map((section) => (
            <li key={section.letter} className="list-none">
              <div
                id={`contact-letter-${section.letter}`}
                className="sticky top-0 z-10 border-b border-border/50 bg-card/95 px-4 py-1.5 backdrop-blur sm:px-5"
              >
                <p className="text-xs font-semibold tracking-wide text-muted-foreground">
                  {section.letter}
                </p>
              </div>
              <ul className="divide-y divide-border/60">
                {section.contacts.map((c) => {
                  const exiting = exitingId === c.id;
                  const overdue = isOverdue(c.nextFollowUpAt);
                  const scheduledLabel = dueLabel(c.nextFollowUpAt);
                  const overdueText = overdueFollowUpLabel(c.nextFollowUpAt);
                  const lastTouch = lastTouchLabel(c.lastInteractionAt);
                  const details = [
                    detailLine(c.school, c.location),
                    overdueText,
                    lastTouch,
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  function openContact() {
                    if (exiting) return;
                    router.push(`/contacts/${c.id}`);
                  }

                  function onRowKeyDown(e: KeyboardEvent<HTMLLIElement>) {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openContact();
                    }
                  }

                  return (
                    <li
                      key={c.id}
                      role="link"
                      tabIndex={0}
                      onClick={openContact}
                      onKeyDown={onRowKeyDown}
                      className={cn(
                        "contact-row grid cursor-pointer transition-[grid-template-rows,opacity] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                        "outline-none focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
                        exiting
                          ? "grid-rows-[0fr] opacity-0"
                          : "grid-rows-[1fr] opacity-100"
                      )}
                    >
                      <div className="overflow-hidden">
                        <div
                          className={cn(
                            "flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:px-5",
                            "transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                            exiting && "-translate-x-8"
                          )}
                        >
                          <ContactAvatarPreview contact={c}>
                            <ContactAvatar
                              contactId={c.id}
                              firstName={c.firstName}
                              fullName={c.fullName}
                              linkedinUrl={c.linkedinUrl}
                              profileImageUrl={c.profileImageUrl}
                              size="lg"
                            />
                          </ContactAvatarPreview>

                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-primary">
                              {c.preferredName || c.fullName}
                            </p>
                            <div className="mt-0.5 flex min-w-0 items-center gap-2">
                              <p className="min-w-0 truncate text-sm">
                                <CompanyRoleLine
                                  title={c.title}
                                  company={c.company}
                                />
                              </p>
                              {c.closenessTier && (
                                <ClosenessTierBadge
                                  tier={c.closenessTier}
                                  className="shrink-0"
                                />
                              )}
                            </div>
                            {details && (
                              <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                                {overdueText ? (
                                  <>
                                    {detailLine(c.school, c.location) && (
                                      <>
                                        {detailLine(c.school, c.location)}
                                        <span className="mx-1.5">·</span>
                                      </>
                                    )}
                                    <span className="font-medium text-amber-700 dark:text-amber-300">
                                      {overdueText}
                                    </span>
                                    {lastTouch && (
                                      <>
                                        <span className="mx-1.5">·</span>
                                        {lastTouch}
                                      </>
                                    )}
                                  </>
                                ) : (
                                  details
                                )}
                              </p>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <ClosenessChip
                              closeness={c.closeness}
                              relationshipScore={c.relationshipScore}
                              closenessTier={c.closenessTier}
                            />

                            {c.linkedinUrl ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Open ${c.fullName} on LinkedIn`}
                                className="shrink-0 text-muted-foreground"
                                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  window.open(
                                    buildLinkedInUrl(c.linkedinUrl!),
                                    "_blank",
                                    "noopener,noreferrer"
                                  );
                                }}
                              >
                                <LinkedInIcon className="size-4" />
                              </Button>
                            ) : null}

                            <FollowUpRowButton
                              contactId={c.id}
                              contactName={c.preferredName || c.fullName}
                              nextFollowUpAt={c.nextFollowUpAt}
                              overdue={overdue}
                              scheduledLabel={scheduledLabel}
                            />

                            <DeleteRowButton
                              name={c.fullName}
                              disabled={pending || exiting}
                              onClick={() => requestDelete(c.id)}
                            />
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        <AlphabetScrubber
          available={availableLetters}
          activeLetter={activeLetter}
          onSelect={scrollToLetter}
          onScrubEnd={() => setActiveLetter(null)}
        />

        <Dialog
          open={confirmId !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmId(null);
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete {confirmContact?.fullName}?</DialogTitle>
              <DialogDescription>
                This removes the contact and their interaction history. This
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="outline"
                onClick={() => setConfirmId(null)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="delete-confirm-btn"
                onClick={confirmDelete}
                disabled={pending}
              >
                <Trash2 className="size-3.5" />
                Delete contact
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    </TooltipProvider>
  );
}

function nearestSectionEl(letter: string, available: Set<string>) {
  const idx = ALPHABET.indexOf(letter as (typeof ALPHABET)[number]);
  if (idx < 0) return null;

  for (let i = idx; i < ALPHABET.length; i++) {
    const next = ALPHABET[i]!;
    if (available.has(next)) {
      return document.getElementById(`contact-letter-${next}`);
    }
  }
  for (let i = idx - 1; i >= 0; i--) {
    const prev = ALPHABET[i]!;
    if (available.has(prev)) {
      return document.getElementById(`contact-letter-${prev}`);
    }
  }
  return null;
}

function AlphabetScrubber({
  available,
  activeLetter,
  onSelect,
  onScrubEnd,
}: {
  available: Set<string>;
  activeLetter: string | null;
  onSelect: (letter: string) => void;
  onScrubEnd: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  function letterFromClientY(clientY: number) {
    const el = railRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const t = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const idx = Math.min(
      ALPHABET.length - 1,
      Math.max(0, Math.floor(t * ALPHABET.length))
    );
    return ALPHABET[idx]!;
  }

  function scrub(clientY: number) {
    const letter = letterFromClientY(clientY);
    if (letter) onSelect(letter);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub(e.clientY);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    scrub(e.clientY);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onScrubEnd();
  }

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed top-1/2 right-2 z-40 -translate-y-1/2 sm:right-4",
        "pb-[env(safe-area-inset-bottom)]"
      )}
    >
      <div
        ref={railRef}
        role="navigation"
        aria-label="Jump to letter"
        className={cn(
          "pointer-events-auto relative flex h-[min(70vh,32rem)] w-9 cursor-ns-resize select-none flex-col items-center justify-between rounded-2xl border border-border/70 bg-card/95 py-2.5 shadow-md backdrop-blur",
          "touch-none ring-1 ring-foreground/5"
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {ALPHABET.map((letter) => {
          const hasContacts = available.has(letter);
          const isActive = activeLetter === letter;
          return (
            <button
              key={letter}
              type="button"
              tabIndex={-1}
              disabled={!hasContacts}
              aria-label={
                hasContacts ? `Jump to ${letter}` : `${letter} — no contacts`
              }
              className={cn(
                "flex h-[1.1%] min-h-0 w-full items-center justify-center text-[9px] leading-none sm:text-[10px]",
                hasContacts
                  ? "font-medium text-muted-foreground hover:text-primary"
                  : "text-muted-foreground/30",
                isActive && hasContacts && "scale-125 font-semibold text-primary"
              )}
              onClick={(e) => {
                e.preventDefault();
                if (hasContacts) onSelect(letter);
              }}
            >
              {letter}
            </button>
          );
        })}

        {activeLetter && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 -left-14 flex size-11 -translate-y-1/2 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground shadow-md"
          >
            {activeLetter}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ClosenessChip({
  closeness,
  relationshipScore,
  closenessTier,
}: {
  closeness?: number;
  relationshipScore: number;
  closenessTier?: "inner" | "mid" | "outer";
}) {
  const label =
    typeof closeness === "number"
      ? `${Math.round(closeness * 100)}%`
      : `Score ${relationshipScore}`;

  const chipClass =
    typeof closeness === "number"
      ? closenessPercentChipClass(closeness)
      : "bg-muted text-muted-foreground";

  const tierHint = closenessTier ? ` (${TIER_TOOLTIP[closenessTier]})` : "";

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className={cn(
          "rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          chipClass
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-left leading-snug">
        Closeness combines relationship strength, how recently you’ve
        interacted, and fit with your goals. Higher means a stronger orbit
        {tierHint}.
      </TooltipContent>
    </Tooltip>
  );
}

function FollowUpRowButton({
  contactId,
  contactName,
  nextFollowUpAt,
  overdue,
  scheduledLabel,
}: {
  contactId: string;
  contactName: string;
  nextFollowUpAt?: string | Date | null;
  overdue: boolean;
  scheduledLabel: string | null;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          type="button"
          aria-label={
            overdue
              ? `Follow-up overdue${scheduledLabel ? ` since ${scheduledLabel}` : ""}`
              : scheduledLabel
                ? `Follow-up due ${scheduledLabel}`
                : "Set follow-up"
          }
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "relative shrink-0 text-muted-foreground",
            overdue && "text-chart-4 hover:text-chart-4"
          )}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <CalendarClock className="size-4" />
          {overdue && (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-chart-4 ring-2 ring-card"
            />
          )}
        </PopoverTrigger>
        <PopoverContent
          className="space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Easy follow-up
            </p>
            {scheduledLabel && (
              <p
                className={cn(
                  "text-xs",
                  overdue ? "font-medium text-chart-4" : "text-muted-foreground"
                )}
              >
                {overdue ? "Overdue" : "Due"} {scheduledLabel}
              </p>
            )}
          </div>
          <EasyFollowUp
            contactId={contactId}
            contactName={contactName}
            nextFollowUpAt={nextFollowUpAt}
            compact
            embedDraftSheet={false}
            onFollowUpClick={() => {
              setPopoverOpen(false);
              setSheetOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <FollowUpDraftSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        contactId={contactId}
        contactName={contactName}
      />
    </>
  );
}

function DeleteRowButton({
  name,
  disabled,
  onClick,
}: {
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label={`Delete ${name}`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "shrink-0 text-muted-foreground",
        "hover:bg-destructive/10 hover:text-destructive",
        "focus-visible:bg-destructive/10 focus-visible:text-destructive"
      )}
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}
