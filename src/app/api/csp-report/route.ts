import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { shouldRecordThrottled } from "@/lib/throttle-latch";

export const dynamic = "force-dynamic";

/**
 * Receives Content-Security-Policy violation reports.
 *
 * The policy starts report-only (see `src/lib/security-headers.ts`), so for its first week
 * this is the only evidence of what an enforced policy would break. Hobby runtime logs keep
 * an hour; a week has to live in `error_events`, bounded by a once-per-hour latch per
 * (directive, blocked URI) so a noisy browser extension cannot write a row per page view.
 *
 * Anonymous by design: no session, nothing from the report but a directive and a URI is
 * kept, bodies over 8 KB are refused, and garbage is dropped with the same 204 a real
 * report gets — an attacker learns nothing from the status line.
 */
const MAX_BODY_BYTES = 8 * 1024;

type LegacyReport = {
  "csp-report"?: {
    "effective-directive"?: string;
    "violated-directive"?: string;
    "blocked-uri"?: string;
    "document-uri"?: string;
  };
};
type ReportingApiEntry = {
  body?: { effectiveDirective?: string; blockedURL?: string; documentURL?: string };
};

function normalize(payload: unknown): { directive: string; blockedUri: string; documentPath: string } | null {
  const legacy = (payload as LegacyReport)?.["csp-report"];
  const entry = Array.isArray(payload) ? (payload[0] as ReportingApiEntry)?.body : undefined;
  const directive = legacy?.["effective-directive"] ?? legacy?.["violated-directive"] ?? entry?.effectiveDirective;
  const blockedUri = legacy?.["blocked-uri"] ?? entry?.blockedURL;
  const documentUri = legacy?.["document-uri"] ?? entry?.documentURL;
  if (typeof directive !== "string" || !directive.trim()) return null;
  let documentPath = "";
  try {
    documentPath = documentUri ? new URL(documentUri).pathname : "";
  } catch {
    documentPath = "";
  }
  return {
    directive: directive.trim().slice(0, 64),
    blockedUri: (typeof blockedUri === "string" ? blockedUri : "").slice(0, 300),
    documentPath: documentPath.slice(0, 200),
  };
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204 });
  }
  const report = normalize(payload);
  if (!report) return new Response(null, { status: 204 });

  if (shouldRecordThrottled(`csp:${report.directive}:${report.blockedUri}`)) {
    await recordErrorEvent({
      source: ERROR_SOURCES.cspReport,
      kind: report.directive,
      context: { blockedUri: report.blockedUri, documentPath: report.documentPath },
    });
  }
  return new Response(null, { status: 204 });
}
