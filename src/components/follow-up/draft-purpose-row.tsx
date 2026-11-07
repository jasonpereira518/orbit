"use client";

/**
 * The one-line purpose Orbit picked for a draft, editable. Rendered only when there is one.
 * Once the person edits the line, the parent keeps sending it back as a verbatim `purpose` on
 * every Regenerate or channel switch (until they clear it or the contact changes); an untouched
 * line is never sent, so Regenerate still lets Orbit pick again.
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

/**
 * The line to send back as an override: only once the person has edited it. `overridden` is a
 * flag, not "differs from Orbit's pick": after a draft made with the edit, the edit comes back
 * as the pick, and comparing would silently hand the choice back to Orbit.
 */
export function editedPurpose(current: string, overridden: boolean): string | undefined {
  const t = current.trim();
  return overridden && t ? t : undefined;
}
