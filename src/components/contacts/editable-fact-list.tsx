"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, X } from "lucide-react";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { updateContact } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FACT_LIST_CAP, normalizeFactList } from "@/lib/fact-lists";

/** The three free-text lists a contact carries. All are extracted by AI and correctable here. */
export type FactField = "keyFacts" | "sharedInterests" | "opportunities";

/**
 * One editable bullet list on a contact profile.
 *
 * These lists are written by AI extraction — from a pasted note, a capture, the browser
 * extension — and until now they could only be read. A wrong fact that the user could see
 * and not correct is worse than no fact: it goes on to feed the contact brief, the chat
 * context and every generated draft, so the mistake is repeated back to them in the
 * follow-ups they send.
 *
 * Saving here REPLACES the list, which is the whole point — the user is stating what is
 * true, so removing an entry removes it. Extraction paths union instead and can never
 * delete; see `mergeFactLists` in `@/lib/contact-writes` and the note in `@/lib/fact-lists`.
 */
export function EditableFactList({
  contactId,
  field,
  title,
  emptyHint,
  addLabel,
  items,
}: {
  contactId: string;
  field: FactField;
  title: string;
  emptyHint: string;
  addLabel: string;
  items: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(items);
  const [pending, start] = useTransition();

  function beginEdit() {
    // Seed from the prop rather than from the last draft: a cancelled edit must not be the
    // starting point for the next one.
    setDraft(items.length > 0 ? items : [""]);
    setEditing(true);
  }

  function save() {
    const next = normalizeFactList(draft);
    start(async () => {
      try {
        await updateContact(contactId, { [field]: next });
        setEditing(false);
        toast.success(`${title} saved`);
        router.refresh();
      } catch (err) {
        toast.error(
          friendlyError(err, `Couldn’t save those ${title.toLowerCase()} — try again?`)
        );
      }
    });
  }

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
        <CardAction>
          {editing ? (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                className="h-8 px-2"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                className="h-8 gap-1.5 px-2.5"
                onClick={save}
              >
                <Check className="size-3.5" aria-hidden />
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2 text-muted-foreground"
              onClick={beginEdit}
              aria-label={`Edit ${title.toLowerCase()}`}
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-2">
            {draft.map((value, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={value}
                  autoFocus={i === 0}
                  onChange={(e) =>
                    setDraft((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      // Enter adds the next bullet, the way a list wants to behave. Saving
                      // is the explicit button — Enter-to-save would make a stray keypress
                      // in the middle of editing commit a half-finished list.
                      setDraft((prev) => [...prev.slice(0, i + 1), "", ...prev.slice(i + 1)]);
                    }
                  }}
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-border"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 shrink-0 px-2 text-muted-foreground"
                  aria-label="Remove"
                  onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            ))}
            {draft.length < FACT_LIST_CAP ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => setDraft((prev) => [...prev, ""])}
              >
                <Plus className="size-3.5" aria-hidden />
                {addLabel}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                That is the most {title.toLowerCase()} Orbit will keep for one person.
              </p>
            )}
          </div>
        ) : items.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyHint}</p>
        )}
      </CardContent>
    </Card>
  );
}
