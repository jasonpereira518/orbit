import { getDb } from "@/db";
import { accountAuditLog } from "@/db/schema";

/**
 * The account holder's own audit trail (audit L-23): see `accountAuditLog` in the schema for
 * what it records and why it outlives the account.
 *
 * Best-effort by design. The action it describes has already happened (or is about to, for a
 * deletion), and failing a key revocation or an export because its audit row could not be
 * written would be the wrong way round — so a failed write is logged and swallowed.
 */
export type AccountAuditAction =
  | "api_key.create"
  | "api_key.revoke"
  | "data.export"
  | "account.delete"
  | "integration.connect"
  | "integration.disconnect"
  | "plan.change"
  | "webhook.secret_rotate";

export type AccountAuditInput = {
  userId: string;
  action: AccountAuditAction;
  actor?: "user" | "stripe" | "clerk" | "system";
  resourceType?: string | null;
  resourceId?: string | null;
  /** Ids, labels and counts only: never a token, key, address or message content. */
  detail?: Record<string, unknown>;
};

export async function recordAccountAudit(input: AccountAuditInput): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(accountAuditLog).values({
      subjectUserId: input.userId,
      actor: input.actor ?? "user",
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      detail: input.detail ?? {},
    });
  } catch (err) {
    console.error("[account-audit] could not record", input.action, err instanceof Error ? err.message : err);
  }
}
