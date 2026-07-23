import { companyBrandColor } from "@/lib/company-brand";
import { cn } from "@/lib/utils";

/** Role line with company name tinted to the company brand color. */
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
  const color = companyBrandColor(company);

  if (!title && !company) {
    return empty ? (
      <span className={cn("text-muted-foreground", className)}>{empty}</span>
    ) : null;
  }

  if (title && company) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        {title} at{" "}
        <span
          className="font-medium"
          style={color ? { color } : undefined}
        >
          {company}
        </span>
      </span>
    );
  }

  if (company) {
    return (
      <span
        className={cn("font-medium", className)}
        style={color ? { color } : undefined}
      >
        {company}
      </span>
    );
  }

  return (
    <span className={cn("text-muted-foreground", className)}>{title}</span>
  );
}
