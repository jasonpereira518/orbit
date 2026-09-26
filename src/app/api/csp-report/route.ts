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
  const cleanDirective = directive.trim().toLowerCase();
  if (!/^[a-z-]{1,40}$/.test(cleanDirective)) return null;
  return {
    directive: cleanDirective,
    blockedUri: blockedSource(typeof blockedUri === "string" ? blockedUri : ""),
    documentPath: documentPath.slice(0, 200),
  };
}

/**
 * The blocked resource reduced to what a policy decision needs: an origin, or a keyword
 * (`inline`, `eval`, `data`, `blob`). The full URL was part of the throttle key, so every
 * distinct path an anonymous script invented was a fresh key and a fresh row.
 */
function blockedSource(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (/^(https?|wss?):$/.test(url.protocol)) return url.origin.slice(0, 200);
    return url.protocol.replace(/:$/, "").slice(0, 32);
  } catch {
    return (/^[a-z-]{1,32}/i.exec(value)?.[0] ?? "").toLowerCase();
  }
}

/**
 * A ceiling on rows per instance per hour, whatever the keys. Normalising the URI bounds a
 * real browser's reports; it cannot bound a script inventing origins, and `error_events` is
 * shared with every real failure signal the ops sweep reads.
 */
const MAX_ROWS_PER_HOUR = 100;
let budget = { windowStart: 0, used: 0 };

function takeRowBudget(now = Date.now()): boolean {
  if (now - budget.windowStart >= 60 * 60 * 1000) budget = { windowStart: now, used: 0 };
  if (budget.used >= MAX_ROWS_PER_HOUR) return false;
  budget.used++;
  return true;
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

  if (shouldRecordThrottled(`csp:${report.directive}:${report.blockedUri}`) && takeRowBudget()) {
    await recordErrorEvent({
      source: ERROR_SOURCES.cspReport,
      kind: report.directive,
      context: { blockedUri: report.blockedUri, documentPath: report.documentPath },
    });
  }
  return new Response(null, { status: 204 });
}
