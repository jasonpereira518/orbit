/**
 * The panel's primitives.
 *
 * Design rules these encode, so they don't get re-decided per component:
 *
 * - Five type sizes, no more: 10px uppercase micro-label, 11px meta, 13px body,
 *   15px name, 20px Fraunces anchor.
 * - Fraunces appears exactly twice in the whole panel — the wordmark and the
 *   person's name in capture. That restraint is what makes it read as Orbit
 *   rather than as decoration.
 * - A section is a hairline and a micro-label. No card chrome, no nested boxes.
 * - Three deliberate elevated surfaces, no more: a neutral reference card
 *   (starter suggestions), an actionable tinted band (the profile-diff card),
 *   and a decision card (Ambiguous's candidate rows — each is a clickable,
 *   mutually-exclusive choice, closer to a starter card than to a reference
 *   band). The first draft boxed everything and read as noise; any new
 *   card-like UI should fit one of these three, not invent a fourth.
 * - Everything on a 4px baseline.
 * - A spinner (`Loader2` + `animate-spin`) is allowed only on a `default`
 *   `md`/`lg` `Button` performing a record-mutating commit — creating or
 *   updating a contact. Every other in-flight action (a quick "Update Orbit",
 *   scheduling a follow-up, saving a note) goes `disabled` with no spinner.
 *   This is the line StarterList.tsx's "no thinking spinner" comment is
 *   gesturing at: a write in flight is a normal, expected signal; an idle AI
 *   process in a panel that stays open all session is not.
 *
 * Ported rather than imported: the app's components come from shadcn on Base UI
 * and live in the Next project's module graph. Intentional duplication beats
 * building a shared UI package for one consumer.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { companyBrandColor } from "@/lib/company-brand";

/* -------------------------------------------------------------------------- */
/* Type                                                                       */
/* -------------------------------------------------------------------------- */

/** 10px uppercase tracked muted — the app's `STEP 2 OF 9` / `EXTRAS` treatment. */
export function MicroLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--muted-foreground)]",
        className
      )}
    >
      {children}
    </h2>
  );
}

export function Meta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-[11px] leading-snug text-[var(--muted-foreground)]",
        className
      )}
    >
      {children}
    </p>
  );
}

/** One of the panel's two Fraunces moments. Use deliberately. */
export function Anchor({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn("text-[20px] leading-[1.15] text-[var(--foreground)]", className)}
      style={{ fontFamily: "var(--font-display), Georgia, serif", fontWeight: 500 }}
    >
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A titled band. Renders nothing when it has no content — the sparse contact is
 * the common case, and an empty section reads as a form with holes in it rather
 * than as a calm, thin record.
 */
export function Section({
  title,
  children,
  hairline = true,
  className,
}: {
  title?: string;
  children: ReactNode;
  hairline?: boolean;
  className?: string;
}) {
  const empty =
    children === null ||
    children === undefined ||
    children === false ||
    (Array.isArray(children) && children.filter(Boolean).length === 0);
  if (empty) return null;

  return (
    <section
      className={cn(
        "px-3 py-3",
        hairline && "border-t border-[var(--border)]",
        className
      )}
    >
      {title ? <MicroLabel className="mb-1.5">{title}</MicroLabel> : null}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost" | "subtle";
  size?: "sm" | "md" | "lg";
};

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium",
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-9 px-3.5 text-[13px]",
        size === "lg" && "h-11 w-full px-4 text-[14px]",
        variant === "default" &&
          "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90",
        variant === "outline" &&
          "border border-[var(--border)] bg-transparent hover:bg-[var(--accent)]",
        variant === "ghost" && "bg-transparent hover:bg-[var(--accent)]",
        variant === "subtle" &&
          "bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--accent)]",
        className
      )}
    />
  );
}

export function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-[var(--muted)] px-2 py-0.5 text-[11px] text-[var(--foreground)]",
        className
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[calc(var(--radius)*0.6)] bg-[var(--muted)]",
        className
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export function Avatar({
  src,
  name,
  size = 40,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
}) {
  return (
    <div
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] text-[var(--primary)]"
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span
          className="font-medium"
          style={{ fontSize: Math.max(11, size * 0.34) }}
        >
          {initials(name)}
        </span>
      )}
    </div>
  );
}

/**
 * A company name with its real brand colour as a leading rule.
 *
 * Cheap, and it earns its place: in a dense column of otherwise-grey rows the
 * eye finds "the Stripe one" instantly.
 */
export function CompanyMark({
  company,
  className,
}: {
  company: string | null | undefined;
  className?: string;
}) {
  if (!company?.trim()) return null;
  const color = companyBrandColor(company);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className="h-3 w-[3px] shrink-0 rounded-full"
        style={{ background: color ?? "var(--border)" }}
      />
      <span className="truncate">{company}</span>
    </span>
  );
}
