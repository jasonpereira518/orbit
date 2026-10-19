"use client";

import { IntegrationLogo } from "@/components/integrations/integration-logo";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Mailbox, MailboxId } from "@/lib/email/sender";

/** Pick which connected mailbox sends. Only mailboxes that can send right now are offered. */
export function MailboxSelect({
  mailboxes,
  value,
  onChange,
  disabled,
  label = "Send from",
}: {
  mailboxes: Mailbox[];
  value: MailboxId;
  onChange: (id: MailboxId) => void;
  disabled?: boolean;
  label?: string;
}) {
  const items = mailboxes
    .filter((m) => m.canSend)
    .map((m) => ({
      value: m.id,
      label: (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <IntegrationLogo provider={m.id} size="sm" tile={false} title="" />
          <span className="truncate">{m.email}</span>
        </span>
      ),
    }));
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === "gmail" || v === "outlook") onChange(v);
      }}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className="h-8 max-w-full min-w-0">
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
