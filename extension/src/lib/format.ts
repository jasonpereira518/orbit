/** Human, never ISO — "6 weeks ago" reads like a person, "2026-03-04" doesn't. */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.round((Date.now() - then) / 86_400_000);

  if (days < 0) {
    const ahead = Math.abs(days);
    if (ahead === 0) return "today";
    if (ahead === 1) return "tomorrow";
    if (ahead < 14) return `in ${ahead} days`;
    if (ahead < 60) return `in ${Math.round(ahead / 7)} weeks`;
    return `in ${Math.round(ahead / 30)} months`;
  }
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return "over a year ago";
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
