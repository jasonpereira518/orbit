"use client";

/**
 * "Merge into…" — folding this contact into another one by hand.
 *
 * The counterpart to /contacts/duplicates for the case the matcher cannot see: two records
 * for one person that share no identifier and no name (a maiden name, a nickname, a personal
 * versus work profile).
 *
 * This contact is always the one that goes away, because the button lives on its page and
 * that is the only reading of "merge into X" that does not require explaining a direction.
 * The fold only ever fills blanks on the target, so nothing on either side is overwritten.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Merge, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { searchContactsForPicker } from "@/actions/contacts";
import { mergeDuplicatePair } from "@/actions/duplicates";
import type { ContactPickerOption } from "@/lib/contacts-page";
import { cn } from "@/lib/utils";

export function MergeContactButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ContactPickerOption[]>([]);
  const [target, setTarget] = useState<ContactPickerOption | null>(null);
  const [pending, startTransition] = useTransition();
  // Guards against an earlier, slower search overwriting a later one's results.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const token = ++requestRef.current;
    const timer = setTimeout(async () => {
      const rows = await searchContactsForPicker(query, 20);
      if (token !== requestRef.current) return;
      setOptions(rows.filter((row) => row.id !== id));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query, id]);

  const onMerge = () =>
    startTransition(async () => {
      if (!target) return;
      try {
        await mergeDuplicatePair(target.id, id, "Merged by hand");
        setOpen(false);
        toast.success(`Merged into ${target.fullName}`, {
          description: "Undo it any time from Contacts → Duplicates.",
        });
        router.push(`/contacts/${target.id}`);
      } catch (err) {
        toast.error("Could not merge", {
          description: err instanceof Error ? err.message : "Please try again.",
        });
      }
    });

  return (
    <>
      {/* This dialog has no DialogTrigger: the ui/dialog wrapper does not re-export one. */}
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Merge className="h-4 w-4" aria-hidden />
        Merge into…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge {name} into another contact</DialogTitle>
            <DialogDescription>
              {name}&rsquo;s notes, interactions, reminders and tags move to the
              contact you pick. Nothing already filled in there is overwritten,
              and nothing is deleted — you can undo this from Contacts →
              Duplicates.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts"
                className="pl-9"
                aria-label="Search for the contact to keep"
              />
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto" role="listbox">
              {options.length === 0 ? (
                <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                  {query
                    ? "No contacts match."
                    : "Start typing to find a contact."}
                </li>
              ) : (
                options.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={target?.id === option.id}
                      onClick={() => setTarget(option)}
                      className={cn(
                        "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                        target?.id === option.id
                          ? "bg-primary/10 ring-1 ring-primary"
                          : "hover:bg-muted",
                      )}
                    >
                      <span className="font-medium">{option.fullName}</span>
                      {option.company ? (
                        <span className="ml-2 text-muted-foreground">
                          {option.company}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={onMerge} disabled={!target || pending}>
              {target ? `Merge into ${target.fullName}` : "Pick a contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
