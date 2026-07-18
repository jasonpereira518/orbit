"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type MouseEvent } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteContact } from "@/actions/contacts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ContactListItem = {
  id: string;
  fullName: string;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  relationshipScore: number;
  priorityLevel: number;
  tags: string[];
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
    // Sync when the server-side contact id set changes (filters / refresh after delete).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialContacts identity changes every RSC render
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
        <Link href="/capture" className="text-[#0f3d3e] underline">
          Capture notes
        </Link>{" "}
        or{" "}
        <Link href="/imports" className="text-[#0f3d3e] underline">
          import LinkedIn
        </Link>
        .
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-border/60">
        {contacts.map((c) => {
          const exiting = exitingId === c.id;
          return (
            <li
              key={c.id}
              className={cn(
                "contact-row grid transition-[grid-template-rows,opacity] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                exiting
                  ? "grid-rows-[0fr] opacity-0"
                  : "grid-rows-[1fr] opacity-100"
              )}
            >
              <div className="overflow-hidden">
                <div
                  className={cn(
                    "flex items-center gap-2 pr-2 transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                    exiting && "-translate-x-8"
                  )}
                >
                  <Link
                    href={`/contacts/${c.id}`}
                    className="flex min-w-0 flex-1 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-[#0f3d3e]">
                        {c.preferredName || c.fullName}
                      </p>
                      {c.preferredName &&
                        c.preferredName !== c.fullName && (
                          <p className="truncate text-xs text-muted-foreground">
                            {c.fullName}
                          </p>
                        )}
                      <p className="truncate text-sm text-muted-foreground">
                        {[c.title, c.company].filter(Boolean).join(" · ") ||
                          "No role yet"}
                      </p>
                      {c.tags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {c.tags.slice(0, 4).map((t) => (
                            <Badge
                              key={t}
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="outline">
                        Score {c.relationshipScore}
                      </Badge>
                      {c.priorityLevel > 0 && (
                        <span className="text-[10px] uppercase tracking-wide text-[#c4a35a]">
                          Priority {c.priorityLevel}
                        </span>
                      )}
                    </div>
                  </Link>

                  <DeleteRowButton
                    name={c.fullName}
                    disabled={pending || exiting}
                    onClick={() => requestDelete(c.id)}
                  />
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
        "delete-contact-btn group/trash mr-3 shrink-0 text-muted-foreground",
        "hover:bg-destructive/10 hover:text-destructive",
        "focus-visible:bg-destructive/10 focus-visible:text-destructive"
      )}
    >
      <span className="relative flex size-4 items-center justify-center">
        <Trash2
          className={cn(
            "size-4 transition-transform duration-300 ease-out",
            "group-hover/trash:-translate-y-0.5 group-hover/trash:scale-110",
            "group-hover/trash:animate-[trash-wiggle_0.45s_ease-in-out]",
            "group-active/trash:scale-95"
          )}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-full bg-destructive/20",
            "scale-0 opacity-0 transition-all duration-300",
            "group-hover/trash:scale-150 group-hover/trash:opacity-100",
            "group-hover/trash:animate-[delete-ripple_0.6s_ease-out]"
          )}
        />
      </span>
    </Button>
  );
}
