import { requireAdminUserId } from "@/lib/admin";

export const dynamic = "force-dynamic";

/**
 * Proves the error pipeline end to end: throws after the admin gate, so the exception
 * must show up in Sentry (or, without a DSN, as a throttled Slack message) within a minute.
 */
export async function GET() {
  await requireAdminUserId();
  throw new Error("Orbit ops test error — if you can read this in Sentry or Slack, the pipeline works.");
}
