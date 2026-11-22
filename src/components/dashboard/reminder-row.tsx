"use client";

import type { ReminderActionKind, ReminderPriority, ReminderCategory } from "@/db/schema";
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
  noteBatchId,
  priority,
  category,
  timingRationale,
  importanceReason,
}: {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  actionKind?: ReminderActionKind;
  contactId?: string | null;
  contactName?: string | null;
  noteBatchId?: string | null;
  priority?: ReminderPriority;
  category?: ReminderCategory;
  timingRationale?: string | null;
  importanceReason?: string | null;
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
      noteBatchId={noteBatchId}
      priority={priority}
      category={category}
      timingRationale={timingRationale}
      importanceReason={importanceReason}
      compact
    />
  );
}
