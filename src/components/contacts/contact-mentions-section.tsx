import Link from "next/link";
import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ContactMentionRow } from "@/lib/contact-mentions";

function formatDate(d: Date | string) {
  return format(new Date(d), "MMM d, yyyy");
}

export function ContactMentionsSection({
  mentionedIn,
  mentions,
}: {
  mentionedIn: ContactMentionRow[];
  mentions: ContactMentionRow[];
}) {
  if (mentionedIn.length === 0 && mentions.length === 0) return null;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle as="h2">Mentioned in</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {mentionedIn.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              In notes about others
            </p>
            <ul className="space-y-1.5 text-sm">
              {mentionedIn.map((r) => (
                <li key={`${r.interactionId}-${r.otherContactId}`}>
                  {formatDate(r.interactionDate)} · in your notes about{" "}
                  <Link
                    href={`/contacts/${r.otherContactId}`}
                    className="font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {r.otherContactName}
                  </Link>{" "}
                  — {r.line}
                </li>
              ))}
            </ul>
          </div>
        )}
        {mentions.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              People named in these notes
            </p>
            <ul className="space-y-1.5 text-sm">
              {mentions.map((r) => (
                <li key={`${r.interactionId}-${r.otherContactId}`}>
                  <Link
                    href={`/contacts/${r.otherContactId}`}
                    className="font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {r.otherContactName}
                  </Link>{" "}
                  · &quot;{r.mentionText}&quot; · {formatDate(r.interactionDate)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
