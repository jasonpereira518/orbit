"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IntentLink } from "@/components/ui/intent-link";
import { resolveContactChange } from "@/actions/duplicates";
import type { ContactChangeRow } from "@/lib/contact-changes";
import type { FieldKey } from "@/lib/contact-fields";
import { friendlyError } from "@/lib/errors";

const FIELD_LABEL: Record<FieldKey, string> = {
  company: "Company",
  title: "Role",
  location: "Location",
  school: "School",
  email: "Email",
  phone: "Phone",
  linkedinUrl: "LinkedIn",
  xHandle: "X",
  website: "Website",
  industry: "Industry",
};

const SOURCE_LABEL: Record<string, string> = {
  extension: "from their LinkedIn profile",
  linkedin_export: "from your LinkedIn export",
  linkedin_refresh: "from their LinkedIn profile",
  capture: "from your notes",
  job_move: "they changed jobs",
  address_book: "from your address book",
  import: "from an import",
  calendar: "from your calendar",
  unattended_capture: "from your notes",
  web: "from a web lookup",
  signature: "from an email signature",
  email_domain: "from their email address",
};

/** URLs read better without the scheme and "www." (a LinkedIn change is mostly its slug). */
function shown(field: FieldKey, value: string | null) {
  if (!value) return value;
  if (field === "linkedinUrl") return value.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? value;
  return field === "website" ? value.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") : value;
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Change({ row }: { row: ContactChangeRow }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm">
        <IntentLink href={`/contacts/${row.contactId}`} className="font-medium underline-offset-4 hover:underline">
          {row.contactName}
        </IntentLink>
        <span className="text-muted-foreground"> · {FIELD_LABEL[row.field]}</span>
      </p>
      <p className="truncate text-sm">
        <span className={row.before ? "text-muted-foreground line-through" : "text-muted-foreground"}>
          {shown(row.field, row.before) ?? "empty"}
        </span>
        <ArrowRight className="mx-1.5 inline h-3 w-3" aria-label="to" />
        <span>{shown(row.field, row.after)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {SOURCE_LABEL[row.source ?? ""] ?? "found by Orbit"} · {day(row.createdAt)}
      </p>
    </div>
  );
}

/**
 * Field updates Orbit wants a yes for, and the ones it made on its own (contact-info accuracy
 * plan, PR 3). Company and title answer together: accepting one accepts its partner.
 */
export function ContactChangesList({
  suggestions,
  applied,
}: {
  suggestions: ContactChangeRow[];
  applied: ContactChangeRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const answer = (id: string, action: "undo" | "accept" | "dismiss") =>
    startTransition(async () => {
      try {
        await resolveContactChange(id, action);
        toast.success(action === "undo" ? "Change undone" : action === "accept" ? "Updated" : "Dismissed");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that — try again?"));
      }
    });

  if (!suggestions.length && !applied.length) return null;

  return (
    <div className="space-y-8">
      {suggestions.length > 0 ? (
        <section className="space-y-3" aria-labelledby="contact-updates-heading">
          <div>
            <h2 id="contact-updates-heading" className="font-heading text-lg">
              Updates to check
            </h2>
            <p className="text-sm text-muted-foreground">
              Newer details for people whose info you entered yourself. Orbit never changes what
              you typed without asking.
            </p>
          </div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {suggestions.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
                <Change row={row} />
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => answer(row.id, "accept")} disabled={pending}>
                    <Check className="h-4 w-4" aria-hidden />
                    Update
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => answer(row.id, "dismiss")} disabled={pending}>
                    <X className="h-4 w-4" aria-hidden />
                    Keep mine
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {applied.length > 0 ? (
        <section className="space-y-3" aria-labelledby="changed-by-orbit-heading">
          <div>
            <h2 id="changed-by-orbit-heading" className="font-heading text-lg">
              Changed by Orbit
            </h2>
            <p className="text-sm text-muted-foreground">
              Details Orbit updated from a better source in the last 30 days. Undo puts the old
              value back and keeps it.
            </p>
          </div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {applied.map((row) => (
              <li key={row.id} className="flex items-center gap-3 p-3">
                <Change row={row} />
                <Button size="sm" variant="ghost" onClick={() => answer(row.id, "undo")} disabled={pending}>
                  <Undo2 className="h-4 w-4" aria-hidden />
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
