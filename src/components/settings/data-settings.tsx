"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Download, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { deleteAllData, exportAllData } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AvatarSyncStatus } from "@/components/settings/avatar-sync-status";
import { GooglePhotoMatch } from "@/components/settings/google-photo-match";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { cancelImportJob } from "@/lib/import-job-runner";
import { friendlyError } from "@/lib/errors";

export function DataSettings() {
  const [exporting, startExport] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function deleteEverything() {
    startDelete(async () => {
      // Stop any in-flight background processes immediately.
      // Import jobs stop after the current chunk.
      cancelImportJob();
      window.dispatchEvent(new Event("orbit:stop-operations"));
      // Cross-tab best-effort: graph listeners can react via storage events.
      localStorage.setItem("orbit:stop-operations", String(Date.now()));
      try {
        await deleteAllData();
        setConfirmOpen(false);
        toast.success("All your data is deleted");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t delete your data — try again?"));
      }
    });
  }

  return (
    <SettingsSection
      title="Data and privacy"
      description={
        <>
          Take a copy of everything, or remove it for good. Read our{" "}
          <Link
            href="/privacy"
            className="text-primary underline-offset-4 hover:underline"
          >
            Privacy Policy
          </Link>
          .
        </>
      }
    >
      <SettingsRow
        title="Export"
        description="Every contact, note, interaction and setting, as one JSON file."
      >
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={exporting}
          onClick={() =>
            startExport(async () => {
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
          <Download className="size-3.5" />
          {exporting ? "Exporting…" : "Export JSON"}
        </Button>
      </SettingsRow>

      <GooglePhotoMatch />
      <AvatarSyncStatus />

      <SettingsRow
        title="Delete all data"
        description="Permanently removes every contact, note and import from Orbit. Your account stays, empty."
      >
        <Button
          variant="outline"
          size="sm"
          className="w-fit text-destructive hover:border-destructive/40 hover:bg-destructive/10"
          disabled={deleting}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="size-3.5" />
          Delete all data
        </Button>
      </SettingsRow>

      {/* The same confirm the contact page uses for a single delete — this is that, for
          everything, so it must not be the browser's own `confirm()` box. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!deleting) setConfirmOpen(open);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete all your Orbit data?</DialogTitle>
            <DialogDescription>
              Every contact, note, interaction and import is removed, and anything
              running in the background stops. This cannot be undone — export a copy
              first if you might want it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={deleteEverything}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              {deleting ? "Deleting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
