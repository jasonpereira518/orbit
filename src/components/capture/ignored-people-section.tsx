"use client";

/**
 * The bottom of the page: people captures set aside. A button with a count, opening a
 * dialog rather than expanding in place — the list is a side task, and a collapsible
 * under a sticky action row would shove it around.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserRoundPlus, UsersRound, X } from "lucide-react";
import { addIgnoredPersonAsContact, forgetIgnoredPerson, listIgnoredPeople } from "@/actions/ignored-people";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { IgnoredPerson } from "@/lib/ignored-people";
import { timelineDayLabel } from "@/lib/timeline-date";
import { toast } from "@/lib/toast";

const REASON_LABEL: Record<IgnoredPerson["reason"], string> = {
  skipped: "For later",
  rejected: "Set aside",
  mentioned: "Mentioned",
};

export function IgnoredPeopleSection({ initialCount }: { initialCount: number }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  return (
    <>
      <div className="flex justify-center pt-2">
        <Button variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
          <UsersRound className="size-4" />
          Ignored people{count > 0 ? ` · ${count}` : ""}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <IgnoredList onCount={setCount} />}
      </Dialog>
    </>
  );
}

function IgnoredList({ onCount }: { onCount: (n: number) => void }) {
  const router = useRouter();
  const [people, setPeople] = useState<IgnoredPerson[] | null>(null);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listIgnoredPeople().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        toast.error(res.error);
        setPeople([]);
        return;
      }
      setPeople(res.people);
      onCount(res.people.length);
    });
    return () => {
      cancelled = true;
    };
  }, [onCount]);

  function remove(id: string) {
    setPeople((prev) => {
      const next = (prev ?? []).filter((p) => p.id !== id);
      onCount(next.length);
      return next;
    });
  }

  return (
    <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Ignored people</DialogTitle>
        <DialogDescription>
          People you skipped, set aside, or who were only mentioned in your notes. Add anyone here as a contact.
        </DialogDescription>
      </DialogHeader>
      {people === null ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <p className="rounded-xl bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">Nothing ignored yet.</p>
      ) : (
        <ul className="space-y-2">
          {people.map((p) => (
            <li key={p.id} className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-foreground">{p.displayName}</p>
                  <Badge variant="secondary" className="text-[10px]">
                    {REASON_LABEL[p.reason]}
                  </Badge>
                </div>
                {(p.context || p.company) && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {[p.company, p.context].filter(Boolean).join(" · ")}
                  </p>
                )}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{timelineDayLabel(p.updatedAt)}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending && busyId === p.id}
                onClick={() => {
                  setBusyId(p.id);
                  start(async () => {
                    const res = await addIgnoredPersonAsContact(p.id);
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    remove(p.id);
                    toast.success(res.created ? `${p.displayName} added to your network` : `${p.displayName} was already here — updated`, {
                      action: { label: "Open", onClick: () => router.push(`/contacts/${res.contactId}`) },
                    });
                    router.refresh();
                  });
                }}
              >
                <UserRoundPlus className="size-3.5" /> Add as contact
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Forget ${p.displayName}`}
                className="text-muted-foreground"
                onClick={() => {
                  remove(p.id);
                  void forgetIgnoredPerson(p.id).then((res) => {
                    if (!res.ok) toast.error(res.error);
                  });
                }}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DialogContent>
  );
}
