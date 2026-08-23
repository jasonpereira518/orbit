import { NextResponse } from "next/server";
import { after } from "next/server";
import { runImportJobById } from "@/lib/import-job-dispatch";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** Internal self-continuation target — not user-facing. Authorized via a shared secret. */
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request, { params }: Params) {
  if (!isAuthorized(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const { id } = await params;
  after(() => runImportJobById(id).catch(() => {}));

  return NextResponse.json({ ok: true });
}
