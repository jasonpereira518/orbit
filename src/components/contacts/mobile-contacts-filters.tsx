"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CONTACT_SORTS, QUIET_OPTIONS, SAME_SCHOOL_AS_ME } from "@/lib/contacts-page";

export type MobileContactFilterState = {
  q: string;
  company: string;
  minScore: string;
  followUp: string;
  sort: string;
  quiet: string;
  school: string;
};

type Option = { value: string; label: string };

function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<Option>;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** Pending choices stay local until Apply; closing the sheet never changes results. */
export function MobileContactsFilters({ value, count, closenessOptions, schoolOptions, onSearch, onApply, onReset }: {
  value: MobileContactFilterState;
  count: number;
  closenessOptions: ReadonlyArray<Option>;
  schoolOptions: { mine: string[]; network: string[] };
  onSearch: (query: string) => void;
  onApply: (next: MobileContactFilterState) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const schools = Array.from(new Set([
    ...(draft.school && draft.school !== SAME_SCHOOL_AS_ME ? [draft.school] : []),
    ...schoolOptions.network,
  ]));

  function update<K extends keyof MobileContactFilterState>(key: K, next: MobileContactFilterState[K]) {
    setDraft((current) => ({ ...current, [key]: next }));
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-xl items-center gap-2 sm:hidden">
        <Input type="search" value={value.q} aria-label="Search contacts" placeholder="Search contacts…" onChange={(event) => onSearch(event.target.value)} />
        <Button variant="outline" className="min-h-11 gap-2" onClick={() => { setDraft(value); setOpen(true); }}>
          <SlidersHorizontal aria-hidden className="size-4" />
          Filters{count > 0 ? ` (${count})` : ""}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[90dvh] gap-0 overflow-y-auto pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle>Filter contacts</SheetTitle>
            <SheetDescription>Choose who to see and how to order them.</SheetDescription>
          </SheetHeader>
          <form className="space-y-4 px-4 pb-4" onSubmit={(event) => {
            event.preventDefault();
            onApply({ ...draft, q: value.q });
            setOpen(false);
          }}>
            <label className="block space-y-1 text-sm">
              <span>Company</span>
              <Input value={draft.company} onChange={(event) => update("company", event.target.value)} />
            </label>
            <FilterSelect label="Closeness" value={draft.minScore} onChange={(next) => update("minScore", next)} options={closenessOptions} />
            <FilterSelect label="Sort by" value={draft.sort} onChange={(next) => update("sort", next)} options={CONTACT_SORTS} />
            <FilterSelect
              label="Gone quiet"
              value={draft.quiet}
              onChange={(next) => update("quiet", next)}
              options={[{ value: "", label: "Any activity" }, ...QUIET_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))]}
            />
            <FilterSelect
              label="School"
              value={draft.school}
              onChange={(next) => update("school", next)}
              options={[
                { value: "", label: "Any school" },
                ...(schoolOptions.mine.length ? [{ value: SAME_SCHOOL_AS_ME, label: "Same school as me" }] : []),
                ...schools.map((name) => ({ value: name, label: name })),
              ]}
            />
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" checked={draft.followUp === "due"} onChange={(event) => update("followUp", event.target.checked ? "due" : "")} className="size-5 accent-primary" />
              Due follow-ups only
            </label>
            <div className="sticky bottom-0 flex gap-3 border-t border-border bg-popover pt-3">
              <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => { onReset(); setOpen(false); }}>Reset filters</Button>
              <Button type="submit" className="min-h-11 flex-1">Apply filters</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
