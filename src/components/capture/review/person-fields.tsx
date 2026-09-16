"use client";

/**
 * The editable heart of a person: the one form the card and the edit dialog both render,
 * so a field added here shows up in both.
 */
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type PersonFieldValues = {
  name: string;
  company: string;
  role: string;
  metAt: string;
  /** Comma-separated, as typed. Split at save time by `parseTagNames`. */
  tags: string;
  summary: string;
};

export function PersonFields({
  value,
  onChange,
  lowConfidence,
  idPrefix,
  topics = [],
  sharedNoteTexts = [],
  sourceText,
  compact = false,
}: {
  value: PersonFieldValues;
  onChange: (patch: Partial<PersonFieldValues>) => void;
  lowConfidence: ReadonlySet<string>;
  idPrefix: string;
  topics?: string[];
  sharedNoteTexts?: string[];
  /** What the model read for this person — kept one click away. */
  sourceText?: string | null;
  compact?: boolean;
}) {
  const guessed = ["name", "company", "role", "met_at"].some((f) => lowConfidence.has(f));
  return (
    <div className={cn("space-y-3", !compact && "space-y-4")}>
      {guessed && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Fields marked * were guessed — worth a glance.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${idPrefix}-name`} label="Name" low={lowConfidence.has("name")}>
          <Input id={`${idPrefix}-name`} value={value.name} onChange={(e) => onChange({ name: e.target.value })} autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-company`} label="Company" low={lowConfidence.has("company")}>
          <Input id={`${idPrefix}-company`} value={value.company} onChange={(e) => onChange({ company: e.target.value })} autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-role`} label="Role" low={lowConfidence.has("role")}>
          <Input id={`${idPrefix}-role`} value={value.role} onChange={(e) => onChange({ role: e.target.value })} autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-met`} label="Met at" low={lowConfidence.has("met_at")}>
          <Input id={`${idPrefix}-met`} value={value.metAt} onChange={(e) => onChange({ metAt: e.target.value })} autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-tags`} label="Tags" hint="comma-separated" className="sm:col-span-2">
          <Input id={`${idPrefix}-tags`} value={value.tags} onChange={(e) => onChange({ tags: e.target.value })} placeholder="founder, ai, met at demo day" autoComplete="off" />
        </Field>
      </div>
      <Field id={`${idPrefix}-summary`} label="What you took away" low={lowConfidence.has("summary")}>
        <Textarea
          id={`${idPrefix}-summary`}
          value={value.summary}
          onChange={(e) => onChange({ summary: e.target.value })}
          className={cn("min-h-[88px]", compact && "min-h-[72px]")}
        />
      </Field>
      {topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Topics">
          {topics.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      )}
      {sharedNoteTexts.length > 0 && (
        <div className="rounded-xl border border-sky-200/70 bg-sky-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-sky-900/40 dark:bg-sky-950/15">
          <p className="mb-1 font-medium text-foreground">Shared with others in these notes</p>
          {sharedNoteTexts.map((text) => (
            <p key={text.slice(0, 40)} className="whitespace-pre-wrap">
              {text}
            </p>
          ))}
        </div>
      )}
      {sourceText?.trim() && (
        <details className="group rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground marker:hidden hover:text-ink">
            Show what Orbit read for this person
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{sourceText}</p>
        </details>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  low,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  low?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id} className={cn("text-xs", low && "text-amber-700 dark:text-amber-400")}>
        {label}
        {low ? " *" : ""}
        {hint && <span className="ml-1 font-normal text-muted-foreground">· {hint}</span>}
      </Label>
      <div className={cn(low && "rounded-md ring-1 ring-amber-500/50 ring-offset-1 ring-offset-background")}>{children}</div>
    </div>
  );
}
