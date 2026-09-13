"use client";

import { useTransition } from "react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import { exportAllData } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { AvatarSyncStatus } from "@/components/settings/avatar-sync-status";
import { DeleteDataDialog } from "@/components/settings/delete-data-dialog";

export function DataSettings() {
  const [pending, start] = useTransition();

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Data and privacy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Export everything as JSON, or permanently delete some or all of your
          Orbit data. Read our{" "}
          <Link
            href="/privacy"
            className="text-primary underline-offset-4 hover:underline"
          >
            Privacy Policy
          </Link>
          .
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
        <DeleteDataDialog
          trigger={
            <Button variant="outline" className="text-destructive">
              Delete data…
            </Button>
          }
        />
      </div>
      <AvatarSyncStatus />
    </section>
  );
}
