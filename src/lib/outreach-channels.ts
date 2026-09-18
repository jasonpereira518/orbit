import { isUnmailableAddress, type OutreachChannel } from "@/lib/outreach-types";

export function buildMailtoUrl(input: {
  email: string;
  subject?: string | null;
  body: string;
}) {
  const params = new URLSearchParams();
  if (input.subject?.trim()) params.set("subject", input.subject.trim());
  if (input.body.trim()) params.set("body", input.body.trim());
  const qs = params.toString();
  return `mailto:${encodeURIComponent(input.email)}${qs ? `?${qs}` : ""}`;
}

export function buildSmsUrl(input: { phone: string; body: string }) {
  const normalized = input.phone.replace(/[^\d+]/g, "");
  const params = new URLSearchParams();
  if (input.body.trim()) params.set("body", input.body.trim());
  const qs = params.toString();
  return `sms:${normalized}${qs ? `?${qs}` : ""}`;
}

export function buildLinkedInUrl(linkedinUrl: string) {
  const url = linkedinUrl.trim();
  if (url.startsWith("http")) return url;
  return `https://www.linkedin.com/in/${url.replace(/^\/+/, "")}`;
}

export function buildLinkedInSearchUrl(fullName: string, company?: string | null) {
  const q = [fullName, company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

export function channelLabel(channel: OutreachChannel) {
  if (channel === "email") return "Email";
  if (channel === "linkedin") return "LinkedIn";
  return "SMS";
}

export function canOpenInApp(
  channel: OutreachChannel,
  prospect: { email?: string | null; phone?: string | null; linkedinUrl?: string | null }
) {
  if (channel === "email") return Boolean(prospect.email);
  if (channel === "sms") return Boolean(prospect.phone);
  return Boolean(prospect.linkedinUrl);
}

/**
 * Whether a prospect row was invented by Orbit rather than found by Apollo.
 *
 * The no-key fallback fabricates plausible-looking people and writes them to
 * `outreach_prospects` with reserved addresses. Those rows are for showing what the
 * feature does — they are not people, and nothing may ever mail them.
 */
export function isDemoProspect(prospect: {
  externalId?: string | null;
  enrichment?: unknown;
}) {
  if (prospect.externalId?.startsWith("demo-")) return true;
  const enrichment = prospect.enrichment as { demo?: unknown } | null | undefined;
  return enrichment?.demo === true;
}

export function canAutoSend(
  channel: OutreachChannel,
  prospect: {
    email?: string | null;
    phone?: string | null;
    externalId?: string | null;
    enrichment?: unknown;
  }
) {
  if (channel === "linkedin") return false;
  // A fabricated prospect is structurally un-sendable, not merely labelled.
  //
  // This used to ask only "does the row have an email", so the red Send button rendered
  // on every demo prospect. Their addresses are `*.example.com` — reserved by RFC 2606
  // and guaranteed to hard-bounce — and the phones are the reserved 555 range. On a
  // deployment with hosted sending configured that is ten hard bounces per search, from
  // a sending domain shared with every other user. The "Demo" badge on the row was a
  // label, not a guard.
  if (isDemoProspect(prospect)) return false;
  // Checked on the address too, because the UI rows that call this carry `email` but not
  // `externalId`/`enrichment` — a flag that has to be plumbed through three components is
  // a flag that silently stops firing. The address is always present where it matters.
  if (channel === "email") {
    return Boolean(prospect.email) && !isUnmailableAddress(prospect.email!);
  }
  return Boolean(prospect.phone);
}
