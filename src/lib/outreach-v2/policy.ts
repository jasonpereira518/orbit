import type { Brief, Candidate, Sender } from "./types";

export function normalizeLinkedIn(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const slug = url.pathname.match(/^\/in\/([^/]+)/i)?.[1];
    return slug ? `https://www.linkedin.com/in/${slug.toLowerCase()}` : null;
  } catch {
    return null;
  }
}
export function identityKeys(input: {
  linkedinUrl?: string | null;
  email?: string | null;
  externalId?: string;
}): string[] {
  const linkedin = normalizeLinkedIn(input.linkedinUrl);
  return [
    linkedin && `linkedin:${linkedin}`,
    input.email?.trim() && `email:${input.email.trim().toLowerCase()}`,
    input.externalId && `provider:${input.externalId}`,
  ].filter((s): s is string => Boolean(s));
}
export function rankCandidate(
  person: Candidate,
  brief: Brief,
): Candidate["research"] {
  let earned = 0,
    possible = 0,
    unknown = 0,
    mismatch = false;
  const reasons: string[] = [];
  for (const rule of brief.criteria) {
    const evidence =
      rule.field === "experience"
        ? person.research.evidence.map((e) => e.excerpt).join(" ")
        : (person[rule.field] ?? "");
    const tokens = (value: string) =>
      value
        .toLowerCase()
        .replace(/designers\b/g, "designer")
        .replace(/engineers\b/g, "engineer")
        .replace(/founders\b/g, "founder")
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const available = new Set(tokens(evidence));
    const matches = tokens(rule.value).every((word) => available.has(word));
    if (rule.importance === "excluded") {
      if (matches) {
        mismatch = true;
        reasons.push(`Excluded: ${rule.value}`);
      }
      continue;
    }
    const weight = rule.importance === "required" ? 3 : 1;
    possible += weight;
    if (!evidence) {
      unknown++;
      reasons.push(`Unknown ${rule.field}: ${rule.value}`);
    } else if (matches) {
      earned += weight;
      reasons.push(`Matches ${rule.field}: ${rule.value}`);
    } else if (rule.field === "experience") {
      unknown++;
      reasons.push(`Not established by available sources: ${rule.value}`);
    } else {
      if (rule.importance === "required") mismatch = true;
      reasons.push(`Does not match ${rule.field}: ${rule.value}`);
    }
  }
  return {
    ...person.research,
    score: possible ? Math.round((100 * earned) / possible) : 0,
    reasons: [
      ...reasons,
      ...(person.research.conflicts ?? []).map(
        (c) => `Conflicting evidence: ${c}`,
      ),
    ],
    eligibility: person.research.conflicts?.length
      ? "uncertain"
      : mismatch
        ? "mismatch"
        : unknown || !possible || person.research.conflicts?.length
          ? "uncertain"
          : "match",
    confidence:
      !person.research.evidence.length ||
      unknown ||
      person.research.conflicts?.length
        ? "low"
        : person.research.evidence.length > 1
          ? "high"
          : "medium",
  };
}
export function fullBody(
  body: string,
  signature: string,
  channel: string,
): string {
  return channel === "email" && signature.trim()
    ? `${body.trim()}\n\n${signature.trim()}`
    : body.trim();
}
export function validateDraft(input: {
  channel: string;
  to: string;
  subject: string;
  body: string;
  signature: string;
  sender: Sender;
  emailStatus?: string;
}): string[] {
  const errors: string[] = [];
  if (!input.body.trim()) errors.push("Write a message first.");
  if (/\[(?:your|my|first|last|company|name)[^\]]*\]/i.test(input.body))
    errors.push("Replace the remaining placeholders.");
  if (!input.sender.address.trim())
    errors.push("Choose the actual sending account.");
  if (input.channel === "email") {
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.to))
      errors.push("A valid recipient email is required.");
    if (!input.subject.trim() || /[\r\n]/.test(input.subject))
      errors.push("Use a single-line subject.");
    if (input.emailStatus === "invalid")
      errors.push("This email address is invalid.");
  } else {
    if (!normalizeLinkedIn(input.to))
      errors.push("A LinkedIn profile URL is required.");
    if (input.body.length > input.sender.invitationLimit)
      errors.push(
        `Shorten the invitation to ${input.sender.invitationLimit} characters.`,
      );
  }
  return errors;
}
export function followUpDue(input: {
  channel: string;
  sentAt: Date | null;
  acceptedAt: Date | null;
  lastHumanReplyAt: Date | null;
  closed: boolean;
  optedOut: boolean;
  now?: Date;
}): boolean {
  const base =
    input.channel === "linkedin"
      ? input.acceptedAt &&
        new Date(
          Math.max(input.acceptedAt.getTime(), input.sentAt?.getTime() ?? 0),
        )
      : input.sentAt;
  return Boolean(
    base &&
    !input.closed &&
    !input.optedOut &&
    !input.lastHumanReplyAt &&
    (input.now ?? new Date()).getTime() - base.getTime() >= 7 * 86400000,
  );
}
export function fundingWindow(plan: string, now = new Date()) {
  return plan === "lifetime" ? "lifetime" : now.toISOString().slice(0, 7);
}
