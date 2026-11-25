import { BrandLogo } from "@/components/ui/brand-logo";
import { companyBrandText } from "@/lib/company-brand";
import { companyMarkSpec } from "@/lib/company-mark";
import { cn } from "@/lib/utils";

/**
 * A company, branded: its logo in a tile tinted with its color, beside its name in that color.
 *
 * - The logo shows when Orbit knows the company's website (`companyMarkSpec`); otherwise the
 *   tile holds its initial, in the same color, so every company still reads as itself.
 * - The name's tint goes through `companyBrandText`, which holds it at 4.5:1 or better on every
 *   card in both themes. A monochrome brand (Vercel, Notion) renders in the surrounding color.
 * - The tile is decoration: the name beside it is what a screen reader hears.
 *
 * No hooks and no server-only imports, so a client component may render it too.
 */
const TILE = { sm: "size-5 rounded", md: "size-6 rounded-md" } as const;
const LOGO = { sm: "size-3.5", md: "size-4" } as const;

export function CompanyMark({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof TILE;
  className?: string;
}) {
  const spec = companyMarkSpec(name);
  const text = companyBrandText(name);
  const initial = (
    <span
      className={cn("text-xs font-semibold leading-none", text ? text.className : "text-muted-foreground")}
      style={text?.style}
    >
      {spec.initial}
    </span>
  );
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden", TILE[size], !spec.color && "bg-muted", className)}
      style={spec.color ? { backgroundColor: `color-mix(in srgb, ${spec.color} 14%, transparent)` } : undefined}
    >
      {spec.domain ? <BrandLogo key={spec.domain} domain={spec.domain} name="" className={LOGO[size]} fallback={initial} /> : initial}
    </span>
  );
}

export function CompanyChip({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof TILE;
  className?: string;
}) {
  const text = companyBrandText(name);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <CompanyMark name={name} size={size} />
      <bdi className={cn("truncate", text?.className)} style={text?.style}>
        {name}
      </bdi>
    </span>
  );
}
