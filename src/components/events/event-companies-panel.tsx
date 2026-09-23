"use client";

/**
 * Which companies were in the room, and how you get to them.
 *
 * A career fair hands you thirty booths and no names; a conference roster hands you four
 * hundred names and no structure. Both become tractable through the same question — WHICH OF
 * THESE DO I ALREADY HAVE A WAY INTO — and that is a company question, because Orbit knows
 * where the user's contacts work and where they used to.
 *
 * So each row answers it in one line: who you know there, who used to be there, and how many
 * people from there were in this room.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, Loader2, Plus, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import {
  addTargetCompanyFromEvent,
  dismissEventCompanyRow,
  importEventCompanies,
} from "@/actions/events";
import type { EventCompanyRow } from "@/lib/events/companies";

const ROLE_LABEL: Record<EventCompanyRow["role"], string> = {
  host: "Host",
  sponsor: "Sponsor",
  exhibitor: "Exhibitor",
  employer: "Recruiting",
  // Not a claim the host made — it is what people in the room said they do.
  attendee_employer: "From the roster",
};

export function EventCompaniesPanel({
  eventId,
  rows,
}: {
  eventId: string;
  rows: EventCompanyRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  function save() {
    start(async () => {
      try {
        const result = await importEventCompanies(eventId, text, "employer");
        setText("");
        setOpen(false);
        toast.success(
          result.added === 0
            ? "No company names found in that"
            : `Added ${result.added} compan${result.added === 1 ? "y" : "ies"}` +
                (result.skipped > 0 ? ` · ${result.skipped} line(s) skipped` : "")
        );
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t read that list — try again?"));
      }
    });
  }

  function star(name: string) {
    start(async () => {
      const result = await addTargetCompanyFromEvent(eventId, name, 2);
      if (!result.ok) {
        toast.error(result.error ?? "Couldn’t add that to your targets");
        return;
      }
      toast.success(`${name} is on your target list`);
      router.refresh();
    });
  }

  function dismiss(id: string) {
    start(async () => {
      await dismissEventCompanyRow(eventId, id);
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-medium text-ink">
            <Building2 className="size-4 text-muted-foreground" aria-hidden />
            Companies here
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Who was in the room as an organisation — and who you already know there.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
          <Plus className="size-4" aria-hidden />
          Paste employer list
        </Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={"Stripe\nBooth 12 — Figma\nRamp, Vercel, Linear"}
            aria-label="Employer list"
          />
          <p className="text-xs text-muted-foreground">
            One per line, or comma separated. Booth numbers and bullets are stripped.
          </p>
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending || !text.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Add companies
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
          No companies yet. Paste the exhibitor list from a career fair, or import a roster —
          people&rsquo;s employers show up here on their own.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.id ?? `roster:${row.name}`} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink">{row.name}</span>
                  {row.targetPriority ? (
                    // The reason to look at this row first.
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      <Star className="size-3" aria-hidden />
                      Target
                    </span>
                  ) : null}
                  <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {ROLE_LABEL[row.role]}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {row.targetPriority ? null : (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => star(row.name)}
                      disabled={pending}
                      title="Add to your target companies"
                    >
                      <Star className="size-3.5" aria-hidden />
                      Target
                    </Button>
                  )}
                  {row.id ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => dismiss(row.id!)}
                      disabled={pending}
                      aria-label={`Remove ${row.name}`}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {row.attendeeCount > 0 ? (
                  <span>
                    {row.attendeeCount} here from {row.name}
                  </span>
                ) : null}
                {row.contacts.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    You know
                    {row.contacts.slice(0, 3).map((person, index) => (
                      <span key={person.contactId}>
                        <Link
                          href={`/contacts/${person.contactId}`}
                          className="text-ink hover:underline"
                        >
                          {person.name}
                        </Link>
                        {/* "used to be there" is often the better introduction, and it is a
                            different fact — an alum will take the call. */}
                        {person.tenure === "past" ? " (was there)" : ""}
                        {index < Math.min(row.contacts.length, 3) - 1 ? "," : ""}
                      </span>
                    ))}
                    {row.contacts.length > 3 ? ` +${row.contacts.length - 3} more` : ""}
                  </span>
                ) : (
                  <span>Nobody you know there yet</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
