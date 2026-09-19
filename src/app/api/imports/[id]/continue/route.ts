import { NextResponse } from "next/server";
import { after } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { runImportJobById } from "@/lib/import-job-dispatch";
import { reportAndContinue } from "@/lib/report-error";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  // Internal self-continuation target — not user-facing. Fail-closed shared secret; see
  // internal-auth.ts.
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const { id } = await params;
  after(() => runImportJobById(id).catch(reportAndContinue({ where: "job.import.continue", extra: { importId: id } }, undefined)));

  return NextResponse.json({ ok: true });
}
