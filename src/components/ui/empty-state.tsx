import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * What a page shows when there is nothing in it yet: a heading that says so, one line on
 * why it matters, and the action that fills it. One look for every empty list in the app.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
  className,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  /** The heading level that fits the page outline around it. */
  headingLevel?: 2 | 3 | 4
  className?: string
}) {
  const Heading = `h${headingLevel}` as const
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-2 px-6 py-10 text-center",
        className
      )}
    >
      {Icon ? (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
      ) : null}
      <Heading className="font-heading text-base font-medium text-ink">{title}</Heading>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}
