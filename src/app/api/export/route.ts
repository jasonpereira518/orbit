import { rateLimitGuard } from "@/lib/api/route-error";
import { requireUserId } from "@/lib/auth";
import { userExportStream } from "@/lib/data-export";
import { recordAccountAudit } from "@/lib/account-audit";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";

/** A large network pages through every table; the stream keeps memory flat, not time short. */
export const maxDuration = 300;

/**
 * The signed-in user's own data, as one JSON file, streamed. Owner-only by construction:
 * the only input is the session. No secrets, tokens or photo bytes; see `data-export.ts`.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new Response(null, { status: 401 });
  }
  const limited = await rateLimitGuard(() => consumeBucket("export", userId, RATE_LIMITS.export));
  if (limited) return limited;
  await recordAccountAudit({ userId, action: "data.export", detail: { format: "json" } });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(userExportStream(userId), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="orbit-export-${date}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
