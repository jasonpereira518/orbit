import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Pills and chips.
 *
 * `variant` is the shape language (filled / outline / ghost …). `tone` is the status
 * colour, built on the semantic tokens, and wins over the variant's colours so a
 * `<Badge tone="warning">` reads the same on every page. `size="sm"` is the fine-print chip
 * (16px tall, 10px text) that ~77 hand-rolled `rounded-full px-* text-[10px]` spans were
 * approximating; `dot` prefixes a status dot in the tone colour.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      tone: {
        none: "",
        neutral: "bg-muted text-muted-foreground",
        success: "bg-success/10 text-success",
        warning: "bg-warning/12 text-warning",
        info: "bg-info/10 text-info",
        destructive: "bg-destructive/10 text-destructive",
        accent: "bg-accent text-accent-foreground",
      },
      size: {
        default: "h-5 px-2 py-0.5 text-xs [&>svg]:size-3!",
        sm: "h-4 px-1.5 text-3xs uppercase tracking-wide [&>svg]:size-2.5!",
      },
    },
    defaultVariants: {
      variant: "default",
      tone: "none",
      size: "default",
    },
  }
)

const DOT: Record<NonNullable<VariantProps<typeof badgeVariants>["tone"]>, string> = {
  none: "bg-current",
  neutral: "bg-muted-foreground/60",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  destructive: "bg-destructive",
  accent: "bg-primary",
}

function Badge({
  className,
  variant = "default",
  tone = "none",
  size = "default",
  dot = false,
  render,
  children,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Leading status dot in the tone colour. */
    dot?: boolean
  }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, tone, size }), className),
        children: dot ? (
          <>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", DOT[tone ?? "none"])}
            />
            {children}
          </>
        ) : (
          children
        ),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
