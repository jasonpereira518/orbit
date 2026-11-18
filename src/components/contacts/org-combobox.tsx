"use client";

import { useEffect, useRef, useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Building2, GraduationCap, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFieldControl } from "@/components/ui/field";
import { lookupCuratedBrandByName } from "@/lib/brand-colors";
import { companyBrandColor } from "@/lib/company-brand";
import type { OrgKind, OrgSuggestion } from "@/lib/org-suggest";
import { cn } from "@/lib/utils";

export type PickedOrg = { name: string; domain: string | null };

const KIND_LABELS: Record<OrgKind, string> = { company: "Company", school: "School", org: "Organization" };
const DEBOUNCE_MS = 200;

/**
 * An organization's logo: its favicon through Orbit's logo route, else a monogram tinted in
 * its brand color when Orbit knows one. Decorative — the name is always shown beside it.
 */
export function OrgLogo({ name, domain, className }: { name: string; domain: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const tile = cn("grid shrink-0 place-items-center overflow-hidden rounded-md", className);
  if (domain && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a same-origin 64px proxy, as elsewhere
      <img
        src={`/api/logos/${encodeURIComponent(domain)}`}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        className={cn(tile, "bg-white object-contain p-px")}
        onError={() => setFailed(true)}
        // The logo route answers a miss with a 1×1 transparent pixel rather than a 404.
        onLoad={(e) => e.currentTarget.naturalWidth <= 1 && setFailed(true)}
      />
    );
  }
  const color = companyBrandColor(name);
  return (
    <span
      aria-hidden
      className={cn(tile, "bg-muted text-[0.625rem] font-semibold text-muted-foreground")}
      style={color ? { backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`, color } : undefined}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** `/api/orgs/suggest` as the person types: debounced, each keystroke aborting the last. */
function useOrgSearch() {
  const [suggestions, setSuggestions] = useState<OrgSuggestion[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    inflight.current?.abort();
  }

  useEffect(() => cancel, []);

  function search(q: string) {
    cancel();
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(() => {
      const controller = new AbortController();
      inflight.current = controller;
      fetch(`/api/orgs/suggest?q=${encodeURIComponent(q.trim())}`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ suggestions?: OrgSuggestion[] }>) : null))
        .then((res) => {
          if (!controller.signal.aborted) setSuggestions(res?.suggestions ?? []);
        })
        .catch(() => {
          // Aborted by the next keystroke, or offline: what was typed still stands.
        });
    }, DEBOUNCE_MS);
  }

  function reset() {
    cancel();
    setSuggestions([]);
  }

  return { suggestions, search, reset };
}

type Row = (OrgSuggestion & { add?: false }) | { add: true; name: string };

/**
 * The text field for picking an organization: suggestions with logos as the person types,
 * plus an "Add …" row so free text is never blocked. The list is a portaled popover, so it
 * never pushes the page's layout. Keyboard and ARIA come from Base UI's Autocomplete.
 */
export function OrgCombobox({
  id,
  disabled,
  placeholder,
  onPick,
  className,
}: {
  id: string;
  disabled?: boolean;
  placeholder: string;
  onPick: (org: PickedOrg) => void;
  className?: string;
}) {
  const [text, setText] = useState("");
  const { suggestions, search, reset } = useOrgSearch();
  const highlighted = useRef<Row | undefined>(undefined);

  function pick(org: PickedOrg) {
    const name = org.name.trim();
    if (!name) return;
    onPick({ name, domain: org.domain });
    setText("");
    reset();
  }

  const typed = text.trim();
  const exact = suggestions.some((s) => s.name.toLowerCase() === typed.toLowerCase());
  const rows: Row[] = [...suggestions, ...(typed && !exact ? [{ add: true as const, name: typed }] : [])];

  return (
    <Autocomplete.Root
      items={rows}
      value={text}
      mode="list"
      filter={null}
      disabled={disabled}
      itemToStringValue={(row: Row) => row.name}
      onItemHighlighted={(row) => {
        highlighted.current = row;
      }}
      onOpenChange={(open) => {
        if (!open) highlighted.current = undefined;
      }}
      onValueChange={(next, details) => {
        // Picking an item would put its name in the box; the pick already became a chip.
        if (details.reason === "item-press") {
          setText("");
          return;
        }
        setText(next);
        search(next);
      }}
    >
      <Autocomplete.InputGroup
        className={cn(
          "flex h-10 items-center gap-2 rounded-full border border-input bg-card pr-1 pl-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          className,
        )}
      >
        <Building2 className="size-4 shrink-0 text-primary" aria-hidden />
        <Autocomplete.Input
          id={id}
          placeholder={placeholder}
          enterKeyHint="done"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          onKeyDown={(e) => {
            // Enter with nothing highlighted adds the typed text; a highlighted row picks itself.
            if (e.key === "Enter" && !highlighted.current) {
              e.preventDefault();
              pick({ name: text, domain: null });
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-full px-3"
          disabled={disabled || !text.trim()}
          onClick={() => pick({ name: text, domain: null })}
        >
          Add
        </Button>
      </Autocomplete.InputGroup>

      <Autocomplete.Portal hidden={rows.length === 0}>
        <Autocomplete.Positioner className="isolate z-50 outline-none" sideOffset={6} align="start">
          <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-64 overflow-y-auto overscroll-contain rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Autocomplete.List>
              {(row: Row) => (
                <Autocomplete.Item
                  key={row.add ? `add:${row.name}` : `${row.source}:${row.name}`}
                  value={row}
                  onClick={() => pick({ name: row.name, domain: row.add ? null : row.domain })}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {row.add ? (
                    <>
                      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                        <Plus className="size-3.5" />
                      </span>
                      <span className="min-w-0 truncate">
                        Add “{row.name}”
                      </span>
                    </>
                  ) : (
                    <>
                      <OrgLogo name={row.name} domain={row.domain} className="size-6" />
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {KIND_LABELS[row.kind]}
                        {row.domain ? ` · ${row.domain}` : ""}
                      </span>
                    </>
                  )}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}

/**
 * One organization as a form field (the contact form's Company and School): the box holds
 * the value, and the same suggestions as `OrgCombobox` drop down under it as the person types.
 * Arrow to a match and press Enter, or keep typing — free text always stands.
 *
 * `localNames` are the person's own values for this field (their contacts' schools), matched
 * client-side and listed first; the server's "yours" only reads saved company names.
 */
export function OrgField({
  value,
  onChange,
  onPick,
  kind,
  localNames = [],
  placeholder,
  id,
}: {
  value: string;
  onChange: (name: string) => void;
  /** A suggestion was chosen (not merely typed). */
  onPick?: (org: PickedOrg) => void;
  kind: "company" | "school";
  localNames?: readonly string[];
  placeholder?: string;
  id?: string;
}) {
  const { suggestions, search, reset } = useOrgSearch();
  const [pickedDomain, setPickedDomain] = useState<string | null>(null);
  const control = useFieldControl({ id });

  const q = value.trim().toLowerCase();
  const local: OrgSuggestion[] =
    q.length < 2
      ? []
      : localNames
          .filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q)
          .slice(0, 3)
          .map((name) => ({ name, domain: null, kind, source: "yours" as const }));
  const seen = new Set(local.map((r) => r.name.toLowerCase()));
  const rows = [
    ...local,
    // Stable sort: the field's own kind first, so "Stanford" in School isn't a company row.
    ...[...suggestions]
      .filter((r) => !seen.has(r.name.toLowerCase()) && r.name.toLowerCase() !== q)
      .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind)),
  ];

  const domain = value.trim()
    ? (pickedDomain ?? lookupCuratedBrandByName(value, kind)?.domain ?? null)
    : null;
  const Icon = kind === "school" ? GraduationCap : Building2;

  function pick(row: OrgSuggestion) {
    onChange(row.name);
    setPickedDomain(row.domain);
    onPick?.({ name: row.name, domain: row.domain });
    reset();
  }

  return (
    <Autocomplete.Root
      items={rows}
      value={value}
      mode="list"
      filter={null}
      itemToStringValue={(row: OrgSuggestion) => row.name}
      onValueChange={(next, details) => {
        if (details.reason === "item-press") return; // the item's onClick picks it
        onChange(next);
        setPickedDomain(null);
        search(next);
      }}
    >
      <Autocomplete.InputGroup data-slot="org-field" className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent pl-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
        {value.trim() ? (
          <OrgLogo name={value} domain={domain} className="size-5" />
        ) : (
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <Autocomplete.Input
          {...control}
          placeholder={placeholder}
          autoComplete="off"
          dir="auto"
          className="h-full min-w-0 flex-1 bg-transparent pr-2.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
          onKeyDown={(e) => {
            // A highlighted row picks itself; otherwise Enter just closes the list. It never
            // submits the whole form from a half-typed name (⌘↵ saves).
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault();
          }}
        />
      </Autocomplete.InputGroup>

      <Autocomplete.Portal hidden={rows.length === 0}>
        <Autocomplete.Positioner className="isolate z-50 outline-none" sideOffset={6} align="start">
          <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-56 overflow-y-auto overscroll-contain rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Autocomplete.List>
              {(row: OrgSuggestion) => (
                <Autocomplete.Item
                  key={`${row.source}:${row.name}`}
                  value={row}
                  onClick={() => pick(row)}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <OrgLogo name={row.name} domain={row.domain} className="size-6" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {row.source === "yours" ? "In your orbit" : KIND_LABELS[row.kind]}
                  </span>
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
