/**
 * The caller's IP from proxy headers: the first `x-forwarded-for` hop (the client; the rest
 * are proxies), then `x-real-ip`, else "unknown". Import-free so any server action or core
 * can use it with Next's `headers()` or a plain test object.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
