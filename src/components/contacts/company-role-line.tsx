import { companyBrandText } from "@/lib/company-brand";
import { cn } from "@/lib/utils";

/**
 * Role line with company name tinted to the company brand color.
 *
 * The tint goes through `companyBrandText`, which keeps it at 4.5:1 or better in both themes
 * (a monochrome brand renders as plain muted text). Title and company are each isolated in
 * `<bdi>`, so an Arabic title beside a Latin company keeps its own direction instead of
 * reordering the whole line, "at" and all.
 */
export function CompanyRoleLine({
  title,
  company,
  className,
  empty = "No role yet",
}: {
  title: string | null;
  company: string | null;
  className?: string;
  empty?: string | null;
}) {
  const brand = companyBrandText(company);

  if (!title && !company) {
    return empty ? (
      <span className={cn("text-muted-foreground", className)}>{empty}</span>
    ) : null;
  }

  if (title && company) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        <bdi>{title}</bdi> at{" "}
        <bdi className={cn("font-medium", brand?.className)} style={brand?.style}>
          {company}
        </bdi>
      </span>
    );
  }

  if (company) {
    return (
      <bdi
        className={cn("font-medium", brand ? brand.className : "text-muted-foreground", className)}
        style={brand?.style}
      >
        {company}
      </bdi>
    );
  }

  return (
    <bdi className={cn("text-muted-foreground", className)}>{title}</bdi>
  );
}
