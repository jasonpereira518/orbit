"use client";
import type { Brief, Criterion } from "@/lib/outreach-v2/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "lucide-react";
export function AudienceCriteria({
  value,
  onChange,
}: {
  value: Brief;
  onChange: (brief: Brief) => void;
}) {
  function edit(index: number, patch: Partial<Criterion>) {
    onChange({
      ...value,
      criteria: value.criteria.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  }
  return (
    <div className="space-y-3">
      {(["required", "preferred", "excluded"] as const).map((importance) => (
        <fieldset
          key={importance}
          className="space-y-3 border-b pb-5 last:border-0"
        >
          <legend className="mb-3 text-sm font-medium text-ink">
            {importance === "required"
              ? "Must match"
              : importance === "preferred"
                ? "Nice to have"
                : "Leave out"}
            <span className="ml-2 font-normal text-muted-foreground">
              {value.criteria.filter((c) => c.importance === importance).length}
            </span>
          </legend>
          {value.criteria.map(
            (c, i) =>
              c.importance === importance && (
                <div key={i} className="flex flex-wrap gap-2">
                  <select
                    aria-label={`Criterion ${i + 1} importance`}
                    value={c.importance}
                    onChange={(e) =>
                      edit(i, {
                        importance: e.target.value as Criterion["importance"],
                      })
                    }
                    className="rounded-md border bg-background p-2 text-sm"
                  >
                    <option value="required">Required</option>
                    <option value="preferred">Preferred</option>
                    <option value="excluded">Exclude</option>
                  </select>
                  <select
                    aria-label={`Criterion ${i + 1} field`}
                    value={c.field}
                    onChange={(e) =>
                      edit(i, { field: e.target.value as Criterion["field"] })
                    }
                    className="rounded-md border bg-background p-2 text-sm"
                  >
                    {["title", "company", "location", "experience"].map((f) => (
                      <option key={f} value={f}>
                        {
                          {
                            title: "Role",
                            company: "Organization",
                            location: "Location",
                            experience: "Experience",
                          }[f]
                        }
                      </option>
                    ))}
                  </select>
                  <Input
                    className="min-w-36 flex-1"
                    aria-label={`Criterion ${i + 1} value`}
                    value={c.value}
                    maxLength={200}
                    onChange={(e) => edit(i, { value: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove criterion ${i + 1}`}
                    onClick={() =>
                      onChange({
                        ...value,
                        criteria: value.criteria.filter((_, n) => n !== i),
                      })
                    }
                  >
                    <X size={16} />
                  </Button>
                </div>
              ),
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={value.criteria.length >= 20}
            onClick={() =>
              onChange({
                ...value,
                criteria: [
                  ...value.criteria,
                  { field: "experience", importance, value: "" },
                ],
              })
            }
          >
            <Plus size={14} />
            {importance === "required"
              ? "Add requirement"
              : importance === "preferred"
                ? "Add preference"
                : "Add exclusion"}
          </Button>
        </fieldset>
      ))}
    </div>
  );
}
