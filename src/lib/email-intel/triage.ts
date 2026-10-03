/**
 * Decides what the email-insights sweep keeps of one Gmail thread. Pure: no database, no
 * network, no model. It wraps the recruiter triage that was committed as v2 groundwork
 * (`triageThread`, `deriveAtsStage`) and turns its verdict into a storable result.
 *
 * Only headers and Gmail's short preview are read, never a body. A thread judged irrelevant
 * comes back `skipped` with nothing about it kept, so it is remembered by id alone and never
 * fetched again, without becoming a record of the person's private mail.
 */
import type { GmailHeaderSummary, GmailThreadSummary } from "@/lib/gmail";
import { ATS_SENDER_DOMAINS } from "@/lib/gmail";
import { deriveAtsStage, triageThread } from "@/lib/recruiter-triage";
import { STAGE_LABELS } from "@/lib/recruiter-stages";
import type { RuleEvent, ThreadResult } from "./types";

const EVIDENCE_MAX = 200;
/** Second-level suffixes where the company label is one further left. */
const TWO_PART_TLDS = new Set(["co.uk", "com.au", "co.nz", "co.jp", "co.in", "com.br"]);
const EMAIL_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

function domainOf(from: string): string {
  return from.match(/@([^\s>]+)/)?.[1]?.toLowerCase() ?? "";
}

/**
 * The company a sender belongs to, or null when the sender is an applicant-tracking platform
 * (greenhouse.io is not the employer) or has no usable domain.
 */
export function companyFromSender(from: string): string | null {
  const domain = domainOf(from);
  if (!domain) return null;
  if (ATS_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const label = TWO_PART_TLDS.has(lastTwo) ? labels[labels.length - 3] : labels[labels.length - 2];
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function participantsOf(headers: GmailHeaderSummary[], userEmail: string): string[] {
  const me = userEmail.trim().toLowerCase();
  const seen = new Set<string>();
  for (const h of headers) {
    for (const found of `${h.from} ${h.to}`.match(EMAIL_RE) ?? []) {
      const email = found.toLowerCase();
      if (email !== me) seen.add(email);
    }
  }
  return [...seen];
}

function ruleEvent(headers: GmailHeaderSummary[], userEmail: string): RuleEvent | null {
  const me = userEmail.trim().toLowerCase();
  const inbound = headers.filter((h) => !(me && h.from.toLowerCase().includes(me)));
  const latest = inbound[inbound.length - 1];
  if (!latest) return null;
  const stage = deriveAtsStage(`${latest.subject} ${latest.snippet}`);
  if (!stage) return null;
  const company = companyFromSender(latest.from);
  const label = STAGE_LABELS[stage];
  const preview = (latest.snippet.trim() || latest.subject.trim()).slice(0, EVIDENCE_MAX);
  return {
    kind: "process_update",
    stage,
    company,
    summary: company ? `${label} — ${company}` : label,
    evidenceQuote: preview,
    occurredAt: new Date(latest.internalDate ?? Date.now()),
    confidence: 0.9,
  };
}

export function assessThread(thread: GmailThreadSummary, userEmail: string): ThreadResult {
  const headers = thread.messages;
  const last = headers[headers.length - 1];
  const base = {
    threadId: thread.id,
    lastMessageId: last?.id ?? "",
    lastDirection: "in" as "in" | "out",
  };
  if (!last) {
    return { ...base, subject: "", participants: [], decision: "skipped", triageScore: 0, event: null };
  }

  const me = userEmail.trim().toLowerCase();
  base.lastDirection = me && last.from.toLowerCase().includes(me) ? "out" : "in";

  const outcome = triageThread({ headers, userEmail });
  if (outcome.decision !== "ats_rule" && outcome.decision !== "classify") {
    return { ...base, subject: "", participants: [], decision: "skipped", triageScore: outcome.score, event: null };
  }
  return {
    ...base,
    subject: (headers[0]?.subject ?? "").trim(),
    participants: participantsOf(headers, userEmail),
    decision: outcome.decision,
    triageScore: outcome.score,
    event: outcome.decision === "ats_rule" ? ruleEvent(headers, userEmail) : null,
  };
}
