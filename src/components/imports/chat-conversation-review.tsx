"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChatCandidate } from "@/lib/chat-import-preview";
import type { ParticipantDecision } from "@/lib/conversations/to-rows";
import { cn } from "@/lib/utils";

/**
 * Who one participant becomes, as a select value: `c:<contactId>` links an existing contact,
 * `new` creates one, `skip` leaves the person out (groups only — a 1:1 always has a row).
 */
export type MemberChoice = `c:${string}` | "new" | "skip";

export type ReviewMember = {
  key: string;
  displayName: string;
  autoContactId: string | null;
  autoContactName: string | null;
  candidates: ChatCandidate[];
  choice: MemberChoice;
};

export type ReviewConversation = {
  key: string;
  title: string;
  isGroup: boolean;
  messageCount: number;
  firstAt: string;
  lastAt: string;
  included: boolean;
  /** Everyone but the owner. */
  members: ReviewMember[];
};

/**
 * Rule: an auto-link stands; otherwise a 1:1 is a new contact until the person picks a
 * candidate themselves — a bare-name match silently attaching a chat to the wrong person is
 * worse than a duplicate. A group member is analyzed only when linked — never created unasked.
 */
export function defaultChoice(isGroup: boolean, p: { autoContactId: string | null }): MemberChoice {
  if (p.autoContactId) return `c:${p.autoContactId}`;
  return isGroup ? "skip" : "new";
}

export function choiceToDecision(choice: MemberChoice): ParticipantDecision {
  if (choice === "new") return { contactId: null, create: true };
  if (choice === "skip") return { contactId: null, create: false };
  return { contactId: choice.slice(2), create: false };
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function formatSpan(firstAt: string, lastAt: string): string {
  const a = DAY.format(new Date(firstAt));
  const b = DAY.format(new Date(lastAt));
  return a === b ? a : `${a} – ${b}`;
}

function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function memberItems(isGroup: boolean, m: ReviewMember) {
  const items: { value: MemberChoice; label: string }[] = [];
  if (isGroup) items.push({ value: "skip", label: "Not analyzed" });
  if (m.autoContactId) {
    items.push({ value: `c:${m.autoContactId}`, label: m.autoContactName ?? "Linked contact" });
  }
  for (const c of m.candidates) {
    if (c.contactId === m.autoContactId) continue;
    items.push({ value: `c:${c.contactId}`, label: `${c.fullName} · ${c.reason}` });
  }
  items.push({ value: "new", label: "New contact" });
  return items;
}

function MemberPicker({
  isGroup,
  member,
  disabled,
  onChange,
}: {
  isGroup: boolean;
  member: ReviewMember;
  disabled: boolean;
  onChange: (choice: MemberChoice) => void;
}) {
  const [changing, setChanging] = useState(false);
  const linkedToAuto = member.autoContactId != null && member.choice === `c:${member.autoContactId}`;

  if (linkedToAuto && !changing) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          Linked to <span className="font-medium text-ink">{member.autoContactName ?? "a contact"}</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setChanging(true)}
        >
          Change
        </Button>
      </span>
    );
  }

  // Rule: a group member with nothing to link to is opted in with a box, never by default.
  if (isGroup && !member.autoContactId && member.candidates.length === 0) {
    return (
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={member.choice === "new"}
          disabled={disabled}
          onCheckedChange={(v) => onChange(v === true ? "new" : "skip")}
          aria-label={`Add ${member.displayName} as a contact`}
        />
        Add as contact
      </label>
    );
  }

  const items = memberItems(isGroup, member);
  return (
    <Select
      value={member.choice}
      onValueChange={(v) => {
        if (v) onChange(v as MemberChoice);
      }}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger aria-label={`Who ${member.displayName} is`} className="h-8 max-w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="p-1">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ChatConversationReview({
  conversations,
  disabled = false,
  onIncludedChange,
  onChoiceChange,
}: {
  conversations: ReviewConversation[];
  disabled?: boolean;
  onIncludedChange: (key: string, included: boolean) => void;
  onChoiceChange: (conversationKey: string, memberKey: string, choice: MemberChoice) => void;
}) {
  return (
    <ul className="max-h-[32rem] overflow-auto rounded-xl border border-border/60">
      {conversations.map((c, i) => (
        <li
          key={c.key}
          className={cn(
            "space-y-2 px-3 py-3 text-sm",
            i > 0 && "border-t border-border/50",
            !c.included && "opacity-55",
          )}
        >
          <div className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={c.included}
              disabled={disabled}
              onCheckedChange={(v) => onIncludedChange(c.key, v === true)}
              aria-label={`Include ${c.title}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 truncate font-medium text-ink">{c.title}</p>
                <Badge variant="outline">{c.isGroup ? "Group" : "1:1"}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {plural(c.messageCount, "message")} · {formatSpan(c.firstAt, c.lastAt)}
              </p>
            </div>
          </div>

          {c.included ? (
            <div className="space-y-2 pl-7">
              {c.isGroup ? (
                <p className="text-xs text-muted-foreground">Only people you link or add are analyzed</p>
              ) : null}
              {c.members.length === 0 ? (
                <p className="text-xs text-muted-foreground">No one else wrote in this chat</p>
              ) : (
                <ul className="space-y-1.5">
                  {c.members.map((m) => (
                    <li key={m.key} className="flex flex-wrap items-center justify-between gap-2">
                      {c.isGroup ? <span className="min-w-0 truncate text-ink">{m.displayName}</span> : null}
                      <MemberPicker
                        isGroup={c.isGroup}
                        member={m}
                        disabled={disabled}
                        onChange={(choice) => onChoiceChange(c.key, m.key, choice)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
