/**
 * Upload size budget for capture media, shared by the Next config and the client.
 *
 * ALIAS-FREE ON PURPOSE, like `security-headers.ts`: `next.config.ts` imports this by
 * relative path and is evaluated before the TS path aliases exist, so a `@/` import here
 * would break the build.
 *
 * TWO LIMITS HAVE TO AGREE. Capture media is base64'd into a server action payload, so the
 * request has to survive two independent caps:
 *
 *   1. `experimental.serverActions.bodySizeLimit` — how much a server action will accept.
 *   2. `experimental.proxyClientMaxBodySize` — how much Next buffers when a proxy exists.
 *
 * The second one is the trap. Because `src/proxy.ts` exists and its matcher covers server
 * action POSTs, Next clones and buffers the body of every non-GET request through it
 * (`getCloneableBody` → `cloneBodyStream`), whether or not the proxy ever reads it. When a
 * body exceeds that cap Next does NOT reject the request: it buffers the first N bytes,
 * logs a warning, and hands the *truncated* body to the action. Leaving it at its 10MB
 * default while the action advertised 32mb meant a 15MB upload arrived silently cut to
 * 10MB and failed later as unparseable garbage.
 */
export const CAPTURE_BODY_SIZE_LIMIT = "32mb";

/**
 * The raw bytes of user-selected files we let through, checked before we encode anything.
 *
 * Derived from — and necessarily smaller than — the 32MB body limit above, because the
 * payload is bigger than the files it carries: base64 costs 4 bytes per 3 (~1.34x), and
 * the action's arguments (notes text, filenames, mime types, form framing) ride along.
 * 22MB of files encodes to ~29.4MB, leaving headroom for the rest.
 *
 * This is the number worth showing a user: it is the size of the files they actually
 * picked, not the size of the encoded request they never see.
 */
export const CAPTURE_MAX_UPLOAD_BYTES = 22 * 1024 * 1024;

/** Format bytes for an error message — "24.6 MB". */
export function formatUploadSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
