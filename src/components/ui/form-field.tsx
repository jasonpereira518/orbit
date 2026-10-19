import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Label + control + hint/error, laid out the one way.
 *
 * Pass `id` to the control you render as children, or read it from the render-prop form:
 * `<FormField label="Name">{(id) => <Input id={id} />}</FormField>`. The hint and the error
 * get ids the control can name in `aria-describedby`; the error is announced.
 */
export function FormField({
  label,
  id,
  hint,
  error,
  required = false,
  optional = false,
  children,
  className,
}: {
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Shows "(optional)" after the label; use one of `required` / `optional` per form. */
  optional?: boolean;
  children: ReactNode | ((id: string) => ReactNode);
  className?: string;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div data-slot="form-field" className={cn("space-y-2", className)}>
      <Label htmlFor={fieldId}>
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            *
          </span>
        )}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {typeof children === "function" ? children(fieldId) : children}
      {error ? (
        <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
