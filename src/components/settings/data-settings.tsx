"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Download, Trash2, UserX } from "lucide-react";
import { toast } from "@/lib/toast";
import { exportAllData } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { AvatarSyncStatus } from "@/components/settings/avatar-sync-status";
import { GooglePhotoMatch } from "@/components/settings/google-photo-match";
import { DeleteDataDialog } from "@/components/settings/delete-data-dialog";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";

export function DataSettings() {
  const [exporting, startExport] = useTransition();

  return (
    <SettingsSection
      title="Data and privacy"
      description={
        <>
          Take a copy of everything, or remove some or all of it for good. Read
          our{" "}
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
        title="Delete data"
        description="Choose what to remove — some or all of it. Your account stays; anything you keep is untouched."
      >
        <DeleteDataDialog
          trigger={
            <Button
              variant="outline"
              size="sm"
              className="w-fit text-destructive hover:border-destructive/40 hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
              Delete data…
            </Button>
          }
        />
      </SettingsRow>

      <SettingsRow
        title="Delete account"
        description="Erase everything and remove your sign-in. Cancels an active Orbit Pro subscription."
      >
        <DeleteAccountDialog
          trigger={
            <Button
              variant="outline"
              size="sm"
              className="w-fit text-destructive hover:border-destructive/40 hover:bg-destructive/10"
            >
              <UserX className="size-3.5" />
              Delete account…
            </Button>
          }
        />
      </SettingsRow>
    </SettingsSection>
  );
}
