"use client";

/**
 * The one-line purpose Orbit picked for a draft, editable. Rendered only when there is one.
 * The parent sends an edited line back as a verbatim `purpose`; an untouched one is never
 * sent, so Regenerate still lets Orbit pick again.
 */
export function DraftPurposeRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 font-medium text-muted-foreground">Purpose</span>
      <input
        type="text"
        value={value}
        maxLength={140}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-border/70 bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </label>
  );
}

/** The line to send back as an override: only when the person changed it. */
export function editedPurpose(current: string, picked: string): string | undefined {
  const t = current.trim();
  return t && t !== picked ? t : undefined;
}
