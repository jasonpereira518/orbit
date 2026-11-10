/**
 * Slack connector: syncs DM conversations with known Orbit contacts as interactions,
 * and workspace members as contacts.
 *
 * Scopes: im:history, im:read, users:read, users:read.email
 */
import {
  loadConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
} from "@/lib/connectors/connections";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { openIngestContext, finalizeIngest } from "@/lib/ingest/events";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const SLACK_API = "https://slack.com/api";
const PASS_BUDGET_MS = 90_000;

export class SlackReauthError extends Error {
  constructor(msg = "Reconnect Slack") {
    super(msg);
    this.name = "SlackReauthError";
  }
}

async function slackCall<T>(token: string, endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${SLACK_API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (json.error === "invalid_auth" || json.error === "token_revoked" || json.error === "account_inactive") {
    throw new SlackReauthError(json.error);
  }
  if (!res.ok || json.ok === false) {
    throw new Error(`Slack API ${endpoint} failed: ${json.error ?? res.status}`);
  }
  return json;
}

export async function syncSlack(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn?.accessToken) return;
  const started = Date.now();
  const token = conn.accessToken;

  try {
    // 1. Sync workspace members as people
    if (conn.capabilities.includes("syncPeople")) {
      const usersRes = await slackCall<{
        members?: Array<{
          id: string;
          deleted?: boolean;
          is_bot?: boolean;
          is_app_user?: boolean;
          profile?: {
            real_name?: string;
            display_name?: string;
            email?: string;
            title?: string;
            phone?: string;
          };
        }>;
      }>(token, "users.list", { limit: "200" });

      const members: PersonRecord[] = [];
      for (const m of usersRes.members ?? []) {
        if (m.deleted || m.is_bot || m.is_app_user || !m.profile?.email) continue;
        const fullName = m.profile.real_name || m.profile.display_name;
        if (fullName) {
          members.push({
            fullName,
            email: m.profile.email,
            title: m.profile.title || null,
            phone: m.profile.phone || null,
          });
        }
      }

      if (members.length > 0) {
        const ctx = await openIngestContext(conn.userId, {
          source: "slack",
          createsContacts: true,
        });
        await ingestPeople(ctx, members);
        await finalizeIngest(ctx, { recalibrate: !conn.cursor?.syncedThrough });
      }
    }

    // 2. Sync DMs with known contacts as interactions
    if (conn.capabilities.includes("syncEvents") && Date.now() - started < PASS_BUDGET_MS) {
      const convRes = await slackCall<{
        channels?: Array<{ id: string; user?: string }>;
      }>(token, "conversations.list", { types: "im", limit: "100" });

      const db = await getDb();
      for (const ch of convRes.channels ?? []) {
        if (Date.now() - started > PASS_BUDGET_MS) break;
        if (!ch.user) continue;

        const uInfo = await slackCall<{
          user?: { profile?: { email?: string; real_name?: string } };
        }>(token, "users.info", { user: ch.user }).catch(() => null);

        const email = uInfo?.user?.profile?.email;
        if (!email) continue;

        const [contact] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.userId, conn.userId), eq(contacts.email, email.toLowerCase())))
          .limit(1);

        if (!contact) continue;

        const history = await slackCall<{
          messages?: Array<{ ts: string; text?: string; user?: string }>;
        }>(token, "conversations.history", {
          channel: ch.id,
          limit: "10",
        }).catch(() => null);

        const latest = history?.messages?.[0];
        if (!latest?.ts) continue;

        const externalId = `slack:dm:${ch.id}:${latest.ts}`;
        const [existing] = await db
          .select({ id: interactions.id })
          .from(interactions)
          .where(and(eq(interactions.userId, conn.userId), eq(interactions.externalId, externalId)))
          .limit(1);

        if (!existing) {
          const interactionDate = new Date(Number(latest.ts.split(".")[0]) * 1000);
          await db.insert(interactions).values({
            userId: conn.userId,
            contactId: contact.id,
            source: "slack",
            externalId,
            interactionDate,
            interactionType: "message",
            rawNotes: latest.text?.slice(0, 500) ?? "Slack direct message",
          });
        }
      }
    }

    await markConnectorSyncResult(conn.id, {
      ok: true,
      cursor: {
        ...conn.cursor,
        syncedThrough: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof SlackReauthError) {
      await markConnectorNeedsReauth(conn.id, err.message);
      return;
    }
    throw err;
  }
}
