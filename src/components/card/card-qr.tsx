import { cn } from "@/lib/utils";

/**
 * The card's QR code, rendered server-side by `getMyCardQr` (its fill is `currentColor`).
 * Always dark-on-white: someone else's camera reads it, and some scanners miss an inverted code.
 */
export function CardQr({ svg, className }: { svg: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label="QR code for your card link"
      className={cn("rounded-2xl bg-white p-3 text-black [&>svg]:block [&>svg]:h-auto [&>svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
