"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Building2, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 250;

const CLOSENESS_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "2", label: "2+" },
  { value: "3", label: "3+" },
  { value: "4", label: "4+" },
  { value: "5", label: "5" },
] as const;

type FilterState = {
  q: string;
  company: string;
  minScore: string;
  followUp: string;
};

export function ContactsFilters({
  initialQ,
  initialCompany,
  initialMinScore,
  initialFollowUp,
  children,
}: {
  initialQ: string;
  initialCompany: string;
  initialMinScore: string;
  initialFollowUp?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [company, setCompany] = useState(initialCompany);
  const [companyDraft, setCompanyDraft] = useState(initialCompany);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [minScore, setMinScore] = useState(initialMinScore || "any");
  const [followUp, setFollowUp] = useState(initialFollowUp || "");
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  function apply(next?: Partial<FilterState>) {
    const params = new URLSearchParams();
    const qq = (next?.q ?? q).trim();
    const cc = (next?.company ?? company).trim();
    const ms = next?.minScore ?? minScore;
    const fu = next?.followUp ?? followUp;
    if (qq) params.set("q", qq);
    if (cc) params.set("company", cc);
    if (ms && ms !== "any") params.set("minScore", ms);
    if (fu === "due") params.set("followUp", "due");
    const qs = params.toString();
    const href = qs ? `/contacts?${qs}` : "/contacts";
    router.replace(href);
    router.refresh();
  }

  function scheduleSearch(value: string) {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    if (!value.trim()) {
      apply({ q: "" });
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      apply({ q: value });
    }, SEARCH_DEBOUNCE_MS);
  }

  const closenessLabel =
    CLOSENESS_OPTIONS.find((o) => o.value === minScore)?.label ?? "Any";
  const companyActive = Boolean(company.trim());
  const closenessActive = minScore !== "any";

  return (
    <div className="space-y-6">
      {followUp === "due" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            Showing contacts with due follow-ups
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setFollowUp("");
              apply({ followUp: "" });
            }}
          >
            Clear filter
          </Button>
        </div>
      )}

      <div className="mx-auto w-full max-w-xl">
        <SearchPill
          q={q}
          company={company}
          companyDraft={companyDraft}
          companyOpen={companyOpen}
          minScore={minScore}
          closenessLabel={closenessLabel}
          companyActive={companyActive}
          closenessActive={closenessActive}
          onQChange={(value) => {
            setQ(value);
            scheduleSearch(value);
          }}
          onClearQ={() => {
            setQ("");
            scheduleSearch("");
          }}
          onCompanyOpenChange={(open) => {
            setCompanyOpen(open);
            if (open) setCompanyDraft(company);
          }}
          onCompanyDraftChange={setCompanyDraft}
          onCompanyApply={(next) => {
            setCompany(next);
            setCompanyOpen(false);
            apply({ company: next });
          }}
          onCompanyClear={() => {
            setCompany("");
            setCompanyDraft("");
            setCompanyOpen(false);
            apply({ company: "" });
          }}
          onMinScoreChange={(val) => {
            setMinScore(val);
            apply({ minScore: val });
          }}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
        {children}
      </div>
    </div>
  );
}

function SearchPill({
  q,
  company,
  companyDraft,
  companyOpen,
  minScore,
  closenessLabel,
  companyActive,
  closenessActive,
  onQChange,
  onClearQ,
  onCompanyOpenChange,
  onCompanyDraftChange,
  onCompanyApply,
  onCompanyClear,
  onMinScoreChange,
}: {
  q: string;
  company: string;
  companyDraft: string;
  companyOpen: boolean;
  minScore: string;
  closenessLabel: string;
  companyActive: boolean;
  closenessActive: boolean;
  onQChange: (value: string) => void;
  onClearQ: () => void;
  onCompanyOpenChange: (open: boolean) => void;
  onCompanyDraftChange: (value: string) => void;
  onCompanyApply: (value: string) => void;
  onCompanyClear: () => void;
  onMinScoreChange: (value: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex h-11 w-full items-center gap-1 rounded-full border border-border/70 bg-card pl-3.5 pr-1.5 shadow-sm",
        "focus-within:border-primary/40 focus-within:ring-[3px] focus-within:ring-primary/15"
      )}
    >
      <input
        type="text"
        placeholder="Search contacts…"
        value={q}
        aria-label="Search contacts"
        autoComplete="off"
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-sm outline-none",
          "placeholder:text-muted-foreground"
        )}
        onChange={(e) => onQChange(e.target.value)}
      />
      {q ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          className="shrink-0 rounded-full text-muted-foreground"
          onClick={onClearQ}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}

      <div className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />

      <Popover open={companyOpen} onOpenChange={onCompanyOpenChange}>
        <PopoverTrigger
          type="button"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors sm:px-2.5",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            companyActive
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Building2 className="size-3.5" />
          <span className="hidden max-w-[5rem] truncate sm:inline">
            {companyActive ? company : "Company"}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-2 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Exact company
          </p>
          <Input
            autoFocus
            placeholder="e.g. Acme"
            value={companyDraft}
            onChange={(e) => onCompanyDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCompanyApply(companyDraft.trim());
              }
            }}
          />
          <div className="flex justify-end gap-1.5">
            {companyActive ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCompanyClear}
              >
                Clear
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={() => onCompanyApply(companyDraft.trim())}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors sm:px-2.5",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            closenessActive
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <span className="truncate">
            {closenessActive ? closenessLabel : "Closeness"}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[8rem]">
          {CLOSENESS_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => onMinScoreChange(opt.value)}
            >
              {opt.label}
              {minScore === opt.value ? (
                <span className="ml-auto text-xs text-muted-foreground">✓</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
