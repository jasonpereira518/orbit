import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A card surface. Deliberately has no hover treatment of its own: a card is not
 * interactive by default, and the ones that are reach for `CARD_HOVER` from
 * `src/lib/interaction.ts` so every clickable card in the app lifts the same way.
 *
 * (There was once an `interactive` prop here carrying a third, different hover
 * language — ring + shadow + a dark-mode inset highlight. It had zero call sites
 * app-wide and its transition list named only `box-shadow` while the rule also
 * changed the ring, so the ring snapped while the shadow eased. Removed rather
 * than fixed; `CARD_HOVER` is the one card treatment.)
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
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
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
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
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
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
