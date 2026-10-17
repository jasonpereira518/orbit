"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

/**
 * A labelled form control: the label, an optional hint and an optional error, wired to the
 * control by id so a screen reader announces all three with it.
 *
 *   <Field label="Full name" required error={errors.fullName}>
 *     <Input value={…} onChange={…} required />
 *   </Field>
 *
 * `Input` and `Textarea` pick the wiring up on their own. Anything else (a native <select>, a
 * custom combobox) spreads `useFieldControl()` onto its focusable element:
 *   <select {...useFieldControl({ value, onChange })}>
 */
type FieldContextValue = {
  controlId: string
  describedBy: string | undefined
  invalid: boolean
}

const FieldContext = React.createContext<FieldContextValue | null>(null)

type ControlProps = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: React.AriaAttributes["aria-invalid"]
}

/** The id, description and invalid state of the enclosing `Field`, merged over `props`. */
function useFieldControl<P extends ControlProps>(props: P = {} as P): P {
  const field = React.useContext(FieldContext)
  if (!field) return props
  const describedBy =
    [field.describedBy, props["aria-describedby"]].filter(Boolean).join(" ") || undefined
  return {
    ...props,
    id: props.id ?? field.controlId,
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
  }
}

function Field({
  label,
  required,
  description,
  error,
  htmlFor,
  hideLabel,
  className,
  labelClassName,
  children,
}: {
  label: React.ReactNode
  /** Shows the asterisk and says "required"; set `required` on the control itself too. */
  required?: boolean
  description?: React.ReactNode
  /** An error for this field. Rendered inline, announced, and sets `aria-invalid`. */
  error?: React.ReactNode
  /** The control's own id, when it already has one. */
  htmlFor?: string
  /** Keep the label for assistive tech only, where the design shows none. */
  hideLabel?: boolean
  className?: string
  labelClassName?: string
  children: React.ReactNode
}) {
  const uid = React.useId()
  const controlId = htmlFor ?? `${uid}-control`
  const descriptionId = `${uid}-description`
  const errorId = `${uid}-error`
  const hasError = error != null && error !== false && error !== ""

  const value = React.useMemo<FieldContextValue>(
    () => ({
      controlId,
      describedBy:
        [description ? descriptionId : null, hasError ? errorId : null]
          .filter(Boolean)
          .join(" ") || undefined,
      invalid: hasError,
    }),
    [controlId, description, descriptionId, hasError, errorId]
  )

  return (
    <FieldContext.Provider value={value}>
      <div
        data-slot="field"
        data-invalid={hasError ? "" : undefined}
        className={cn("space-y-1.5", className)}
      >
        <Label
          htmlFor={controlId}
          className={cn(hideLabel && "sr-only", labelClassName)}
        >
          {label}
          {required ? (
            <>
              <span aria-hidden className="-ml-1.5 text-muted-foreground">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          ) : null}
        </Label>
        {children}
        {description ? (
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
        <FieldError id={errorId}>{hasError ? error : null}</FieldError>
      </div>
    </FieldContext.Provider>
  )
}

/**
 * Always mounted, so the live region exists before the message arrives: a region created
 * together with its text is not reliably announced.
 */
function FieldError({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <p
      id={id}
      data-slot="field-error"
      aria-live="polite"
      className={cn(
        "text-xs font-medium text-destructive empty:hidden",
        className
      )}
    >
      {children}
    </p>
  )
}

/**
 * Focus the first field a failed submit marked invalid, so the error is where the user is.
 * Call it once the invalid state has rendered, e.g. `requestAnimationFrame(() =>
 * focusFirstInvalid(formRef.current))` after setting the errors.
 */
function focusFirstInvalid(root: HTMLElement | null | undefined) {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]')
  el?.focus()
  return el ?? null
}

export { Field, FieldError, focusFirstInvalid, useFieldControl }
