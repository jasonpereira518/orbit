"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { saveLeadAction } from "@/actions/leads";
import { lookupWarmLead } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import type { ParsedTarget } from "@/lib/leads/target-input";
import type { WarmPathLookup } from "@/lib/leads/warm-path";
import { toast } from "@/lib/toast";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

type Found = { raw: string; parsed: ParsedTarget; lookup: WarmPathLookup };

/** A name to prefill: the one typed, else the mailbox of an email, else nothing. */
function suggestedName(found: Found): string {
  if (found.parsed.displayName) return found.parsed.displayName;
  if (found.parsed.kind === "email" && found.parsed.email) return found.parsed.email.split("@")[0] ?? "";
  return "";
}

/** "Name, Company" keeps the company as typed; the parser kept only its lower-case key. */
function suggestedCompany(found: Found): string {
  if (found.parsed.kind !== "name_company") return "";
  return found.raw.slice(found.raw.indexOf(",") + 1).trim();
}

const LOOKUP_NOTE: Record<"no_team" | "not_sharing", string> = {
  no_team: "Join your team above to see who knows them.",
  not_sharing: "Share your network above to see who knows them — it works both ways.",
};

/**
 * One box, any identifier: who on the team knows this person, then a one-step save. An X
 * handle is looked up but not stored — a lead has no X column until one is needed.
 */
export function FindPath() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = raw.trim();
    if (!value) return;
    startSearch(async () => {
      try {
        const { parsed, lookup } = await lookupWarmLead(value);
        const next = { raw: value, parsed, lookup };
        setFound(next);
        setName(suggestedName(next));
        setCompany(suggestedCompany(next));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t look that up — try again?"));
      }
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!found) return;
    const { parsed, raw: typed } = found;
    startSave(async () => {
      try {
        const result = await saveLeadAction({
          displayName: name,
          companyName: company || null,
          email: parsed.kind === "email" ? (parsed.email ?? null) : null,
          linkedinUrl: parsed.kind === "linkedin" ? typed : null,
          phone: parsed.kind === "phone" ? typed : null,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(result.value.created ? "Saved to your leads" : "Already in your leads — updated it");
        setFound(null);
        setRaw("");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that lead — try again?"));
      }
    });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div>
        <h2 className="font-medium text-ink">Find a path</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste an email, a LinkedIn profile, a phone number, or “Name, Company”.
        </p>
      </div>
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          placeholder="jane@northwind.com"
          aria-label="Who do you want to reach?"
          maxLength={300}
          className="sm:flex-1"
        />
        <Button type="submit" disabled={searching || !raw.trim()}>
          <Search aria-hidden />
          {searching ? "Looking…" : "Find a path"}
        </Button>
      </form>

      {found && found.parsed.kind !== "empty" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4" aria-live="polite">
          {found.lookup.status === "ok" ? (
            <div className="space-y-3">
              <WarmthChip warmth={found.lookup.path.warmth} />
              <PathSummary path={found.lookup.path} companyName={company || null} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{LOOKUP_NOTE[found.lookup.status]}</p>
          )}
          {found.parsed.kind === "name" && (
            <p className="text-xs text-muted-foreground">
              A name alone can’t be matched — add their email or LinkedIn profile to find a path.
            </p>
          )}
          <form
            onSubmit={save}
            className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="lead-name">Name</Label>
              <Input id="lead-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-company">Company</Label>
              <Input id="lead-company" value={company} onChange={(event) => setCompany(event.target.value)} maxLength={200} />
            </div>
            <Button type="submit" variant="outline" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save as a lead"}
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
