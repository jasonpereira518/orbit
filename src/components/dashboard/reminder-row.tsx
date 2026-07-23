"use client";

import type { ReminderActionKind } from "@/db/schema";
import { ReminderCard } from "@/components/reminders/reminder-card";

/** Dashboard wrapper around shared ReminderCard. */
export function ReminderRow({
  id,
  title,
  description,
  dueDate,
  reminderType,
  actionKind,
  contactId,
  contactName,
}: {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  actionKind?: ReminderActionKind;
  contactId?: string | null;
  contactName?: string | null;
}) {
  return (
    <ReminderCard
      id={id}
      title={title}
      description={description}
      dueDate={dueDate}
      reminderType={reminderType}
      actionKind={actionKind}
      contactId={contactId}
      contactName={contactName}
      compact
    />
  );
}
