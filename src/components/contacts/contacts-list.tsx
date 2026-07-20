"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { CalendarClock, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactAvatarPreview } from "@/components/contacts/contact-preview-card";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
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
  tags: string[];
};

function roleLine(title: string | null, company: string | null) {
  if (title && company) return `${title} at ${company}`;
  if (title) return title;
  if (company) return company;
  return "No role yet";
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
  const [pending, start] = useTransition();
  const router = useRouter();
  const exitTimers = useRef<Map<string, number>>(new Map());
  const serverSignature = initialContacts.map((c) => c.id).join(",");

  useEffect(() => {
    setContacts(initialContacts);
    setExitingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync on id set change
  }, [serverSignature]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

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
          router.refresh();
        }
      });
    }, 420);

    exitTimers.current.set(id, timer);
  }

  if (contacts.length === 0) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        No contacts yet.{" "}
        <Link href="/capture" className="text-primary underline">
          Capture notes
        </Link>{" "}
        or{" "}
        <Link href="/imports" className="text-primary underline">
          import LinkedIn
        </Link>
        .
      </div>
    );
  }

  return (
    <TooltipProvider>
      <ul className="divide-y divide-border/60">
        {contacts.map((c) => {
          const exiting = exitingId === c.id;
          const overdue = isOverdue(c.nextFollowUpAt);
          const scheduledLabel = dueLabel(c.nextFollowUpAt);
          const details = detailLine(c.school, c.location);

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
                      <p className="min-w-0 truncate text-sm text-muted-foreground">
                        {roleLine(c.title, c.company)}
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
                        {details}
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
    </TooltipProvider>
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
  nextFollowUpAt,
  overdue,
  scheduledLabel,
}: {
  contactId: string;
  nextFollowUpAt?: string | Date | null;
  overdue: boolean;
  scheduledLabel: string | null;
}) {
  return (
    <Popover>
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
          nextFollowUpAt={nextFollowUpAt}
          compact
        />
      </PopoverContent>
    </Popover>
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
