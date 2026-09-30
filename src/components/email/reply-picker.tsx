"use client";

import { CornerUpLeft, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { stripReply } from "@/lib/email/reply-subject";
import type { ReplyTarget } from "@/lib/email/reply-targets";

const NEW = "new";
const SOURCE: Record<ReplyTarget["source"], string> = {
  orbit: "sent from Orbit",
  logged: "logged",
  inbox: "from your inbox",
};

function when(iso: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * New email, or a reply in one of the contact's recent conversations (direct-email P5). Off by
 * default: a new topic shouldn't land in an old thread unless the person chooses it.
 */
export function ReplyPicker({
  targets,
  value,
  onChange,
  disabled,
  currentSubject,
}: {
  targets: ReplyTarget[];
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  /** Labels a reply kept from an edited send, which isn't one of `targets`. */
  currentSubject: string;
}) {
  const kept = value && !targets.some((t) => t.key === value) ? value : null;
  if (!targets.length && !kept) return null;
  // `label` is the one-line trigger text; `detail` is a second line in the open list, so a
  // long subject wraps instead of running under the check mark on a phone.
  const items: { value: string; label: string; detail?: string }[] = [
    { value: NEW, label: "New email" },
    ...(kept ? [{ value: kept, label: `Reply to “${stripReply(currentSubject) || "(no subject)"}”` }] : []),
    ...targets.map((t) => ({
      value: t.key,
      label: `Reply to “${t.subject || "(no subject)"}”`,
      detail: `${when(t.at)} · ${SOURCE[t.source]}`,
    })),
  ];
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 border-b border-border/60 py-1">
      <CornerUpLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Select
        value={value ?? NEW}
        onValueChange={(v) => onChange(v === NEW || typeof v !== "string" ? null : v)}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Reply in thread" className="h-8 min-w-0 flex-1 border-0 px-0 shadow-none">
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="p-1">
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} className="py-1.5 pl-2 whitespace-normal">
              <span className="flex min-w-0 flex-col">
                <span className="break-words">{i.label}</span>
                {i.detail && <span className="text-xs text-muted-foreground">{i.detail}</span>}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button
          type="button"
          aria-label="Send as a new email"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
