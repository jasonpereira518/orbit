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
import { IntentLink } from "@/components/ui/intent-link";
import { Building2, Loader2, Plus, Star, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
    <Card>
      <CardHeader>
        <CardTitle as="h2">Companies here</CardTitle>
        <CardDescription>
          Who was in the room as an organisation — and who you already know there.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            <Plus className="size-4" aria-hidden />
            Paste employer list
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
      {open ? (
        <div className="mb-4 space-y-2">
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
              {pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
              {pending ? "Adding…" : "Add companies"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Building2}
          title="No companies yet"
          description="Paste the exhibitor list from a career fair, or import a roster — people’s employers show up here on their own."
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <li key={row.id ?? `roster:${row.name}`} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink">{row.name}</span>
                  {row.targetPriority ? (
                    // The reason to look at this row first.
                    <Badge tone="accent" size="sm">
                      <Star aria-hidden />
                      Target
                    </Badge>
                  ) : null}
                  <Badge variant="outline" size="sm" className="text-muted-foreground">
                    {ROLE_LABEL[row.role]}
                  </Badge>
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
                        <IntentLink
                          href={`/contacts/${person.contactId}`}
                          className="text-ink hover:underline"
                        >
                          {person.name}
                        </IntentLink>
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
      </CardContent>
    </Card>
  );
}
