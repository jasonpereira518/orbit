export const MET_CONTEXTS = [
  "event",
  "introduction",
  "work",
  "school",
  "online",
  "other",
] as const;

export type MetContext = (typeof MET_CONTEXTS)[number];

export const MET_CONTEXT_LABELS: Record<MetContext, string> = {
  event: "Event",
  introduction: "Introduction",
  work: "Work",
  school: "School",
  online: "Online",
  other: "Other",
};

export function isMetContext(value: string | null | undefined): value is MetContext {
  return MET_CONTEXTS.includes(value as MetContext);
}

export function metContextLabel(value: string | null | undefined) {
  if (!value || !isMetContext(value)) return null;
  return MET_CONTEXT_LABELS[value];
}

export function formatHowMetSummary(input: {
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
}) {
  const parts: string[] = [];
  const context = metContextLabel(input.metContext);
  if (context) parts.push(context);

  if (input.dateMet) {
    const d =
      typeof input.dateMet === "string" ? new Date(input.dateMet) : input.dateMet;
    if (!Number.isNaN(d.getTime())) {
      parts.push(
        d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      );
    }
  }

  const details = input.howMet?.trim();
  if (details) parts.push(details);

  return parts.length > 0 ? parts.join(" · ") : null;
}
