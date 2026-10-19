"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { getEvidenceSnippet } from "@/actions/chat";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { IntegrationLogo } from "@/components/integrations/integration-logo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { interactionTypeLabel } from "@/lib/interaction-types";
import { cn } from "@/lib/utils";

type Snippet = Awaited<ReturnType<typeof getEvidenceSnippet>>;

const CHIP =
  "mx-0.5 inline-flex size-4 -translate-y-0.5 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground align-super";

/**
 * A `[eN]` marker in an answer, rendered as a small numbered chip. Hovering or clicking it
 * fetches the snippet behind it live — nothing about the source is on the wire until then,
 * and a deleted or edited note reads as "removed" or shows what it says today rather than a
 * stale copy written down when the answer was.
 *
 * Without `messageId` (the answer is still streaming, so there is no saved row to read the
 * source from yet) it is the same chip, numbered, with nothing to open.
 */
export function SourceChip({ messageId, id, number }: { messageId?: string; id: string; number: number }) {
  if (!messageId) {
    return (
      <span className={CHIP} aria-label={`Source ${number}`}>
        {number}
      </span>
    );
  }
  return <LiveSourceChip messageId={messageId} id={id} number={number} />;
}

function LiveSourceChip({ messageId, id, number }: { messageId: string; id: string; number: number }) {
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function load() {
    if (snippet || loading) return;
    setLoading(true);
    try {
      setSnippet(await getEvidenceSnippet(messageId, id));
    } catch {
      setSnippet({ found: false });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={200}
        className={cn(CHIP, "transition-colors hover:bg-primary hover:text-primary-foreground")}
        aria-label={`Source ${number}`}
      >
        {number}
      </PopoverTrigger>
      <PopoverContent className="w-64" side="top">
        {!snippet || loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> Loading…
          </p>
        ) : !snippet.found ? (
          <p className="text-xs text-muted-foreground">That note has been removed.</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-xs">
            {snippet.kind === "meeting" ? (
              <p className="font-medium text-foreground">{snippet.title}</p>
            ) : (
            <div className="flex items-center gap-2">
              {snippet.contactId && (
                <ContactAvatar
                  contactId={snippet.contactId}
                  fullName={snippet.contactName ?? ""}
                  profileImageUrl={null}
                  size="sm"
                  className="size-6 shrink-0"
                />
              )}
              <span className={cn("min-w-0 flex-1 truncate font-medium text-foreground", !snippet.contactId && "text-muted-foreground")}>
                {snippet.contactName ?? "Not tied to a contact"}
              </span>
            </div>
            )}
            {snippet.kind === "meeting" && <p className="text-muted-foreground">{snippet.date} · Recorded meeting</p>}
            {snippet.kind === "interaction" && (
              <p className="flex items-center gap-1 text-muted-foreground">
                {snippet.date} ·{" "}
                {/* A source that came from a provider shows that provider's mark. */}
                {snippet.interactionType === "linkedin_message" && (
                  <IntegrationLogo provider="linkedin" size="sm" tile={false} title="" />
                )}
                {interactionTypeLabel(snippet.interactionType)}
              </p>
            )}
            {snippet.snippet && <p className="leading-relaxed text-foreground">{snippet.snippet}</p>}
            {snippet.kind === "meeting" && (
              <Link href={`/meetings/${snippet.meetingId}`} className="mt-0.5 text-primary underline underline-offset-2">
                Open meeting
              </Link>
            )}
            {snippet.contactId && (
              <Link
                href={
                  snippet.kind === "interaction"
                    ? `/contacts/${snippet.contactId}?interaction=${snippet.interactionId}`
                    : `/contacts/${snippet.contactId}`
                }
                className="mt-0.5 text-primary underline underline-offset-2"
              >
                Open in profile
              </Link>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
