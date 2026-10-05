"use client";

/**
 * The editable heart of a person: the one form the card and the edit dialog both render,
 * so a field added here shows up in both.
 *
 * Takeaways lead, as a list of bullets rather than one box: they are what you reread before
 * the next conversation, and a list is how they come out of the note. Personal, work and
 * handles sit behind disclosures — open when the note filled them, closed but still
 * editable when it did not — so a sparse note does not produce a wall of empty inputs.
 */
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  /** One bullet per entry. Blank entries are dropped at save time. */
  takeaways: string[];
  personalDetails: string[];
  work: {
    team: string;
    building: string;
    priorities: string[];
    hiring: string;
    lookingFor: string;
  };
  phone: string;
  xHandle: string;
  website: string;
  school: string;
  industry: string;
};

/** Someone this person is linked to in the note — shown, not edited. */
export type PersonConnectionView = { name: string; relation: string | null };

export function PersonFields({
  value,
  onChange,
  lowConfidence,
  idPrefix,
  topics = [],
  sharedNoteTexts = [],
  sourceText,
  connections = [],
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
  connections?: readonly PersonConnectionView[];
  compact?: boolean;
}) {
  const work = value.work;
  const hasWork = Boolean(work.team || work.building || work.hiring || work.lookingFor || work.priorities.length);
  const hasHandles = Boolean(value.phone || value.xHandle || value.website || value.school || value.industry);
  const setWork = (patch: Partial<PersonFieldValues["work"]>) => onChange({ work: { ...work, ...patch } });
  const guessed = ["name", "company", "role", "met_at"].some((f) => lowConfidence.has(f));
  return (
    <div className={cn("space-y-3", !compact && "space-y-4")}>
      {guessed && (
        <p className="text-xs text-amber-700 dark:text-warning">Fields marked * were guessed — worth a glance.</p>
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
      <BulletList
        id={`${idPrefix}-takeaways`}
        label="What you took away"
        low={lowConfidence.has("summary") || lowConfidence.has("takeaways")}
        items={value.takeaways}
        onChange={(takeaways) => onChange({ takeaways })}
        addLabel="Add a takeaway"
        placeholder="Something worth remembering before you talk again"
      />

      <Section title="Personal" count={value.personalDetails.length}>
        <BulletList
          id={`${idPrefix}-personal`}
          label="Life outside work"
          items={value.personalDetails}
          onChange={(personalDetails) => onChange({ personalDetails })}
          addLabel="Add a detail"
          placeholder="Family, hobbies, hometown, what's coming up"
        />
      </Section>

      <Section title="Work" count={hasWork ? 1 : 0}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${idPrefix}-team`} label="Team">
            <Input id={`${idPrefix}-team`} value={work.team} onChange={(e) => setWork({ team: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-building`} label="Working on">
            <Input id={`${idPrefix}-building`} value={work.building} onChange={(e) => setWork({ building: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-hiring`} label="Hiring for">
            <Input id={`${idPrefix}-hiring`} value={work.hiring} onChange={(e) => setWork({ hiring: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-looking`} label="Looking for">
            <Input id={`${idPrefix}-looking`} value={work.lookingFor} onChange={(e) => setWork({ lookingFor: e.target.value })} autoComplete="off" />
          </Field>
        </div>
        <BulletList
          id={`${idPrefix}-priorities`}
          label="Priorities"
          items={work.priorities}
          onChange={(priorities) => setWork({ priorities })}
          addLabel="Add a priority"
          placeholder="What they're focused on or stuck on"
        />
      </Section>

      <Section title="Handles" count={hasHandles ? 1 : 0}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${idPrefix}-phone`} label="Phone">
            <Input id={`${idPrefix}-phone`} type="tel" value={value.phone} onChange={(e) => onChange({ phone: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-x`} label="X / Twitter">
            <Input id={`${idPrefix}-x`} value={value.xHandle} onChange={(e) => onChange({ xHandle: e.target.value })} placeholder="handle" autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-website`} label="Website">
            <Input id={`${idPrefix}-website`} value={value.website} onChange={(e) => onChange({ website: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-school`} label="School">
            <Input id={`${idPrefix}-school`} value={value.school} onChange={(e) => onChange({ school: e.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${idPrefix}-industry`} label="Industry" className="sm:col-span-2">
            <Input id={`${idPrefix}-industry`} value={value.industry} onChange={(e) => onChange({ industry: e.target.value })} autoComplete="off" />
          </Field>
        </div>
      </Section>

      {connections.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Knows</p>
          <ul className="flex flex-wrap gap-1.5">
            {connections.map((c) => (
              <li key={c.name}>
                <Badge variant="outline" className="text-[11px] font-normal">
                  <span className="font-medium text-foreground">{c.name}</span>
                  {c.relation && <span className="ml-1 text-muted-foreground">· {c.relation}</span>}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
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

/**
 * A disclosure for a group of optional fields, open when the note filled any of them.
 * React re-applies `open` only when the prop changes, so collapsing one by hand sticks
 * while you edit inside it.
 */
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details open={count > 0} className="group rounded-lg border border-border/60 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground marker:hidden hover:text-ink">
        {title}
        <span className="font-normal">{count > 0 ? "" : "none found · add"}</span>
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

/**
 * An editable list of one-line bullets. Enter in a row adds the next one; Backspace in an
 * empty row removes it and returns to the row above — how a bulleted list behaves in any
 * editor, which is the thing this is standing in for.
 */
function BulletList({
  id,
  label,
  low,
  items,
  onChange,
  addLabel,
  placeholder,
}: {
  id: string;
  label: string;
  low?: boolean;
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  placeholder: string;
}) {
  const focusRow = (i: number) =>
    requestAnimationFrame(() => document.getElementById(`${id}-${i}`)?.focus());
  return (
    <div className="space-y-1.5">
      <Label htmlFor={items.length ? `${id}-0` : `${id}-add`} className={cn("text-xs", low && "text-amber-700 dark:text-warning")}>
        {label}
        {low ? " *" : ""}
      </Label>
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span aria-hidden className="mt-[11px] size-1.5 shrink-0 rounded-full bg-primary/60" />
              <Textarea
                id={`${id}-${i}`}
                value={item}
                rows={1}
                aria-label={`${label} ${i + 1}`}
                placeholder={placeholder}
                onChange={(e) => onChange(items.map((v, j) => (j === i ? e.target.value.replace(/\n/g, " ") : v)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onChange([...items.slice(0, i + 1), "", ...items.slice(i + 1)]);
                    focusRow(i + 1);
                  } else if (e.key === "Backspace" && !item) {
                    e.preventDefault();
                    onChange(items.filter((_, j) => j !== i));
                    if (i > 0) focusRow(i - 1);
                  }
                }}
                className="min-h-9 resize-none py-1.5 text-sm [field-sizing:content]"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
                className="mt-0.5 shrink-0 text-muted-foreground"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        id={`${id}-add`}
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() => {
          onChange([...items, ""]);
          focusRow(items.length);
        }}
      >
        <Plus className="size-3.5" /> {addLabel}
      </Button>
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
      <Label htmlFor={id} className={cn("text-xs", low && "text-amber-700 dark:text-warning")}>
        {label}
        {low ? " *" : ""}
        {hint && <span className="ml-1 font-normal text-muted-foreground">· {hint}</span>}
      </Label>
      <div className={cn(low && "rounded-md ring-1 ring-amber-500/50 ring-offset-1 ring-offset-background")}>{children}</div>
    </div>
  );
}
