"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Plus, Sparkles, X } from "lucide-react";
import { saveCriteriaAction, suggestCriteriaAction } from "@/actions/outreach-campaigns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import {
  CRITERION_KINDS,
  type OutreachCriteria,
  type OutreachCriterion,
  type OutreachCriterionKind,
} from "@/lib/outreach/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Group = keyof OutreachCriteria;

const GROUPS: Array<{ key: Group; title: string; description: string }> = [
  { key: "required", title: "Required", description: "Someone must match all of these to be worth contacting." },
  { key: "preferred", title: "Preferred", description: "These make someone a better fit, most important first." },
  { key: "exclusions", title: "Exclude", description: "Anyone matching one of these is filtered out." },
];

export const KIND_LABEL: Record<OutreachCriterionKind, string> = {
  role: "Role",
  organization: "Organization",
  geography: "Place",
  experience: "Experience",
  other: "Other",
};

const isEmpty = (c: OutreachCriteria) => c.required.length + c.preferred.length + c.exclusions.length === 0;

export function CriteriaEditor({
  campaignId,
  initial,
  confirmed,
}: {
  campaignId: string;
  initial: OutreachCriteria;
  confirmed: boolean;
}) {
  const router = useRouter();
  const [criteria, setCriteria] = useState<OutreachCriteria>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [drafting, setDrafting] = useState(false);
  const [pending, start] = useTransition();
  const headingId = useId();
  const dirty = JSON.stringify(criteria) !== baseline;

  async function draftFromBrief() {
    setDrafting(true);
    try {
      const result = await suggestCriteriaAction(campaignId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.value.source === "fallback") {
        toast.message("Couldn’t draft criteria — add them yourself below");
        return;
      }
      setCriteria(result.value.criteria);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t draft criteria — add them yourself below"));
    } finally {
      setDrafting(false);
    }
  }

  function setGroup(group: Group, items: OutreachCriterion[]) {
    setCriteria((current) => ({
      ...current,
      [group]: group === "preferred" ? items.map((item, index) => ({ ...item, priority: index })) : items,
    }));
  }

  function confirm() {
    start(async () => {
      try {
        const result = await saveCriteriaAction(campaignId, criteria);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setBaseline(JSON.stringify(criteria));
        toast.success(result.value.rerankQueued ? "Audience confirmed — re-ranking the people you’ve found" : "Audience confirmed");
        router.push(`/outreach/${campaignId}/people`);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t confirm the audience"));
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-medium text-ink">
            Who you want to reach
          </h2>
          <p className="text-sm text-muted-foreground">Orbit searches and ranks people against these. Nothing is searched until you confirm.</p>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {drafting ? "Drafting criteria from your description" : ""}
      </p>

      {isEmpty(criteria) && (
        <div className="rounded-2xl border border-dashed border-border/70 p-6 text-center">
          <p className="text-sm text-muted-foreground">Start from your description, or add criteria yourself below.</p>
          <Button className="mt-3" onClick={draftFromBrief} disabled={drafting}>
            <Sparkles className="size-4" aria-hidden />
            {drafting ? "Drafting…" : "Draft from my description"}
          </Button>
        </div>
      )}

      {GROUPS.map((group) => (
        <CriteriaGroup
          key={group.key}
          group={group.key}
          title={group.title}
          description={group.description}
          items={criteria[group.key]}
          onChange={(items) => setGroup(group.key, items)}
        />
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card px-5 py-4">
        <p className="text-sm text-muted-foreground">
          {confirmed
            ? dirty
              ? "Unsaved changes — confirming re-ranks everyone already found"
              : "This audience is confirmed"
            : "Confirm to start finding people"}
        </p>
        <div className="flex gap-2">
          {confirmed && !dirty && (
            <Button variant="outline" onClick={() => router.push(`/outreach/${campaignId}/people`)}>
              Go to people
            </Button>
          )}
          <Button onClick={confirm} disabled={pending || isEmpty(criteria) || (confirmed && !dirty)}>
            {pending ? "Confirming…" : confirmed ? "Confirm changes" : "Confirm audience"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function CriteriaGroup({
  group,
  title,
  description,
  items,
  onChange,
}: {
  group: Group;
  title: string;
  description: string;
  items: OutreachCriterion[];
  onChange: (items: OutreachCriterion[]) => void;
}) {
  const headingId = useId();
  const reorderable = group === "preferred";
  const move = (index: number, delta: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-border/70 bg-card p-5">
      <h3 id={headingId} className="text-sm font-medium text-ink">
        {title}
      </h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      {items.length > 0 && (
        <ul className="mt-3 space-y-2">
          {items.map((criterion, index) => (
            <li key={criterion.id} className="flex items-start gap-2 rounded-xl border border-border/70 bg-background px-3 py-2">
              <span className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                {KIND_LABEL[criterion.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{criterion.label}</p>
                {criterion.values.join(", ") !== criterion.label && (
                  <p className="text-xs text-muted-foreground">{criterion.values.join(", ")}</p>
                )}
              </div>
              {reorderable && (
                <div className="flex shrink-0">
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${criterion.label} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${criterion.label} down`}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </Button>
                </div>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${criterion.label}`}
                onClick={() => onChange(items.filter((c) => c.id !== criterion.id))}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AddCriterion group={group} onAdd={(criterion) => onChange([...items, criterion])} />
    </section>
  );
}

function AddCriterion({ group, onAdd }: { group: Group; onAdd: (criterion: OutreachCriterion) => void }) {
  const [kind, setKind] = useState<OutreachCriterionKind>(group === "exclusions" ? "organization" : "role");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState("");
  const labelId = useId();
  const valuesId = useId();
  const kindLabelId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    const list = values
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    onAdd({ id: crypto.randomUUID(), kind, label: trimmed, values: list.length ? list : [trimmed], priority: 0 });
    setLabel("");
    setValues("");
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 border-t border-border/60 pt-3">
      <div role="radiogroup" aria-labelledby={kindLabelId} className="flex flex-wrap items-center gap-1.5">
        <span id={kindLabelId} className="mr-1 text-xs text-muted-foreground">
          Add a
        </span>
        {CRITERION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              kind === k ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <Label htmlFor={labelId} className="sr-only">
            Criterion
          </Label>
          <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Partnerships leader" />
        </div>
        <div>
          <Label htmlFor={valuesId} className="sr-only">
            Search terms, comma separated
          </Label>
          <Input
            id={valuesId}
            value={values}
            onChange={(e) => setValues(e.target.value)}
            placeholder="Search terms, comma separated"
          />
        </div>
        <Button type="submit" variant="outline" disabled={!label.trim()}>
          <Plus className="size-4" aria-hidden />
          Add
        </Button>
      </div>
    </form>
  );
}
