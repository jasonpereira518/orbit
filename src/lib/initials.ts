/**
 * Two letters for a name: first and last word's initials, or the first two letters of a
 * one-word name. Used where a person has no photo — the constellation's stars and the import
 * done card's faces.
 */
export function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
