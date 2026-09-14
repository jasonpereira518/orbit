"use client";
import { useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import * as actions from "@/actions/outreach-v2";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DraftEditor } from "./outreach-drafts";
import {
  SplitView,
  ListRow,
  Status,
  EmptyState,
  displayDate as date,
  statusLabel,
} from "./outreach-ui";
import type {
  Workspace,
  Draft,
  Act,
  DraftEdits,
  DraftEdit,
} from "./outreach-workspace-types";
export function OutreachConversations({
  data,
  due,
  pending,
  act,
  setTab,
  activeId,
  onActive,
  filter,
  onFilter,
  drafts,
  edits,
  onEdit,
  onSaved,
  onError,
  onDraft,
}: {
  data: Workspace;
  due: Workspace["conversations"];
  pending: boolean;
  act: Act;
  setTab: (tab: string) => void;
  activeId: string | null;
  onActive: (id: string | null) => void;
  filter: string;
  onFilter: (filter: string) => void;
  drafts: Draft[];
  edits: DraftEdits;
  onEdit: (id: string, edit: DraftEdit | undefined) => void;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
  onDraft: (id: string) => void;
}) {
  const id = data.campaign.id;
  const conversations = data.conversations.filter(
    (c) =>
      filter === "all" ||
      (filter === "unread" ? c.unread : due.some((d) => d.id === c.id)),
  );
  const active =
    conversations.find((c) => c.id === activeId) ?? conversations[0];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Read replies here and review your response before sending.
        </p>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            act(
              () => actions.refreshOutreachConversations(id),
              "Connected accounts are checking for replies. Browser accounts update during an active extension session.",
            )
          }
        >
          <RefreshCw size={16} />
          Check replies
        </Button>
      </div>
      {due.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted p-4">
          <p>{due.length} people may be ready for a follow-up.</p>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(async () => {
                await actions.draftOutreachMessages(
                  id,
                  due.map((c) => c.prospectId),
                  "A brief, friendly follow-up with one soft ask",
                  "follow_up",
                );
                setTab("Drafts");
              })
            }
          >
            Draft suggested follow-ups
          </Button>
        </div>
      )}
      {!data.conversations.length && (
        <p className="py-10 text-muted-foreground">
          Conversations appear after you send your first messages.
        </p>
      )}
      <div className="flex flex-wrap gap-2" aria-label="Conversation filters">
        {["all", "unread", "due"].map((f) => (
          <Button
            key={f}
            variant={filter === f ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={filter === f}
            onClick={() => onFilter(f)}
          >
            {f === "all"
              ? "All conversations"
              : f === "unread"
                ? "Needs attention"
                : "Follow-ups due"}
          </Button>
        ))}
      </div>
      {!conversations.length && data.conversations.length > 0 && (
        <EmptyState title="You’re all caught up">
          No conversations match this filter.
        </EmptyState>
      )}
      {active && (
        <SplitView
          active={activeId !== null}
          onBack={() => onActive(null)}
          label="conversations"
          list={
            <ul className="divide-y">
              {conversations.map((c) => {
                const person = data.people.find((p) => p.id === c.prospectId);
                return (
                  <li key={c.id}>
                    <ListRow
                      name={person?.fullName ?? "Conversation"}
                      detail={
                        c.messages[0]?.body ||
                        (c.acceptedAt
                          ? "Connection accepted"
                          : "Waiting for a reply")
                      }
                      active={active.id === c.id}
                      onClick={() => onActive(c.id)}
                      trailing={
                        c.unread ? <Status>New reply</Status> : undefined
                      }
                    />
                  </li>
                );
              })}
            </ul>
          }
        >
          {[active].map((c) => {
            const p = data.people.find((p) => p.id === c.prospectId);
            return (
              <section key={c.id} className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium">
                      {p?.fullName}
                      {c.unread && (
                        <span className="ml-2 text-xs text-primary">
                          New reply
                        </span>
                      )}
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last checked: {date(c.lastCheckedAt)}
                      {c.acceptedAt
                        ? ` · Connection accepted ${date(c.acceptedAt)}`
                        : ""}
                    </p>
                    {["linkedin", "gmail_web", "outlook_web"].includes(
                      data.campaign.sender?.transport ?? "",
                    ) &&
                      (!c.lastCheckedAt ||
                        new Date(data.asOf).getTime() -
                          new Date(c.lastCheckedAt).getTime() >
                          600000) && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Tracking is stale. Start a Chrome session to check
                          this conversation.
                        </p>
                      )}
                    {c.error && (
                      <p className="mt-2 text-sm text-destructive">{c.error}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={`Outcome for ${p?.fullName}`}
                      className="rounded-md border bg-background p-2 text-sm"
                      value={c.outcome ?? ""}
                      onChange={(e) =>
                        act(() =>
                          actions.updateOutreachConversation(c.id, {
                            outcome: e.target.value,
                          }),
                        )
                      }
                    >
                      <option value="" disabled>
                        No outcome yet
                      </option>
                      {[
                        "positive_reply",
                        "negative_reply",
                        "neutral_reply",
                        "unsubscribed",
                        "bounced",
                      ].map((o) => (
                        <option key={o} value={o}>
                          {statusLabel(o)}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        act(() =>
                          actions.updateOutreachConversation(c.id, {
                            closed: !c.closed,
                            unread: false,
                          }),
                        )
                      }
                    >
                      {c.closed ? "Reopen" : "Close"}
                    </Button>
                  </div>
                </div>
                <div className="mt-4 space-y-4">
                  {[...c.messages].reverse().map((m) => (
                    <article
                      key={m.id}
                      className={cn(
                        "rounded-lg p-4",
                        m.direction === "outbound"
                          ? "bg-muted/55"
                          : "border bg-background",
                      )}
                    >
                      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {m.direction === "inbound" ? p?.fullName : "You"} ·{" "}
                          {statusLabel(m.kind)}
                        </span>
                        <time>{date(m.sentAt)}</time>
                      </div>
                      {m.subject && (
                        <p className="mt-2 text-sm font-medium">{m.subject}</p>
                      )}
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                        {m.body}
                      </p>
                    </article>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      pending ||
                      c.optedOut ||
                      (data.campaign.defaultChannel === "linkedin" &&
                        !c.acceptedAt)
                    }
                    onClick={() =>
                      act(async () => {
                        await actions.draftOutreachMessages(
                          id,
                          [c.prospectId],
                          "Reply naturally to the latest incoming message",
                          "reply",
                        );
                        await actions.updateOutreachConversation(c.id, {
                          unread: false,
                        });
                        onFilter("all");
                        onActive(c.id);
                      })
                    }
                  >
                    Draft a reply
                  </Button>
                  {c.unread && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        act(() =>
                          actions.updateOutreachConversation(c.id, {
                            unread: false,
                          }),
                        )
                      }
                    >
                      Mark read
                    </Button>
                  )}
                  {c.url && (
                    <a
                      className="inline-flex items-center gap-1 px-3 py-2 text-sm underline"
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open original
                      <ArrowUpRight size={14} />
                    </a>
                  )}
                </div>
                {!c.url &&
                  ["linkedin", "gmail_web", "outlook_web"].includes(
                    data.campaign.sender?.transport ?? "",
                  ) && (
                    <ConversationLink
                      onSave={(url) =>
                        act(
                          () =>
                            actions.updateOutreachConversation(c.id, { url }),
                          "Conversation linked. Start a browser session to check replies.",
                        )
                      }
                    />
                  )}
                {(() => {
                  const reply = drafts.find(
                    (m) =>
                      m.prospectId === c.prospectId &&
                      m.messageKind === "reply",
                  );
                  return reply ? (
                    <div className="mt-6 border-t">
                      <DraftEditor
                        message={reply}
                        edit={edits[reply.id]}
                        onEdit={(edit) => onEdit(reply.id, edit)}
                        onSaved={onSaved}
                        onError={onError}
                      />
                      <Button
                        variant="outline"
                        className="mx-5 mb-5"
                        onClick={() => {
                          onDraft(reply.id);
                          setTab("Drafts");
                        }}
                      >
                        Review approval & send
                      </Button>
                    </div>
                  ) : null;
                })()}
              </section>
            );
          })}
        </SplitView>
      )}
    </div>
  );
}
function ConversationLink({ onSave }: { onSave: (url: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <div className="mt-4 flex flex-wrap items-end gap-2">
      <label className="min-w-48 flex-1 text-sm">
        Link the original conversation
        <Input
          className="mt-1"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste its Gmail, Outlook, or LinkedIn URL"
        />
      </label>
      <Button
        variant="outline"
        disabled={!url.trim()}
        onClick={() => onSave(url)}
      >
        Save link
      </Button>
    </div>
  );
}
