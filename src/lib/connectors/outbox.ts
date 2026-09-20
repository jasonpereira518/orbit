/**
 * At-least-once write-back to other people's systems.
 *
 * The retry rules are `outbound_webhook_deliveries`': seven attempts on a jittered ladder,
 * then dead. They are restated rather than imported because `webhooks/dispatch.ts` keeps its
 * ladder module-private, and widening that module to share it would be a worse trade than
 * twenty lines of duplication.
 *
 * `deliver` is injected rather than dispatched from the registry here, so this module stays
 * testable without a provider and the connector owns its own HTTP.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { connectorOutbox, externalLinks } from "@/db/schema";

/** Attempts before an item is abandoned. Mirrors MAX_DELIVERY_ATTEMPTS in dispatch.ts. */
export const MAX_OUTBOX_ATTEMPTS = 7;

/** Nominal backoff ladder in minutes. The drain runs every ten, so the first steps collapse. */
const BACKOFF_MINUTES = [0.5, 2, 10, 60, 360, 1440];

function backoffFor(attempt: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)]!;
  // ±20% jitter, so a provider-wide outage does not bring every item back on the same
  // ten-minute boundary once it clears.
  return minutes * (0.8 + Math.random() * 0.4) * 60_000;
}

export type OutboxAction = "writeTask" | "logActivity" | "writeContact";

export type EnqueueOutboxInput = {
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: "reminder" | "interaction" | "contact";
  entityId: string;
  payload: Record<string, unknown>;
};

/**
 * Queue one write. Returns null when this exact action is already queued or delivered —
 * the unique index is the idempotency story, so a retried server action is free.
 */
export async function enqueueOutbox(input: EnqueueOutboxInput): Promise<{ id: string } | null> {
  const db = await getDb();
  const [row] = await db
    .insert(connectorOutbox)
    .values({
      userId: input.userId,
      connectorId: input.connectorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row ? { id: row.id } : null;
}

export type OutboxItem = {
  id: string;
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  attempts: number;
  /** The provider's id from a previous delivery, when there was one. */
  remoteId: string | null;
};

export type DeliverResult = { ok: true; remoteId?: string | null } | { ok: false; error: string };

export type OutboxDrainStats = { attempted: number; delivered: number; failed: number };

export async function drainOutbox(opts: {
  budgetMs: number;
  max: number;
  now?: Date;
  deliver: (item: OutboxItem) => Promise<DeliverResult>;
}): Promise<OutboxDrainStats> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + opts.budgetMs;
  const stats: OutboxDrainStats = { attempted: 0, delivered: 0, failed: 0 };
  const db = await getDb();

  const due = await db
    .select()
    .from(connectorOutbox)
    .where(
      and(
        eq(connectorOutbox.status, "pending"),
        sql`${connectorOutbox.nextAttemptAt} IS NOT NULL`,
        sql`${connectorOutbox.nextAttemptAt} <= ${now}`
      )
    )
    .orderBy(connectorOutbox.nextAttemptAt)
    .limit(opts.max);

  for (const row of due) {
    if (Date.now() >= deadline) break;
    stats.attempted++;
    const link = await findExternalLink(row.userId, row.connectorId, row.entityType, row.entityId);
    // One connector's failure must never stop the queue.
    const result = await opts
      .deliver({
        id: row.id,
        userId: row.userId,
        connectorId: row.connectorId,
        action: row.action as OutboxAction,
        entityType: row.entityType,
        entityId: row.entityId,
        payload: row.payload as Record<string, unknown>,
        attempts: row.attempts,
        remoteId: link?.remoteId ?? null,
      })
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));

    if (result.ok) {
      stats.delivered++;
      if (result.remoteId) {
        await recordExternalLink({
          userId: row.userId,
          connectorId: row.connectorId,
          entityType: row.entityType,
          entityId: row.entityId,
          remoteId: result.remoteId,
        });
      }
      await db
        .update(connectorOutbox)
        .set({
          status: "delivered",
          attempts: row.attempts + 1,
          lastAttemptedAt: now,
          deliveredAt: now,
          nextAttemptAt: null,
          lastError: null,
        })
        .where(eq(connectorOutbox.id, row.id));
      continue;
    }

    stats.failed++;
    const attempt = row.attempts + 1;
    const exhausted = attempt >= MAX_OUTBOX_ATTEMPTS;
    await db
      .update(connectorOutbox)
      .set({
        status: exhausted ? "dead" : "pending",
        attempts: attempt,
        lastError: result.error.slice(0, 200),
        lastAttemptedAt: now,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + backoffFor(attempt)),
      })
      .where(eq(connectorOutbox.id, row.id));
  }

  return stats;
}

export async function recordExternalLink(input: {
  userId: string;
  connectorId: string;
  entityType: string;
  entityId: string;
  remoteId: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(externalLinks)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        externalLinks.userId,
        externalLinks.connectorId,
        externalLinks.entityType,
        externalLinks.entityId,
      ],
      set: { remoteId: input.remoteId, updatedAt: new Date() },
    });
}

export async function findExternalLink(
  userId: string,
  connectorId: string,
  entityType: string,
  entityId: string
): Promise<{ remoteId: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ remoteId: externalLinks.remoteId })
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.connectorId, connectorId),
        eq(externalLinks.entityType, entityType),
        eq(externalLinks.entityId, entityId)
      )
    );
  return row ?? null;
}
