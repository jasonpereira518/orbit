"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * An on/off control. Replaces nine hand-rolled `role="switch"` buttons (two of them
 * byte-identical) and the "Turn on / Turn off" button pairs other settings used for the
 * same job. Label it with `<Label htmlFor>` or `aria-label`.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input/60 transition-colors duration-fast outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary dark:bg-input/40",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-background shadow-xs transition-transform duration-fast ease-house data-checked:translate-x-[1.125rem]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
