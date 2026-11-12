/** Pure and client-importable: the Radar page reads a person find's title back on the card. */

/**
 * A person-to-meet row's title, "Name, Title at Company". `parsePersonTitle` reads it back when
 * the person is saved as a contact, so the two must change together.
 */
export function personTitle(c: { fullName: string; title?: string | null; company: string }): string {
  return `${c.fullName}${c.title ? `, ${c.title}` : ""} at ${c.company}`;
}

export function parsePersonTitle(t: string): { fullName: string; title: string | null; company: string | null } {
  const at = t.lastIndexOf(" at ");
  const head = at > 0 ? t.slice(0, at) : t;
  const comma = head.indexOf(", ");
  return {
    fullName: (comma > 0 ? head.slice(0, comma) : head).trim(),
    title: comma > 0 ? head.slice(comma + 2).trim() || null : null,
    company: at > 0 ? t.slice(at + 4).trim() || null : null,
  };
}
