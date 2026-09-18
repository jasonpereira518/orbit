import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";
import { healthTokenState } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/**
 * Liveness for the uptime monitor (shallow) and a diagnostic view for operators (deep,
 * with `?token=HEALTH_TOKEN` or a bearer). A wrong `?token=` is a 401. See
 * `src/lib/health.ts` for what each view says.
 */
export async function GET(request: Request) {
  const token = healthTokenState(request);
  if (token === "invalid") {
    return NextResponse.json({ error: "invalid token" }, { status: 401, headers: HEADERS });
  }
  const report = await checkHealth({ deep: token === "valid" });
  return NextResponse.json(report, { status: report.httpStatus, headers: HEADERS });
}
