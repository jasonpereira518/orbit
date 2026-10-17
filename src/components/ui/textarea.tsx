"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldControl } from "@/components/ui/field"

/**
 * Grow the box to fit its text where `field-sizing: content` is missing (Firefox, older
 * Safari): there a `rows={1}` composer stayed one line tall and scrolled inside itself. The
 * CSS max-height still caps the growth. A no-op wherever the CSS property works.
 */
function useAutosizeFallback(
  el: React.RefObject<HTMLTextAreaElement | null>,
  value: unknown
) {
  const [unsupported] = React.useState(
    () => typeof CSS !== "undefined" && !CSS.supports("field-sizing", "content")
  )

  const fit = React.useCallback(() => {
    const node = el.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
  }, [el])

  React.useLayoutEffect(() => {
    if (unsupported) fit()
  }, [unsupported, fit, value])

  return unsupported ? fit : undefined
}

function Textarea({
  className,
  ref,
  onInput,
  ...rest
}: React.ComponentProps<"textarea">) {
  const props = useFieldControl(rest)
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fit = useAutosizeFallback(innerRef, props.value)
  const setRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  return (
    <textarea
      data-slot="textarea"
      // Arabic or Hebrew typed into a field reads right-to-left without a manual switch.
      dir="auto"
      ref={setRef}
      onInput={(e) => {
        fit?.()
        onInput?.(e)
      }}
      className={cn(
        // `field-sizing-content` grows the box to fit its value, with no upper bound of
        // its own: a 200KB paste into Capture measured 28,598px tall, putting the
        // "Extract people" button ~28,000px below the text, and a long paste into the
        // chat composer pushed the conversation and the send button off screen. Cap the
        // growth and scroll past it instead.
        "flex field-sizing-content max-h-[50dvh] min-h-16 w-full overflow-auto rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
