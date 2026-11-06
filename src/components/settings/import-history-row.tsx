"use client";

import { useState } from "react";
import { History } from "lucide-react";
import type { ImportHistoryItem } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { FeatureRow } from "@/components/settings/account-page";
import { ImportUndoButton } from "@/components/imports/import-finish-card";
import { importSourceLabel } from "@/lib/imports/import-sources";
import { summarizeImport } from "@/lib/imports/import-summary";
import { importUndoable, withinUndoWindow } from "@/lib/imports/import-finish";

/** How many imports a page reads for its history row (`listImports({ limit })`). */
export const IMPORT_HISTORY_LIMIT = 20;
const FIRST_IMPORTS = 5;

/**
 * One source's import history as an account-page row: the latest five, Show all up to
 * `IMPORT_HISTORY_LIMIT`, and Undo where the /imports sheet would offer it (same rules:
 * this import created people, its type can be undone, not undone yet, inside the window).
 */
export function ImportHistoryRow({
  history,
  source,
  tone,
  onUndone,
}: {
  /** Null while loading. */
  history: ImportHistoryItem[] | null;
  /** Names the uploads in the summary line: "3 LinkedIn imports". */
  source: string;
  tone?: string;
  onUndone: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const items = history ? (showAll ? history : history.slice(0, FIRST_IMPORTS)) : [];
  return (
    <FeatureRow
      icon={<History className="size-4" />}
      tone={tone}
      title="Import history"
      description={
        history === null
          ? "Loading…"
          : history.length
            ? `${history.length === IMPORT_HISTORY_LIMIT ? `Last ${IMPORT_HISTORY_LIMIT}` : history.length} ${source} ${history.length === 1 ? "import" : "imports"}`
            : "Nothing imported yet."
      }
      control={{ kind: "none" }}
      onAction={() => {}}
    >
      {items.length ? (
        <>
          <ul className="divide-y divide-border/60">
            {items.map((item) => {
              const chips = summarizeImport(item);
              const undoable =
                !item.stats?.undoneAt &&
                (item.contactsCreated ?? 0) > 0 &&
                importUndoable(item.importType) &&
                withinUndoWindow(new Date(item.createdAt));
              return (
                <li key={item.id} className="flex items-start gap-3 py-2.5 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {importSourceLabel(item.importType)}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {new Date(item.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.stats?.undoneAt
                        ? "Undone"
                        : item.status !== "completed"
                          ? item.status === "failed"
                            ? "Didn’t finish"
                            : "In progress"
                          : chips.map((c) => c.label).join(" · ") || "Nothing new"}
                    </p>
                  </div>
                  {undoable ? <ImportUndoButton importIds={[item.id]} size="xs" onUndone={onUndone} /> : null}
                </li>
              );
            })}
          </ul>
          {history && history.length > FIRST_IMPORTS ? (
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${history.length}`}
            </Button>
          ) : null}
        </>
      ) : null}
    </FeatureRow>
  );
}
