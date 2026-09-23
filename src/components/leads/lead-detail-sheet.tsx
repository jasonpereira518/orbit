"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RotateCcw, UserPlus, X } from "lucide-react";
import { convertLeadAction, setLeadStatusAction } from "@/actions/leads";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { LeadStatus } from "@/db/schema";
import { friendlyError } from "@/lib/errors";
import { introRequestMailto } from "@/lib/leads/intro-request";
import type { PipelineRow } from "@/lib/leads/pipeline";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL } from "./labels";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

export function LeadDetailSheet({ row, onClose }: { row: PipelineRow | null; onClose: () => void }) {
  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="sm:max-w-md">
        {row ? <LeadDetail row={row} /> : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * One lead: who knows them, an intro ask per teammate who does (a mailto — the teammate's
 * email appears only inside that link), and the two decisions: add to contacts, or dismiss.
 */
function LeadDetail({ row }: { row: PipelineRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { lead, path } = row;
  const askable = (path?.direct ?? []).flatMap((d) =>
    d.teammate.email ? [{ userId: d.teammate.userId, name: d.teammate.name, email: d.teammate.email }] : []
  );

  function setStatus(status: LeadStatus, done: string) {
    start(async () => {
      try {
        const result = await setLeadStatusAction(lead.id, status);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(done);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update that lead — try again?"));
      }
    });
  }

  function convert() {
    start(async () => {
      try {
        const result = await convertLeadAction(lead.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${lead.displayName} is in your contacts`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t add them to your contacts — try again?"));
      }
    });
  }

  /** The mail client opens from the link itself; this only records that the ask happened. */
  function recordAsk() {
    if (pending) return;
    if (lead.status === "open") setStatus("intro_requested", "Marked as intro asked");
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-ink">{lead.displayName}</SheetTitle>
        <SheetDescription>
          {[lead.title, lead.companyName].filter(Boolean).join(" · ") || LEAD_SOURCE_LABEL[lead.source]}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {path ? <WarmthChip warmth={path.warmth} /> : null}
          <span className="text-xs text-muted-foreground">
            {LEAD_STATUS_LABEL[lead.status]} · {LEAD_SOURCE_LABEL[lead.source]}
          </span>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Who knows them</h3>
          {path ? (
            <PathSummary path={path} companyName={lead.companyName} />
          ) : (
            <p className="text-muted-foreground">Join your team and share your network to see who knows them.</p>
          )}
        </section>

        {askable.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ask for an intro</h3>
            <p className="text-xs text-muted-foreground">Opens an email to your teammate, ready to send.</p>
            <div className="flex flex-wrap gap-2">
              {askable.map((mate) => (
                <a
                  key={mate.userId}
                  href={introRequestMailto({
                    teammateName: mate.name,
                    teammateEmail: mate.email,
                    leadName: lead.displayName,
                    leadCompany: lead.companyName,
                  })}
                  aria-disabled={pending ? "true" : undefined}
                  tabIndex={pending ? -1 : undefined}
                  onClick={(event) => {
                    if (pending) {
                      event.preventDefault();
                      return;
                    }
                    recordAsk();
                  }}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), pending && "pointer-events-none opacity-50")}
                >
                  <Mail aria-hidden />
                  Ask {mate.name.trim().split(/\s+/)[0]}
                </a>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          {lead.contactId ? (
            <Link href={`/contacts/${lead.contactId}`} className={buttonVariants({ size: "sm" })}>
              Open contact
            </Link>
          ) : (
            <Button type="button" size="sm" disabled={pending} onClick={convert}>
              <UserPlus aria-hidden />
              Add to contacts
            </Button>
          )}
          {lead.status === "dismissed" ? (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setStatus("open", "Lead reopened")}>
              <RotateCcw aria-hidden />
              Reopen
            </Button>
          ) : lead.status !== "converted" ? (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setStatus("dismissed", "Lead dismissed")}>
              <X aria-hidden />
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
