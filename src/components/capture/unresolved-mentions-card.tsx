import Link from "next/link";

import { listUnresolvedMentions } from "@/actions/capture";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { timelineDayLabel } from "@/lib/timeline-date";

/**
 * People your notes named who are still not in your network.
 *
 * The capture *results* page already lists these, but that page is a receipt for one paste
 * — you see it once and never again, so a name you did not act on in that moment is simply
 * lost. This is the standing version, on the page whose whole job is turning notes into
 * contacts. Anyone you have since added drops off, which is what keeps it from becoming a
 * list of things you already did.
 *
 * Renders nothing when there is nothing outstanding: an empty card on the capture page
 * would be a permanent reminder that the feature exists, which is not the same as useful.
 */
export async function UnresolvedMentionsCard() {
  const mentions = await listUnresolvedMentions().catch(() => []);
  if (!mentions.length) return null;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle as="h2" className="text-base">
          Mentioned in your notes, not in your network
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {mentions.map((m) => (
          <div
            key={m.text.toLowerCase()}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
          >
            <span className="min-w-0">
              <span className="font-medium text-ink">{m.text}</span>
              {m.context && (
                <span className="text-muted-foreground"> — {m.context}</span>
              )}
            </span>
            <span className="flex shrink-0 items-baseline gap-3">
              <span className="text-xs text-muted-foreground">
                {timelineDayLabel(m.noteAt)}
              </span>
              {/* Same destination the results page uses, so the two agree about where
                  "add this person" goes. */}
              <Link
                href="/capture?mode=structured"
                className="text-xs text-primary underline"
              >
                Add
              </Link>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
