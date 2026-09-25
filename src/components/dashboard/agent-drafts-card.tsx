"use client";

/**
 * Messages an assistant wrote, waiting to be sent.
 *
 * This card IS the security boundary for the MCP send tool, which makes two details
 * load-bearing rather than cosmetic:
 *
 *   - The recipient is shown in full, never truncated or hidden behind a contact's display
 *     name. "Priya" reads as safe; `priya@totally-not-evil.example` does not, and the whole
 *     point of a human approval is that the human can tell the difference.
 *   - The body is rendered as plain text, never as markup, and is editable before sending.
 *     What the user reads is exactly what goes out.
 *
 * Approve is not the default-looking action, and nothing here approves on Enter: a send is
 * irreversible, so it costs a deliberate click.
 */
import { useState, useTransition } from "react";
import { Bot, Check, ChevronDown, X } from "lucide-react";
import { approveAgentDraft, rejectAgentDraft } from "@/actions/agent-sends";
import type { AgentSendSummary } from "@/lib/agent-sends";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

export function AgentDraftsCard({ drafts }: { drafts: AgentSendSummary[] }) {
  const [rows, setRows] = useState(drafts);
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Bot className="text-muted-foreground size-4" aria-hidden />
        <CardTitle as="h2" className="text-base">
          Waiting for you to send
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Your assistant wrote {rows.length === 1 ? "this" : "these"}. Orbit has not sent
          anything — read it, edit it if you like, then send or discard.
        </p>
        {rows.map((draft) => (
          <DraftRow
            key={draft.id}
            draft={draft}
            onDone={() => setRows((prev) => prev.filter((d) => d.id !== draft.id))}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function DraftRow({ draft, onDone }: { draft: AgentSendSummary; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [pending, startTransition] = useTransition();

  function onApprove() {
    startTransition(async () => {
      try {
        const result = await approveAgentDraft(draft.id, { body });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`Sent to ${draft.toEmail}`);
        onDone();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t send that — try again?"));
      }
    });
  }

  function onReject() {
    startTransition(async () => {
      try {
        const result = await rejectAgentDraft(draft.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("Draft discarded");
        onDone();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t discard that — try again?"));
      }
    });
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {draft.subject || "(no subject)"}
          </p>
          <p className="text-muted-foreground truncate font-mono text-xs">
            to {draft.toEmail}
            {draft.contactName ? ` · ${draft.contactName}` : " · not in your contacts"}
          </p>
        </div>
        {draft.clientName ? (
          <span className="text-muted-foreground text-xs">via {draft.clientName}</span>
        ) : null}
      </div>

      {open ? (
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          aria-label="Message body"
          className="font-mono text-xs"
        />
      ) : (
        <p className="text-muted-foreground line-clamp-2 text-sm whitespace-pre-wrap">
          {body}
        </p>
      )}

      {draft.errorMessage ? (
        <p className="text-destructive text-xs" role="status">
          Last attempt didn’t send: {draft.errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          <ChevronDown className="size-4" aria-hidden />
          {open ? "Collapse" : "Read and edit"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onApprove}>
          <Check className="size-4" aria-hidden />
          Send it
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onReject}>
          <X className="size-4" aria-hidden />
          Discard
        </Button>
      </div>
    </div>
  );
}
