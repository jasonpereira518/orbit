"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  previewLinkedInCsv,
  confirmLinkedInImport,
} from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Preview = Awaited<ReturnType<typeof previewLinkedInCsv>>;

export function ImportForm({ history }: { history: Array<{
  id: string;
  fileName: string | null;
  status: string;
  contactsCreated: number | null;
  contactsUpdated: number | null;
  duplicatesFound: number | null;
  createdAt: Date;
}> }) {
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("linkedin.csv");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-8">
      <div className="rounded-2xl border border-border/70 bg-white p-6 space-y-4">
        <div>
          <p className="text-sm font-medium">Upload LinkedIn connections CSV</p>
          <p className="mt-1 text-sm text-muted-foreground">
            LinkedIn → Settings → Data privacy → Get a copy of your data → Connections.
          </p>
        </div>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setFileName(file.name);
            const text = await file.text();
            setCsvText(text);
            setPreview(null);
          }}
        />
        <div className="flex gap-2">
          <Button
            disabled={!csvText || pending}
            variant="outline"
            onClick={() =>
              start(async () => {
                try {
                  const res = await previewLinkedInCsv(csvText);
                  setPreview(res);
                  toast.success(`Previewing ${res.totalRows} rows`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Preview failed");
                }
              })
            }
          >
            Preview
          </Button>
          <Button
            disabled={!csvText || pending}
            className="bg-[#0f3d3e] hover:bg-[#0c3233]"
            onClick={() =>
              start(async () => {
                try {
                  const res = await confirmLinkedInImport(csvText, fileName);
                  toast.success(
                    `Imported: ${res.contactsCreated} created, ${res.contactsUpdated} updated`
                  );
                  setPreview(null);
                  setCsvText("");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Import failed");
                }
              })
            }
          >
            {pending ? "Importing…" : "Confirm import"}
          </Button>
        </div>

        {preview && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {preview.totalRows} rows · {preview.duplicateCount} likely duplicates in
              preview
            </p>
            <div className="max-h-80 overflow-auto rounded-xl border border-border/60">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Duplicate</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((row, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="px-3 py-2">{row.fullName}</td>
                      <td className="px-3 py-2">{row.company}</td>
                      <td className="px-3 py-2">{row.position}</td>
                      <td className="px-3 py-2">
                        {row.duplicate ? (
                          <Badge variant="secondary">{row.duplicate.reason}</Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium">Import history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between rounded-xl border border-border/60 bg-white px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{h.fileName || "CSV import"}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.contactsCreated ?? 0} created · {h.contactsUpdated ?? 0} updated
                    · {h.duplicatesFound ?? 0} duplicates
                  </p>
                </div>
                <Badge variant="outline">{h.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
