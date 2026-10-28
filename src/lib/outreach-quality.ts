/** Sample prospects in the demo workspace (`enrichment.demo`): never sent to. */
export function isDemoProspect(enrichment: unknown): boolean {
  return Boolean(
    enrichment &&
      typeof enrichment === "object" &&
      (enrichment as Record<string, unknown>).demo === true
  );
}

/**
 * Domains reserved so that nobody can receive mail there (RFC 2606, RFC 6761). Sample
 * prospects live under example.com, so this is also the last line of defence for a sample
 * whose `demo` flag was lost on the way to a contact.
 */
export function isPlaceholderAddress(email: string | null | undefined): boolean {
  const domain = email?.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return false;
  return (
    /(^|\.)example\.(com|net|org)$/.test(domain) ||
    /\.(example|test|invalid|localhost)$/.test(domain)
  );
}

export const DEMO_PROSPECT_SEND_MESSAGE =
  "This is a sample prospect Orbit made up, so there’s no real inbox to send to";

/** A URL, a bare domain path, or an email address — anything a click or a reply could go to. */
const LINK_OR_ADDRESS =
  /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b[a-z0-9-]+\.(?:com|io|co|net|org|ai|app|dev|xyz|ly|me)\/[^\s<>"')\]]*/i;

/**
 * The first link or address in a draft, or null. A model writing over other people's text
 * (an email, an invite, an enrichment) can be talked into planting one, and the person then
 * sends it from their own mailbox — so every surface showing an AI draft surfaces this.
 */
export function findLinkOrAddress(text: string): string | null {
  return LINK_OR_ADDRESS.exec(text)?.[0] ?? null;
}
