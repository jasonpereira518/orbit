"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { updateBriefAction } from "@/actions/outreach-campaigns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import type { OutreachBrief } from "@/lib/outreach/types";
import { toast } from "@/lib/toast";

export function BriefCard({
  campaignId,
  name,
  brief,
  senderIntro,
}: {
  campaignId: string;
  name: string;
  brief: OutreachBrief;
  senderIntro: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState({
    name,
    purpose: brief.purpose,
    desiredOutcome: brief.desiredOutcome,
    notes: brief.notes ?? "",
    senderIntro: senderIntro ?? "",
  });
  const headingId = useId();
  const nameId = useId();
  const purposeId = useId();
  const outcomeId = useId();
  const notesId = useId();
  const introId = useId();

  function save() {
    start(async () => {
      try {
        const result = await updateBriefAction(campaignId, draft);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("Brief saved");
        setEditing(false);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save the brief"));
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-lg font-medium text-ink">
          What this campaign is for
        </h2>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input id={nameId} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={purposeId}>Purpose</Label>
            <Textarea id={purposeId} rows={3} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={outcomeId}>Desired outcome</Label>
            <Input id={outcomeId} value={draft.desiredOutcome} onChange={(e) => setDraft({ ...draft, desiredOutcome: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={notesId}>Notes</Label>
            <Textarea id={notesId} rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={introId}>How you introduce yourself</Label>
            <Textarea id={introId} rows={2} value={draft.senderIntro} onChange={(e) => setDraft({ ...draft, senderIntro: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save brief"}
            </Button>
          </div>
        </div>
      ) : (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Purpose</dt>
            <dd className="mt-0.5 text-foreground">{brief.purpose}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Desired outcome</dt>
            <dd className="mt-0.5 text-foreground">{brief.desiredOutcome}</dd>
          </div>
          {brief.notes && (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="mt-0.5 text-foreground">{brief.notes}</dd>
            </div>
          )}
          {senderIntro && (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">How you introduce yourself</dt>
              <dd className="mt-0.5 text-foreground">{senderIntro}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
