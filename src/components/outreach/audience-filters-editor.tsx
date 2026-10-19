"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { AudienceFilters } from "@/lib/outreach-types";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

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
    <Card variant="inset" size="sm">
      <CardHeader>
        <CardTitle as="h3">Confirm search filters</CardTitle>
        <CardDescription className="text-xs">
          Edit these before searching so company targeting stays accurate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showDemoWarning && (
          <div className={cn("rounded-lg border px-3 py-2 text-xs", TONE.warning.box, TONE.warning.text)}>
            No Apollo API key configured. Search will use clearly labeled demo prospects
            (not real Capital One people). Add a key in Settings → Outreach for live results.
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Companies" id="filter-orgs">
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
          </FormField>
          <FormField label="Domains" id="filter-domains">
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
          </FormField>
          <FormField label="Titles" id="filter-titles">
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
          </FormField>
          <FormField label="Locations" id="filter-locations">
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
          </FormField>
        </div>

        <FormField label="Keywords" id="filter-keywords">
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
        </FormField>
      </CardContent>
    </Card>
  );
}
