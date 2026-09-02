"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import { searchContactsForPicker } from "@/actions/contacts";
import {
  dismissUnresolvedMention,
  resolveUnresolvedMentionToContact,
  type UnresolvedMentionRow,
} from "@/actions/unresolved-mentions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type ContactOption = { id: string; fullName: string; preferredName: string | null };

function addAsContactHref(m: UnresolvedMentionRow) {
  const params = new URLSearchParams({ name: m.mentionText });
  if (m.context) params.set("context", m.context);
  params.set("mentionId", m.id);
  return `/contacts/new?${params.toString()}`;
}

export function UnresolvedMentionsReview({ mentions: initial }: { mentions: UnresolvedMentionRow[] }) {
  const [mentions, setMentions] = useState(initial);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [linking, setLinking] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    searchContactsForPicker()
      .then((rows) => setContacts(rows.map((c) => ({ id: c.id, fullName: c.fullName, preferredName: c.preferredName }))))
      .catch(() => toast.error("Could not load contacts"));
  }, []);

  function remove(id: string) {
    setMentions((prev) => prev.filter((m) => m.id !== id));
  }

  function link(m: UnresolvedMentionRow) {
    const contactId = linking[m.id];
    if (!contactId) {
      toast.error("Pick a contact first");
      return;
    }
    start(async () => {
      try {
        await resolveUnresolvedMentionToContact(m.id, contactId);
        toast.success(`Linked to ${contacts.find((c) => c.id === contactId)?.fullName ?? "contact"}`);
        remove(m.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not link");
      }
    });
  }

  function dismiss(m: UnresolvedMentionRow) {
    start(async () => {
      try {
        await dismissUnresolvedMention(m.id);
        remove(m.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not dismiss");
      }
    });
  }

  if (mentions.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to review — every mention is linked or dismissed.</p>;
  }

  return (
    <div className="space-y-3">
      {mentions.map((m) => (
        <Card key={m.id} className="border-border/70 shadow-none">
          <CardContent className="space-y-3 pt-4">
            <div className="text-sm">
              <span className="font-medium text-ink">&ldquo;{m.mentionText}&rdquo;</span>
              {m.context && <span className="text-muted-foreground"> — {m.context}</span>}
              {m.nearContactName && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Found in your note about{" "}
                  {m.nearContactId ? (
                    <Link href={`/contacts/${m.nearContactId}`} className="text-primary underline">
                      {m.nearContactName}
                    </Link>
                  ) : (
                    m.nearContactName
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Link to existing contact"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={linking[m.id] ?? ""}
                onChange={(e) => setLinking((prev) => ({ ...prev, [m.id]: e.target.value }))}
              >
                <option value="">Link to existing contact…</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.preferredName || c.fullName}
                  </option>
                ))}
              </select>
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => link(m)}>
                Link
              </Button>
              <Link href={addAsContactHref(m)}>
                <Button type="button" size="sm" variant="outline">
                  Add as new contact
                </Button>
              </Link>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => dismiss(m)}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
