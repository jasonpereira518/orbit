"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PLANS = [
  { value: "all", label: "All plans" },
  { value: "free", label: "Free" },
  { value: "orbit", label: "Orbit Pro" },
  { value: "lifetime", label: "Lifetime" },
  { value: "comped", label: "Comped" },
];

const STATES = [
  { value: "all", label: "Any state" },
  { value: "live", label: "Active now" },
  { value: "no-key", label: "No AI key" },
  { value: "past-due", label: "Past due" },
  { value: "failing-ai", label: "AI failing" },
  { value: "inactive", label: "No contacts" },
  { value: "suspended", label: "Suspended" },
];

/** Filter state lives in the URL, so any view is linkable and the back button works. */
export function UsersFilterBar({
  q,
  plan,
  state,
  sort,
  dir,
}: {
  q: string;
  plan: string;
  state: string;
  sort: string;
  dir?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const push = (next: Record<string, string>) => {
    const params = new URLSearchParams({ q, plan, state, sort, dir: dir ?? "", ...next });
    for (const [key, value] of [...params.entries()]) {
      if (!value || value === "all") params.delete(key);
    }
    // Any change to the filters invalidates the current page number: staying on page 4 of a
    // result set that just shrank to one page shows an empty table and reads as "no matches".
    params.delete("page");
    const query = params.toString();
    startTransition(() => router.push(`/admin/users${query ? `?${query}` : ""}`));
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 transition-opacity duration-fast",
        pending && "opacity-60"
      )}
    >
      <div className="relative min-w-56 flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          defaultValue={q}
          placeholder="Search name, email or user id…"
          aria-label="Search accounts"
          className="h-8 pl-8 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") push({ q: e.currentTarget.value });
          }}
          onBlur={(e) => {
            if (e.currentTarget.value !== q) push({ q: e.currentTarget.value });
          }}
        />
      </div>

      <FilterGroup
        label="Plan"
        options={PLANS}
        value={plan}
        onSelect={(value) => push({ plan: value })}
      />
      <FilterGroup
        label="State"
        options={STATES}
        value={state}
        onSelect={(value) => push({ state: value })}
      />
    </div>
  );
}

function FilterGroup({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg border border-border/70 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "rounded-md px-2 py-1 text-xs transition-colors duration-fast",
            value === option.value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
