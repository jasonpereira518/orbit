/**
 * Messages an assistant drafted, and the approval that turns one into a sent email.
 *
 * ## The whole point is the seam in the middle
 *
 * `createAgentSendRequest` is reachable by an agent and sends nothing. `approveAgentSend` is
 * the only thing that sends, and it is reachable only from a Clerk-authenticated server
 * action — there is no MCP tool, no API key path and no token that reaches it. So the worst
 * an injected agent achieves is a draft appearing in the user's own approval list, addressed
 * to somewhere suspicious, with the body visible. That is a phishing attempt the user reads
 * before it happens, rather than an exfiltration they learn about afterwards.
 *
 * This is why the MCP surface can allow an arbitrary recipient at all. The recipient is not
 * trusted because the agent supplied it; it is trusted because a person looked at it.
 *
 * ## Why sends here count against the outreach limit
 *
 * `countSendsToday` is the product's daily cap. If assistant sends did not count, connecting
 * Claude would be a documented way around a limit the rest of Orbit enforces. They do count,
 * and closing that hole also closed the pre-existing one where contact follow-up emails
 * skipped the cap (see `countSendsToday`).
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentSendRequests, contacts, type AgentSendRequest } from "@/db/schema";
import { sanitizeAgentText } from "@/lib/mcp/sanitize";
import { getAppBaseUrl } from "@/lib/app-url";

/** How long a pending draft stands before it stops being approvable. */
export const AGENT_SEND_TTL_DAYS = 7;

/** Bodies are bounded so one tool call cannot stage a megabyte of text. */
export const MAX_BODY_CHARS = 5_000;

export type CreateAgentSendInput = {
  toEmail: string;
  subject?: string;
  body: string;
  contactId?: string;
  clientName?: string;
};

export type AgentSendSummary = {
  id: string;
  status: AgentSendRequest["status"];
  toEmail: string;
  subject: string | null;
  body: string;
  contactId: string | null;
  contactName: string | null;
  clientName: string | null;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  errorMessage: string | null;
};

function approvalUrl(): string {
  return `${getAppBaseUrl()}/dashboard`;
}

/**
 * Record a draft. Never sends, and says so in its return value.
 *
 * The contact link is resolved rather than trusted: an agent passing a `contactId` that is
 * not the caller's gets a draft with no contact attached, not someone else's row.
 */
export async function createAgentSendRequest(
  userId: string,
  input: CreateAgentSendInput
): Promise<{ id: string; approveUrl: string; expiresAt: Date }> {
  const db = await getDb();

  let contactId: string | null = null;
  if (input.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, input.contactId), eq(contacts.userId, userId)),
      columns: { id: true },
    });
    contactId = contact?.id ?? null;
  }

  const expiresAt = new Date(Date.now() + AGENT_SEND_TTL_DAYS * 86_400_000);
  const [row] = await db
    .insert(agentSendRequests)
    .values({
      userId,
      contactId,
      toEmail: input.toEmail.trim().toLowerCase(),
      // Sanitised for the same reason every other agent-written string is: the approval card
      // renders this, and hidden characters are how injected text escapes a human's notice —
      // which here would defeat the one control that matters.
      subject: input.subject ? sanitizeAgentText(input.subject).slice(0, 200) : null,
      body: sanitizeAgentText(input.body).slice(0, MAX_BODY_CHARS),
      clientName: input.clientName ? sanitizeAgentText(input.clientName).slice(0, 80) : null,
      status: "pending",
      expiresAt,
    })
    // Bare `.returning()`: an explicit field selector defeats Drizzle's overload
    // resolution against the union `Db` type (the gotcha recorded in action-items.ts).
    .returning();

  return { id: row.id, approveUrl: approvalUrl(), expiresAt };
}

function toSummary(
  row: AgentSendRequest & { contactName?: string | null }
): AgentSendSummary {
  return {
    id: row.id,
    status: row.status,
    toEmail: row.toEmail,
    subject: row.subject,
    body: row.body,
    contactId: row.contactId,
    contactName: row.contactName ?? null,
    clientName: row.clientName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    errorMessage: row.errorMessage,
  };
}

/** One draft, for the agent that asked about it or the card that renders it. */
export async function getAgentSendRequest(
  userId: string,
  id: string
): Promise<AgentSendSummary | null> {
  const db = await getDb();
  const row = await db.query.agentSendRequests.findFirst({
    where: and(eq(agentSendRequests.id, id), eq(agentSendRequests.userId, userId)),
  });
  if (!row) return null;
  return toSummary(await withExpiry(row));
}

/** Everything still awaiting a decision, newest first. */
export async function listPendingAgentSends(userId: string): Promise<AgentSendSummary[]> {
  const db = await getDb();
  await expireStale(userId);
  const rows = await db
    .select({
      row: agentSendRequests,
      contactName: contacts.fullName,
    })
    .from(agentSendRequests)
    .leftJoin(contacts, eq(contacts.id, agentSendRequests.contactId))
    .where(
      and(eq(agentSendRequests.userId, userId), eq(agentSendRequests.status, "pending"))
    )
    .orderBy(desc(agentSendRequests.createdAt))
    .limit(50);
  return rows.map(({ row, contactName }) => toSummary({ ...row, contactName }));
}

/** Count of pending drafts, for a badge. */
export async function countPendingAgentSends(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSendRequests)
    .where(
      and(
        eq(agentSendRequests.userId, userId),
        eq(agentSendRequests.status, "pending"),
        sql`${agentSendRequests.expiresAt} > now()`
      )
    );
  return row?.count ?? 0;
}

/** Mark anything past its date, so a stale row can never be approved by a late click. */
export async function expireStale(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentSendRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(agentSendRequests.userId, userId),
        eq(agentSendRequests.status, "pending"),
        lt(agentSendRequests.expiresAt, new Date())
      )
    );
}

async function withExpiry(row: AgentSendRequest): Promise<AgentSendRequest> {
  if (row.status !== "pending" || row.expiresAt > new Date()) return row;
  const db = await getDb();
  await db
    .update(agentSendRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(eq(agentSendRequests.id, row.id));
  return { ...row, status: "expired" };
}

/** Refuse a draft. The agent can read the outcome through `get_send_status`. */
export async function rejectAgentSend(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db
    .update(agentSendRequests)
    .set({ status: "rejected", decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentSendRequests.id, id),
        eq(agentSendRequests.userId, userId),
        eq(agentSendRequests.status, "pending")
      )
    )
    .returning();
  return updated.length > 0;
}

/**
 * Claim a pending draft for sending.
 *
 * The claim is the UPDATE's own WHERE clause rather than a read-then-write: two clicks on
 * the approve button, or a click racing the expiry sweep, must not both send. Only the
 * transaction that flips the row out of `pending` gets it back.
 */
export async function claimAgentSendForApproval(
  userId: string,
  id: string
): Promise<AgentSendRequest | null> {
  const db = await getDb();
  const [row] = await db
    .update(agentSendRequests)
    .set({ status: "sending", decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentSendRequests.id, id),
        eq(agentSendRequests.userId, userId),
        eq(agentSendRequests.status, "pending"),
        sql`${agentSendRequests.expiresAt} > now()`
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Record the outcome of an attempted send on a claimed row.
 *
 * A failure returns the row to `pending` rather than parking it in a terminal state. The
 * common failure is "no mailbox connected yet", which the user fixes in Settings in a minute;
 * a draft that vanished on the first attempt would make them ask their assistant to write the
 * whole thing again. The error travels with it so the card can say what went wrong.
 */
export async function finishAgentSend(
  id: string,
  result: { ok: true; deliveryId?: string } | { ok: false; error: string }
): Promise<void> {
  const db = await getDb();
  await db
    .update(agentSendRequests)
    .set(
      result.ok
        ? { status: "sent", sentAt: new Date(), deliveryId: result.deliveryId ?? null, updatedAt: new Date() }
        : {
            status: "pending" as const,
            decidedAt: null,
            errorMessage: result.error.slice(0, 500),
            updatedAt: new Date(),
          }
    )
    .where(eq(agentSendRequests.id, id));
}

/** Agent sends that went out today, for the shared daily cap. */
export async function countAgentSendsToday(userId: string): Promise<number> {
  const db = await getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSendRequests)
    .where(
      and(
        eq(agentSendRequests.userId, userId),
        eq(agentSendRequests.status, "sent"),
        sql`${agentSendRequests.sentAt} >= ${start}`
      )
    );
  return row?.count ?? 0;
}
