"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A horizontally scrolling box (a wide table on a phone) that a keyboard can scroll: it
 * joins the tab order, named, only while its content actually overflows. Without that, a
 * table wider than the screen hid its last columns from anyone not using a pointer.
 */
export function ScrollRegion({
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "role" | "tabIndex"> & { label: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={overflowing ? 0 : undefined}
      className={cn(
        "overflow-x-auto outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
