"use client";

import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactNextSteps, type OpenActionItem } from "@/components/contacts/contact-next-steps";
import { flashSection } from "@/components/layout/section-flash";
import type { RecentDiscussion } from "@/lib/contact-brief";

/**
 * Scrolls the timeline to the interaction a "recent discussion" line came from and glows it.
 *
 * This used to be a bare `#interaction-<id>` anchor, which did nothing useful: the row lives
 * inside the timeline's own scroll container, and a same-page fragment click changes neither
 * the pathname nor fires `hashchange` under Next's router, so the global flash never armed.
 */
function revealInteraction(interactionId: string) {
  const el = document.getElementById(`interaction-${interactionId}`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  flashSection(`interaction-${interactionId}`);
}

export function ContactBriefCard({ contactId, standing, recentDiscussions, nextSteps, stale }: {
  contactId: string; standing: string | null; recentDiscussions: RecentDiscussion[]; nextSteps: OpenActionItem[]; stale: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="border-b border-border/50">
        <CardTitle as="h2">Where things stand</CardTitle>
        <CardAction>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={pending}
            onClick={() => start(async () => {
              try { await regenerateContactSummary(contactId); router.refresh(); }
              catch (err) { toast.error(err instanceof Error ? err.message : "Could not refresh"); }
            })}>
            <RefreshCw className="size-3.5" /> {stale ? "Updating…" : "Refresh"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5 pt-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink">
            {standing ?? "Log an interaction below and the brief will write itself from your notes."}
          </p>
          {recentDiscussions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent discussions</p>
              <ul className="space-y-1 text-sm">
                {recentDiscussions.map((d) => (
                  <li key={d.interactionId} className="flex gap-2">
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer tabular-nums text-muted-foreground hover:text-primary"
                      onClick={() => revealInteraction(d.interactionId)}
                    >
                      {/* local noon: a date-time string without a zone parses as local time */}
                      {format(new Date(`${d.dateIso}T12:00:00`), "MMM d")}
                    </button>
                    <span className="text-ink">{d.line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open next steps</p>
          <ContactNextSteps items={nextSteps} />
        </div>
      </CardContent>
    </Card>
  );
}
