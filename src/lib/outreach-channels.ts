import type { OutreachChannel } from "@/lib/outreach-types";

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

export function canAutoSend(
  channel: OutreachChannel,
  prospect: { email?: string | null; phone?: string | null }
) {
  if (channel === "linkedin") return false;
  if (channel === "email") return Boolean(prospect.email);
  return Boolean(prospect.phone);
}
