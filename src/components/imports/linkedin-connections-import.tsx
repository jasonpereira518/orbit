"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  previewLinkedInCsv,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { LinkedInExportGuide } from "@/components/imports/linkedin-export-guide";
import {
  BusyHint,
  ImportFilePicker,
} from "@/components/imports/import-utils";
import {
  startImportJob,
  useImportJob,
} from "@/lib/import-job-runner";

type ConnectionsPreview = Awaited<ReturnType<typeof previewLinkedInCsv>>;
type ConnectionPerson = ConnectionsPreview["people"][number];

export function LinkedInConnectionsImport() {
  const job = useImportJob();
  const [pending, start] = useTransition();

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [people, setPeople] = useState<ConnectionPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const connectionsJob =
    job?.kind === "connections" && job.status === "running" ? job : null;
  const importProgress = connectionsJob?.progress ?? null;
  const busy = pending || job?.status === "running";

  // Clear local review UI once this job finishes (toast handled globally).
  useEffect(() => {
    if (!job || job.kind !== "connections") return;
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") return;
    setPeople([]);
    setSelected(new Set());
    setCsvText("");
    setFileName(null);
  }, [job]);

  function applyPreview(res: ConnectionsPreview) {
    setPeople(res.people);
    setSelected(
      new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id))
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 pr-2">
          <h2 className="text-lg font-medium text-primary">
            LinkedIn connections
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload your Connections CSV, review everyone, then import into your
            orbit. Imports keep running if you leave this page.
          </p>
        </div>
        <LinkedInExportGuide variant="connections" />
      </div>

      <ImportFilePicker
        accept=".csv,text/csv"
        disabled={busy}
        fileName={fileName}
        onFile={(file) => {
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

      {pending ? <BusyHint>Reading CSV…</BusyHint> : null}

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
          onClick={() => {
            if (busy) return;
            try {
              const ids = [...selected];
              startImportJob({
                kind: "connections",
                csvText,
                fileName: fileName || "linkedin.csv",
                ids,
              });
              // Clear the review list immediately; progress lives in the runner.
              setPeople([]);
              setSelected(new Set());
              setCsvText("");
              setFileName(null);
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
