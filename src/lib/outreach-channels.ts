import { REPLY_CTA_LABELS, type OutreachChannel, type OutreachReplyCta } from "@/lib/outreach-types";

export function buildLinkedInUrl(linkedinUrl: string) {
  const url = linkedinUrl.trim();
  if (url.startsWith("http")) return url;
  return `https://www.linkedin.com/in/${url.replace(/^\/+/, "")}`;
}

/** The shape `addProspects` accepts for a LinkedIn profile: https, `/in/<slug>`, no query. */
const LINKEDIN_PROFILE = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{2,100}\/?$/;

/**
 * A LinkedIn profile link from whatever was pasted or found: "linkedin.com/in/jane", an http
 * link, or one with tracking after the `?`. Null when it is not a profile page, which is how a
 * company page or a search result is kept from being stored as a person.
 */
export function asLinkedInProfile(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().replace(/[?#].*$/, "");
  if (!/linkedin\.com\//i.test(text)) return null;
  const url = text.replace(/^(?:https?:\/\/)?/i, "https://");
  return LINKEDIN_PROFILE.test(url) ? url : null;
}

export function buildLinkedInSearchUrl(fullName: string, company?: string | null) {
  const q = [fullName, company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

export function channelLabel(channel: OutreachChannel) {
  return channel === "email" ? "Email" : "LinkedIn";
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The campaign header's badges as words, in order: status, channel, tone, and the ask when there is one. */
export function campaignHeaderLabels(campaign: {
  status: string;
  defaultChannel: string | null;
  tone: string | null;
  replyCta: string | null;
}): string[] {
  const { replyCta } = campaign;
  return [
    sentenceCase(campaign.status),
    channelLabel((campaign.defaultChannel || "email") as OutreachChannel),
    sentenceCase(campaign.tone || "professional"),
    // An ask this build doesn’t know (an older value) still reads as words.
    ...(replyCta ? [REPLY_CTA_LABELS[replyCta as OutreachReplyCta] ?? sentenceCase(replyCta.replaceAll("_", " "))] : []),
  ];
}
