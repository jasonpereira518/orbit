"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  saveProspectAsContact,
  updateProspectSelection,
} from "@/actions/outreach";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MessageEditorRow } from "@/components/outreach/message-editor-row";
import { OutreachActions } from "@/components/outreach/outreach-actions";
import { channelLabel } from "@/lib/outreach-channels";
import type { OutreachChannel } from "@/lib/outreach-types";

export type ProspectRow = {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  status: string;
  contactId: string | null;
  message?: {
    id: string;
    channel: OutreachChannel;
    subject: string | null;
    body: string;
    status: string;
  } | null;
};

export function ProspectTable({
  campaignId,
  prospects,
  defaultChannel,
  onUpdated,
}: {
  campaignId: string;
  prospects: ProspectRow[];
  defaultChannel: OutreachChannel;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const selectedIds = useMemo(
    () => prospects.filter((p) => p.status === "selected").map((p) => p.id),
    [prospects]
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleSelection(prospectId: string, checked: boolean) {
    start(async () => {
      await updateProspectSelection({
        campaignId,
        prospectIds: [prospectId],
        status: checked ? "selected" : "suggested",
      });
      onUpdated?.();
    });
  }

  function saveContact(prospectId: string) {
    start(async () => {
      try {
        const result = await saveProspectAsContact({ campaignId, prospectId });
        toast.success(result.created ? "Saved to contacts" : "Already in contacts");
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  if (!prospects.length) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
        No prospects yet. Run a search from the campaign wizard.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-border/70 bg-muted/30 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 w-10" />
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Draft</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {prospects.map((prospect) => {
              const message = prospect.message;
              const channel = (message?.channel || defaultChannel) as OutreachChannel;
              const isSelected = prospect.status === "selected";

              return (
                <tr key={prospect.id} className="border-b border-border/50 align-top">
                  <td className="px-4 py-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) =>
                        toggleSelection(prospect.id, Boolean(checked))
                      }
                      disabled={pending}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-primary">{prospect.fullName}</div>
                    <div className="text-muted-foreground">
                      {prospect.title || "—"}
                      {prospect.company ? ` @ ${prospect.company}` : ""}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline">{prospect.status}</Badge>
                      {message?.status && (
                        <Badge variant="outline">{message.status}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div>{prospect.email || "—"}</div>
                    <div>{prospect.phone || "—"}</div>
                    {prospect.linkedinUrl && (
                      <a
                        href={prospect.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        LinkedIn
                      </a>
                    )}
                    <div className="mt-2">
                      {prospect.contactId ? (
                        <Link
                          href={`/contacts/${prospect.contactId}`}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          View contact
                        </Link>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => saveContact(prospect.id)}
                          disabled={pending}
                        >
                          <UserPlus className="mr-1 h-3 w-3" />
                          Save to Orbit
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {message ? (
                      <div className="space-y-2">
                        <Badge variant="outline">{channelLabel(channel)}</Badge>
                        {expanded === prospect.id ? (
                          <MessageEditorRow
                            campaignId={campaignId}
                            prospectId={prospect.id}
                            messageId={message.id}
                            channel={channel}
                            subject={message.subject}
                            body={message.body}
                            onUpdated={onUpdated}
                          />
                        ) : (
                          <button
                            type="button"
                            className="line-clamp-3 text-left text-muted-foreground hover:text-foreground"
                            onClick={() => setExpanded(prospect.id)}
                          >
                            {message.body || "Empty draft — click to edit"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No draft</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {message && (
                      <OutreachActions
                        messageId={message.id}
                        channel={channel}
                        subject={message.subject}
                        body={message.body}
                        prospect={{
                          email: prospect.email,
                          phone: prospect.phone,
                          linkedinUrl: prospect.linkedinUrl,
                        }}
                        onUpdated={onUpdated}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function useSelectedProspectIds(prospects: ProspectRow[]) {
  return useMemo(
    () => prospects.filter((p) => p.status === "selected").map((p) => p.id),
    [prospects]
  );
}
