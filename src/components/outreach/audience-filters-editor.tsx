"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AudienceFilters } from "@/lib/outreach-types";

function listToText(values?: string[]) {
  return (values ?? []).join(", ");
}

function textToList(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function AudienceFiltersEditor({
  filters,
  onChange,
  showDemoWarning,
}: {
  filters: AudienceFilters;
  onChange: (next: AudienceFilters) => void;
  showDemoWarning?: boolean;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
      <div>
        <p className="text-sm font-medium text-ink">Confirm search filters</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Edit these before searching so company targeting stays accurate.
        </p>
      </div>

      {showDemoWarning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          No Apollo API key configured. Search will use clearly labeled demo prospects
          (not real Capital One people). Add a key in Settings → Outreach for live results.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="filter-orgs">Companies</Label>
          <Input
            id="filter-orgs"
            value={listToText(filters.organizationNames)}
            onChange={(e) =>
              onChange({
                ...filters,
                organizationNames: textToList(e.target.value),
              })
            }
            placeholder="Capital One"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-domains">Domains</Label>
          <Input
            id="filter-domains"
            value={listToText(filters.organizationDomains)}
            onChange={(e) =>
              onChange({
                ...filters,
                organizationDomains: textToList(e.target.value),
              })
            }
            placeholder="capitalone.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-titles">Titles</Label>
          <Input
            id="filter-titles"
            value={listToText(filters.titles)}
            onChange={(e) =>
              onChange({
                ...filters,
                titles: textToList(e.target.value),
              })
            }
            placeholder="Recruiter, University Recruiter"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-locations">Locations</Label>
          <Input
            id="filter-locations"
            value={listToText(filters.locations)}
            onChange={(e) =>
              onChange({
                ...filters,
                locations: textToList(e.target.value),
              })
            }
            placeholder="United States"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="filter-keywords">Keywords</Label>
        <Input
          id="filter-keywords"
          value={filters.keywords || ""}
          onChange={(e) =>
            onChange({
              ...filters,
              keywords: e.target.value,
            })
          }
          placeholder="SWE internship recruiter"
        />
      </div>
    </div>
  );
}
