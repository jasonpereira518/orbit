"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const NAMES = { luma: "Luma", eventbrite: "Eventbrite" } as const;

/**
 * The Luma/Eventbrite disconnect confirmation, in the shape of the Gmail/Outlook one
 * (`settings/disconnect-account-dialog.tsx`): what disconnecting does, what it cannot do,
 * and an opt-in to delete what the sync brought in — the hosted events and their guest
 * lists, which are names, emails and phone numbers of people who never used Orbit.
 */
export function DisconnectEventProviderDialog({
  provider,
  open,
  onOpenChange,
  onConfirm,
}: {
  provider: keyof typeof NAMES | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: { alsoDelete: boolean }) => void;
}) {
  const [alsoDelete, setAlsoDelete] = useState(false);
  if (!provider) return null;
  const name = NAMES[provider];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setAlsoDelete(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {name}?</DialogTitle>
          <DialogDescription>
            Orbit deletes its copy of the {provider === "luma" ? "API key" : "sign-in"} and stops
            syncing. {name} has no way for an app to revoke its own access, so to remove Orbit
            completely, also {provider === "luma" ? "delete the key in Luma’s settings" : "remove Orbit from your Eventbrite account’s connected apps"}.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer gap-3 rounded-lg p-2 hover:bg-muted/60">
          <Checkbox
            checked={alsoDelete}
            onCheckedChange={(v) => setAlsoDelete(v === true)}
            aria-label={`Also delete the events and guest lists synced from ${name}`}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="text-sm font-medium text-ink">
              Also delete the events and guest lists synced from {name}
            </span>
            <span className="mt-1 block text-xs leading-snug text-muted-foreground">
              Events you added yourself stay, and so do contacts you made from a guest list.
            </span>
          </span>
        </label>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              const choice = { alsoDelete };
              onOpenChange(false);
              setAlsoDelete(false);
              onConfirm(choice);
            }}
          >
            {alsoDelete ? "Disconnect and delete" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
