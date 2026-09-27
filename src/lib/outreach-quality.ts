import type { OutreachChannel } from "@/lib/outreach-types";

/** Prospects Orbit invented because no Apollo key was available (`enrichment.demo`). */
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
export const PLACEHOLDER_ADDRESS_SEND_MESSAGE =
  "That’s a placeholder address, so there’s no real inbox to send to";

/**
 * Where a searched prospect lands. "selected" is the queue drafts and sends work from, so a
 * sample is never put there — someone has to pick it by hand, and even then it cannot send.
 */
export function prospectSearchStatus(input: {
  matchesOrg: boolean;
  isDemo: boolean;
}): "selected" | "suggested" | "excluded" {
  if (!input.matchesOrg) return "excluded";
  return input.isDemo ? "suggested" : "selected";
}

export type QualityGateRow = {
  messageId: string;
  prospectId: string;
  prospectName?: string;
  channel: OutreachChannel;
  subject: string | null;
  body: string;
  isDemo?: boolean;
};

export type QualityIssue = {
  messageId: string;
  prospectId: string;
  prospectName?: string;
  code:
    | "empty_body"
    | "empty_subject"
    | "duplicate_body"
    | "missing_name"
    | "too_generic"
    | "demo_prospect"
    | "contains_link";
  message: string;
};

/** A URL, a bare domain path, or an email address — anything a click or a reply could go to. */
const LINK_OR_ADDRESS =
  /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b[a-z0-9-]+\.(?:com|io|co|net|org|ai|app|dev|xyz|ly|me)\/[^\s<>"')\]]*/i;

function normalizeBody(body: string) {
  return body.trim().toLowerCase().replace(/\s+/g, " ");
}

export function assessOutreachQuality(rows: QualityGateRow[]): {
  issues: QualityIssue[];
  warnings: QualityIssue[];
  blocking: QualityIssue[];
} {
  const issues: QualityIssue[] = [];
  const bodyCounts = new Map<string, string[]>();

  for (const row of rows) {
    if (row.isDemo) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "demo_prospect",
        message: DEMO_PROSPECT_SEND_MESSAGE,
      });
    }
    const body = row.body?.trim() || "";
    if (!body) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "empty_body",
        message: "Message body is empty",
      });
    }

    if (row.channel === "email" && !row.subject?.trim()) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "empty_subject",
        message: "Email is missing a subject",
      });
    }

    if (body) {
      const key = normalizeBody(body);
      const list = bodyCounts.get(key) || [];
      list.push(row.messageId);
      bodyCounts.set(key, list);
    }

    const firstName = row.prospectName?.trim().split(/\s+/)[0];
    if (firstName && body && !body.toLowerCase().includes(firstName.toLowerCase())) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "missing_name",
        message: `Draft does not mention ${firstName}`,
      });
    }

    if (
      body &&
      /^(hi|hello|hey)[,!]?\s+(there|all|team)/i.test(body) &&
      body.length < 80
    ) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "too_generic",
        message: "Draft looks generic — add a specific hook",
      });
    }
  }

  for (const row of rows) {
    // Drafts are model output over third-party data — a prospect's enrichment, prior notes —
    // and a link or address in one is the payload an injection would plant: the user's own
    // mailbox sending a stranger's URL. Not blocking (plenty of real outreach links a
    // calendar), but a warning the bulk send must be explicitly told to ignore, and first in
    // line so it is the one the confirm shows.
    const text = `${row.subject ?? ""}\n${row.body ?? ""}`;
    const link = LINK_OR_ADDRESS.exec(text)?.[0];
    if (link) {
      issues.unshift({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "contains_link",
        message: `Draft contains a link or address (${link.slice(0, 60)}) — check it before sending`,
      });
    }
  }

  for (const [, ids] of bodyCounts) {
    if (ids.length < 2) continue;
    for (const messageId of ids) {
      const row = rows.find((r) => r.messageId === messageId);
      if (!row) continue;
      issues.push({
        messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "duplicate_body",
        message: `Identical body shared across ${ids.length} prospects`,
      });
    }
  }

  const blockingCodes = new Set(["empty_body", "empty_subject", "demo_prospect"]);
  const blocking = issues.filter((i) => blockingCodes.has(i.code));
  const warnings = issues.filter((i) => !blockingCodes.has(i.code));

  return { issues, warnings, blocking };
}
