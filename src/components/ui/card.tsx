import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A card surface.
 *
 * This is the house card: `rounded-xl`, the `border-subtle` hairline, `bg-card`. It used to
 * be a ring-based variant that nobody used (23 importers against ~280 hand-rolled
 * `rounded-2xl border border-border/70 bg-card` divs). The hand-rolled look won; the
 * primitive now matches it, so migrating a div is a rename.
 *
 * Deliberately no hover treatment of its own: a card is not interactive by default, and the
 * ones that are reach for `CARD_HOVER` from `src/lib/interaction.ts` so every clickable card
 * in the app lifts the same way.
 *
 * `size` sets the padding (`sm` 16px, default 20px, `lg` 24px) through `--card-spacing`,
 * which the header, content and footer all read. `variant="inset"` is the recessed panel
 * that sits inside another card.
 */
function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm" | "lg"
  variant?: "default" | "inset"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border border-border-subtle bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(5)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] data-[size=lg]:[--card-spacing:--spacing(6)] data-[variant=inset]:bg-surface-inset *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

/**
 * Heading levels a card title may render as. `div` is the default so an
 * untouched call site keeps its current, non-semantic output.
 */
type CardTitleAs = "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"

function CardTitle({
  className,
  as: Comp = "div",
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * The element to render. A card title is almost always a section heading, so
   * pass the level that fits the page's outline (no skipped levels, one `h1`
   * per page) and screen-reader heading navigation will reach this card.
   */
  as?: CardTitleAs
}) {
  return (
    <Comp
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium text-ink group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t border-border-subtle bg-surface-inset p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
