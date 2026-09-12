/** Minimal class joiner. The app uses clsx + tailwind-merge; a 400px panel with
 *  no variant system doesn't need either. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
