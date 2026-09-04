/**
 * Pins the two request-body limits that capture media uploads depend on.
 *
 * THIS GUARDS A SILENT FAILURE. Because `src/proxy.ts` exists and its matcher covers
 * server-action POSTs, Next buffers the body of every non-GET request through it. When a
 * body exceeds `experimental.proxyClientMaxBodySize` it is NOT rejected: Next keeps the
 * first N bytes, logs a warning server-side, and hands the action a truncated payload —
 * HTTP 200, no error, garbage downstream. With that cap left at its 10MB default while
 * `serverActions.bodySizeLimit` advertised 32mb, a 15MB voice memo arrived cut to exactly
 * 10MB. Nothing in the UI could tell.
 *
 * So the invariant is: the two limits agree, and the file budget we show users is small
 * enough that its base64 payload still fits inside them. A regex over next.config.ts would
 * not do — it would pass on commented-out code — so this imports the resolved config.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-capture-body-limits.ts
 */
import nextConfig from "../next.config";
import {
  CAPTURE_BODY_SIZE_LIMIT,
  CAPTURE_MAX_UPLOAD_BYTES,
  formatUploadSize,
} from "../src/lib/capture-limits";

const MB = 1024 * 1024;
/** Next's default when `proxyClientMaxBodySize` is unset — the value that caused the bug. */
const NEXT_DEFAULT_PROXY_LIMIT = 10 * MB;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** "32mb" / "512kb" / 1048576 -> bytes. Mirrors Next's own SizeLimit parsing. */
function toBytes(limit: unknown): number | null {
  if (typeof limit === "number") return limit;
  if (typeof limit !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(limit.trim());
  if (!m) return null;
  const scale = { b: 1, kb: 1024, mb: MB, gb: 1024 * MB }[m[2]!.toLowerCase()]!;
  return Number(m[1]) * scale;
}

function main() {
  const experimental = (nextConfig as { experimental?: Record<string, unknown> })
    .experimental;
  const serverActions = experimental?.serverActions as
    | { bodySizeLimit?: unknown }
    | undefined;
  const actionLimit = toBytes(serverActions?.bodySizeLimit);
  const proxyLimit = toBytes(experimental?.proxyClientMaxBodySize);

  console.log("next.config.ts...");
  check("serverActions.bodySizeLimit is set and parseable", actionLimit !== null,
    String(serverActions?.bodySizeLimit));
  check("experimental.proxyClientMaxBodySize is set and parseable", proxyLimit !== null,
    String(experimental?.proxyClientMaxBodySize));

  // The whole point. These are independent caps and only the smaller one is real.
  check("the two limits agree", actionLimit !== null && actionLimit === proxyLimit,
    `serverActions=${actionLimit} proxy=${proxyLimit}`);
  check("the proxy cap is above Next's silently-truncating 10MB default",
    (proxyLimit ?? 0) > NEXT_DEFAULT_PROXY_LIMIT,
    `proxy=${proxyLimit} default=${NEXT_DEFAULT_PROXY_LIMIT}`);
  check("both come from CAPTURE_BODY_SIZE_LIMIT", actionLimit === toBytes(CAPTURE_BODY_SIZE_LIMIT)
    && proxyLimit === toBytes(CAPTURE_BODY_SIZE_LIMIT), CAPTURE_BODY_SIZE_LIMIT);

  console.log("\nThe user-facing file budget fits inside those limits...");
  // base64 costs 4 bytes per 3, and the action's other arguments ride along with it.
  const encoded = Math.ceil(CAPTURE_MAX_UPLOAD_BYTES / 3) * 4;
  check("a max-size upload still encodes under the body limit",
    actionLimit !== null && encoded < actionLimit,
    `${formatUploadSize(encoded)} encoded vs ${formatUploadSize(actionLimit ?? 0)} limit`);
  check("at least 1MB is left over for notes text and form framing",
    actionLimit !== null && actionLimit - encoded > MB,
    `${formatUploadSize((actionLimit ?? 0) - encoded)} headroom`);

  console.log("\nThe size guard's own arithmetic...");
  // The case from the original report: 15MB used to arrive truncated to 10MB.
  check("a 15MB upload is accepted rather than truncated", 15 * MB <= CAPTURE_MAX_UPLOAD_BYTES);
  check("the client predicate rejects an oversized selection",
    23 * MB > CAPTURE_MAX_UPLOAD_BYTES);
  // The server measures the same bytes after decoding what the client base64'd.
  const b64len = Math.ceil((23 * MB) / 3) * 4;
  const decoded = Math.floor((b64len * 3) / 4);
  check("the server predicate agrees with the client on the same payload",
    decoded > CAPTURE_MAX_UPLOAD_BYTES && Math.abs(decoded - 23 * MB) < 8,
    `decoded=${decoded}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll capture body-limit checks passed.");
  process.exit(0);
}

main();
