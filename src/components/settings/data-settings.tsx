"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { toast } from "@/lib/toast";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { AvatarSyncStatus } from "@/components/settings/avatar-sync-status";
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
              try {
                const res = await fetch("/api/export", { cache: "no-store" });
                if (res.status === 429) {
                  // The limiter's own sentence ("…Try again in 60 minutes."); the route is the only author.
                  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
                  if (typeof body?.error === "string") throw new UserFacingError(body.error);
                }
                if (!res.ok) throw new Error(`export responded ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Export downloaded");
              } catch (err) {
                toast.error(friendlyError(err, "Couldn’t build your export — try again?"));
              }
            })
          }
        >
          <Download className="size-3.5" />
          {exporting ? "Exporting…" : "Export JSON"}
        </Button>
      </SettingsRow>

      <AvatarSyncStatus />

      <SettingsRow
        title="Delete data"
        description="Choose what to remove — some or all of it. Your account stays; anything you keep is untouched."
      >
        <DeleteDataDialog />
      </SettingsRow>

      <SettingsRow
        title="Delete account"
        description="Erase everything and remove your sign-in. Cancels an active Orbit subscription."
      >
        <DeleteAccountDialog />
      </SettingsRow>
    </SettingsSection>
  );
}
