"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  previewLinkedInCsv,
  confirmLinkedInImport,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import {
  BusyHint,
  ImportProgress,
  useBatchedImport,
} from "@/components/imports/import-utils";

type ConnectionsPreview = Awaited<ReturnType<typeof previewLinkedInCsv>>;
type ConnectionPerson = ConnectionsPreview["people"][number];

export function LinkedInConnectionsImport() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { importProgress, runBatchedImport } = useBatchedImport();

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("linkedin.csv");
  const [people, setPeople] = useState<ConnectionPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const busy = pending || importProgress !== null;

  function applyPreview(res: ConnectionsPreview) {
    setPeople(res.people);
    setSelected(new Set(res.people.map((p) => p.id)));
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-primary">
            LinkedIn connections
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload your Connections CSV, review everyone, then import into your
            orbit.
          </p>
        </div>
        <LinkedInExportGuide variant="connections" />
      </div>

      <input
        type="file"
        accept=".csv,text/csv"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          start(async () => {
            try {
              setFileName(file.name);
              const text = await file.text();
              setCsvText(text);
              const res = await previewLinkedInCsv(text);
              applyPreview(res);
              toast.success(`Loaded ${res.totalRows} people`);
            } catch (err) {
              setPeople([]);
              setSelected(new Set());
              toast.error(
                err instanceof Error ? err.message : "Preview failed"
              );
            }
          });
        }}
      />

      {pending && !importProgress ? <BusyHint>Reading CSV…</BusyHint> : null}
      {importProgress ? <ImportProgress {...importProgress} /> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!csvText || busy}
          variant="outline"
          onClick={() =>
            start(async () => {
              try {
                const res = await previewLinkedInCsv(csvText);
                applyPreview(res);
                toast.success(`Loaded ${res.totalRows} people`);
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Preview failed"
                );
              }
            })
          }
        >
          Refresh list
        </Button>
        <Button
          disabled={!csvText || busy || selected.size === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={async () => {
            if (busy) return;
            try {
              const ids = [...selected];
              const res = await runBatchedImport(
                ids,
                ids.length === 1 ? "person" : "people",
                (chunk, opts) =>
                  confirmLinkedInImport(csvText, fileName, chunk, opts)
              );
              toast.success(
                `Imported: ${res.contactsCreated} created, ${res.contactsUpdated} updated`
              );
              setPeople([]);
              setSelected(new Set());
              setCsvText("");
              router.refresh();
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Import failed"
              );
            }
          }}
        >
          {importProgress
            ? `Importing… ${importProgress.done}/${importProgress.total}`
            : `Import ${selected.size || 0} selected`}
        </Button>
      </div>

      {people.length > 0 && (
        <ImportPeopleReview
          people={people.map((p) => ({
            id: p.id,
            name: p.fullName,
            subtitle: [p.position, p.company].filter(Boolean).join(" · "),
            isRepeat: p.isRepeat,
            repeatReason: p.duplicate?.reason,
          }))}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          onRemove={(id) => {
            setPeople((prev) => prev.filter((p) => p.id !== id));
            setSelected((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }}
        />
      )}
    </section>
  );
}
