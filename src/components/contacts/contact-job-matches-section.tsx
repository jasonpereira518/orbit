/**
 * "A role opened where they work" — on the profile of the person it is about.
 *
 * A SERVER COMPONENT, deliberately. It is a list of links with no state, and the contact
 * page is already long enough that `npm run perf:pages` is a standing concern; shipping a
 * client bundle so that six anchors can render would be paying for interactivity nobody
 * asked for. Triage still lives in the notification bell, where `scheduleFromSuggestion`
 * and `dismissSuggestion` already are.
 *
 * Returns null when empty, unlike `ContactOpportunitiesSection` next door. That section
 * earns its space when empty because it carries an Add button; this one has no affordance,
 * so an empty card would be a heading explaining that nothing has happened.
 *
 * ## Every link here is third-party text
 *
 * The title and company came from an anonymous pull request to a public repository. They are
 * sanitized at ingest and rendered as text, never as markup. The href is re-validated as
 * https in `listJobMatchesForContact`, and — the part that matters — THE HOST IS SHOWN NEXT
 * TO THE LINK. A link whose visible label is attacker-controlled and whose destination is
 * invisible is the entire trick; printing `simplify.jobs` beside it means the label can
 * claim whatever it likes and the person can still see where they are going.
 *
 * `rel="noopener noreferrer"` is not optional here either: `noopener` denies the opened page
 * a handle on this one, and `noreferrer` keeps the referrer — which contains the contact's
 * id — from being sent to whoever is hosting the posting.
 *
 * ## `wasNotified` is read and deliberately not rendered
 *
 * The loader returns it, and `smoke-contact-job-matches` pins that suppressed matches come
 * back at all — that is the decision worth keeping. But there is no honest badge for it.
 * "Not notified" is jargon, and "New" would be a lie: a match that DID reach the bell is
 * just as likely to be unread. Somebody looking at this page wants to know which roles are
 * open, not which ones cleared a volume guard, so the field stays in the data and out of
 * the UI.
 */
import { format } from "date-fns";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ContactJobMatch } from "@/lib/jobs/contact-matches";

/** Why the company was being watched — the user's own opportunity, not the feed's wording. */
const KIND_LABEL: Record<ContactJobMatch["matchKind"], string> = {
  internship: "Internship",
  referral: "Referral",
};

export function ContactJobMatchesSection({
  contactName,
  matches,
  hasMore,
}: {
  contactName: string;
  matches: ContactJobMatch[];
  hasMore: boolean;
}) {
  if (!matches.length) return null;

  const firstName = contactName.trim().split(/\s+/)[0] || contactName;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle as="h2">Roles that opened</CardTitle>
        {/* Says WHY this is on this page. Without it the section reads as a job board that
            has appeared on a person, rather than as the consequence of an opportunity the
            person recorded themselves. */}
        <p className="text-sm text-muted-foreground">
          Found because you have an open opportunity with {firstName}.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-2">
          {matches.map((m) => (
            <li
              key={m.matchId}
              className={cn(
                "rounded-xl border border-border/60 p-3",
                !m.isOpen && "opacity-70"
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{m.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.companyName}
                    {m.locations.length > 0 && ` · ${m.locations.join(", ")}`}
                    {` · posted ${format(new Date(m.datePosted), "MMM d")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="outline" className="text-xs">
                    {KIND_LABEL[m.matchKind]}
                  </Badge>
                  {/* The feed refreshes `active` on every sweep, so this is the one thing
                      here the bell could never tell you: it fired once and never came back
                      to say the role had come down. */}
                  {!m.isOpen && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Closed
                    </Badge>
                  )}
                </div>
              </div>

              {m.url && (
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  <ExternalLink className="size-3.5" />
                  {m.isOpen ? "View posting" : "View posting (may be closed)"}
                  <span className="font-normal text-muted-foreground">{m.host}</span>
                </a>
              )}
            </li>
          ))}
        </ul>

        {/* No count: `listJobMatchesForContact` reads one row past the cap to learn that more
            exist, which is not enough to say how many, and a made-up number is worse than
            none. */}
        {hasMore && (
          <p className="text-xs text-muted-foreground">
            Older matches for {firstName} aren’t shown here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
