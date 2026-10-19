"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { IntegrationLogo } from "@/components/integrations/integration-logo";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { DRIVE_MIME, triageDriveFile, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { cn } from "@/lib/utils";

/**
 * What a picked file shows itself as — the same words a person used when they saved it.
 */
function kindLabel(mimeType: string): string {
  return mimeType === DRIVE_MIME.slides ? "Slides" : "Doc";
}

/**
 * The card a Drive pick lands in, styled like `ImportQueueCard` (see its outer classes) but
 * standalone: a Drive pick is not a file the queue's detection ever sees, so it gets its own
 * slot on the page rather than entering the file queue.
 */
export function DriveImportCard({
  files,
  onDone,
}: {
  files: PickedDriveFile[];
  onDone: () => void;
}) {
  const job = useImportJob();
  const running = job?.status === "running";

  const triaged = useMemo(
    () => files.map((f) => ({ file: f, ...triageDriveFile(f, new Date()) })),
    [files],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(triaged.filter((t) => t.likely).map((t) => t.file.id)),
  );

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectedFiles = files.filter((f) => selected.has(f.id));
  const n = selectedFiles.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3">
        <IntegrationLogo provider="google-drive" size="md" title="" />
        <div className="min-w-0">
          <CardTitle as="h2">From Google Drive</CardTitle>
          <CardDescription>
            {n} of {files.length} selected
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
      <ul className="space-y-2">
        {triaged.map(({ file, why }) => {
          const checked = selected.has(file.id);
          return (
            <li
              key={file.id}
              className={cn(
                "flex items-start gap-3 rounded-xl border border-border-subtle p-3",
                !checked && "opacity-70",
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(v) => toggle(file.id, v === true)}
                aria-label={`Select ${file.name}`}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {kindLabel(file.mimeType)} — {why}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {running ? (
        <p className="text-xs text-muted-foreground">
          Wait for the import that’s running to finish
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={running || n === 0}
          onClick={() => {
            startImportJob({ kind: "drive_docs", files: selectedFiles });
            onDone();
          }}
        >
          {`Import ${n} file${n === 1 ? "" : "s"}`}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
      </CardContent>
    </Card>
  );
}
