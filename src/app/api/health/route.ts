import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";
import { isHealthTokenValid } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Liveness for the uptime monitor (shallow) and a diagnostic view for operators (deep,
 * with `?token=HEALTH_TOKEN` or a bearer). See `src/lib/health.ts` for what each says.
 */
export async function GET(request: Request) {
  const report = await checkHealth({ deep: isHealthTokenValid(request) });
  return NextResponse.json(report, {
    status: report.httpStatus,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
