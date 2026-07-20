"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { deleteAllData, exportAllData } from "@/actions/settings";
import { Button } from "@/components/ui/button";

export function DataSettings() {
  const [pending, start] = useTransition();

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Data and privacy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Export everything as JSON, or permanently delete your Orbit data.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const data = await exportAllData();
              const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
              toast.success("Export downloaded");
            })
          }
        >
          Export JSON
        </Button>
        <Button
          variant="outline"
          className="text-destructive"
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete ALL your Orbit data? This cannot be undone."))
              return;
            start(async () => {
              await deleteAllData();
              toast.success("All data deleted");
            });
          }}
        >
          Delete all data
        </Button>
      </div>
    </section>
  );
}
