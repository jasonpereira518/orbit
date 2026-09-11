import { isUnmailableAddress, type OutreachChannel } from "@/lib/outreach-types";

export type QualityGateRow = {
  messageId: string;
  prospectId: string;
  prospectName?: string;
  channel: OutreachChannel;
  subject: string | null;
  body: string;
  /** The recipient address, when the caller has it. Used for the demo-recipient gate. */
  toEmail?: string | null;
  /** True when this prospect was fabricated by the no-Apollo-key fallback. */
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
    | "demo_recipient";
  message: string;
};

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
    if (row.isDemo || (row.toEmail && isUnmailableAddress(row.toEmail))) {
      issues.push({
        messageId: row.messageId,
        prospectId: row.prospectId,
        prospectName: row.prospectName,
        code: "demo_recipient",
        message:
          "This is a demo example, not a real person. Add an Apollo API key in Settings to search real prospects.",
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

  // Blocking, not a warning: a fabricated prospect is not a person, and no amount of
  // "send anyway" should mail one. The gate previously stopped only on an empty body or
  // subject, so demo rows sailed through it.
  const blockingCodes = new Set([
    "empty_body",
    "empty_subject",
    "demo_recipient",
  ]);
  const blocking = issues.filter((i) => blockingCodes.has(i.code));
  const warnings = issues.filter((i) => !blockingCodes.has(i.code));

  return { issues, warnings, blocking };
}
