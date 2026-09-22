import { describeOAuthReason } from "@/lib/errors";

/**
 * What an OAuth callback's redirect params mean to the person who just came back.
 *
 * Client-safe (errors.ts has no imports). The caller shows `text` with the given tone and
 * later replaces the URL with `nextSearch` — later, on a gesture, never in a mount effect:
 * in Next 16 `history.replaceState` is a router restore that drops any server action a
 * sibling component queued on mount.
 */
export type OAuthReturn = {
  tone: "success" | "message" | "error";
  text: string;
  /** The query string with this flow's params removed: "" or "?…". */
  nextSearch: string;
};

export function readOAuthReturn(
  search: string,
  opts: {
    /** The param the callback sets to "connected" or "error". */
    param: string;
    provider: string;
    connectedText: string;
    /** Copy for reason codes the callback sets on purpose, beyond `access_denied`. */
    reasons?: Record<string, string>;
  }
): OAuthReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get(opts.param);
  if (outcome !== "connected" && outcome !== "error") return null;
  const reason = params.get("reason");
  params.delete(opts.param);
  params.delete("reason");
  const rest = params.toString();
  const nextSearch = rest ? `?${rest}` : "";

  if (outcome === "connected") return { tone: "success", text: opts.connectedText, nextSearch };
  const known = reason && Object.hasOwn(opts.reasons ?? {}, reason) ? opts.reasons![reason] : null;
  if (known) return { tone: "error", text: known, nextSearch };
  const described = describeOAuthReason(reason, opts.provider);
  return { tone: described.cancelled ? "message" : "error", text: described.message, nextSearch };
}

/**
 * `value` when it is a path on this origin, otherwise null. Every OAuth `returnTo` passes
 * through here before it can become a redirect after the consent screen.
 *
 * `startsWith("/")` alone is an open redirect: "//host" is protocol-relative, URL parsers
 * read "/\host" as "//host", and they drop tabs and newlines, so a control character
 * between the slashes gets there too.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || value[0] !== "/" || value[1] === "/" || value[1] === "\\") return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return value;
}
