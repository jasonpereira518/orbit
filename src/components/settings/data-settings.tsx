"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import {
  deleteAllData,
  exportAllData,
  getDeletionFootprint,
} from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AvatarSyncStatus } from "@/components/settings/avatar-sync-status";
import { cancelImportJob } from "@/lib/import-job-runner";

/** Typed exactly, so the gesture cannot be muscle memory. */
const CONFIRM_PHRASE = "delete my data";

export function DataSettings() {
  const [pending, start] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [footprint, setFootprint] = useState<{
    contacts: number;
    interactions: number;
    reminders: number;
    noteBatches: number;
  } | null>(null);

  function runDelete() {
    start(async () => {
      // Stop any in-flight background processes immediately.
      // Import jobs stop after the current chunk.
      cancelImportJob();
      window.dispatchEvent(new Event("orbit:stop-operations"));
      // Cross-tab best-effort: graph listeners can react via storage events.
      localStorage.setItem("orbit:stop-operations", String(Date.now()));
      await deleteAllData();
      setConfirmOpen(false);
      setTyped("");
      toast.success("All data deleted");
    });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Data and privacy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Export everything as JSON, or permanently delete your Orbit data. Read
          our{" "}
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
        <Button
          variant="outline"
          className="text-destructive"
          disabled={pending}
          onClick={() =>
            start(async () => {
              // Counts are fetched for the dialog: naming what is about to go is the
              // difference between a confirmation and a formality.
              setFootprint(await getDeletionFootprint().catch(() => null));
              setTyped("");
              setConfirmOpen(true);
            })
          }
        >
          Delete all data
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete all your Orbit data?</DialogTitle>
            <DialogDescription>
              This permanently removes everything below. It cannot be undone, and
              Orbit keeps no copy.
            </DialogDescription>
          </DialogHeader>

          {footprint && (
            <ul className="space-y-1 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm text-ink">
              <li>{footprint.contacts.toLocaleString()} contacts</li>
              <li>{footprint.interactions.toLocaleString()} logged interactions</li>
              <li>{footprint.reminders.toLocaleString()} reminders</li>
              <li>{footprint.noteBatches.toLocaleString()} saved note pastes</li>
              <li className="text-muted-foreground">
                plus your chats, goals, imports, events and settings
              </li>
            </ul>
          )}

          <p className="text-sm text-muted-foreground">
            Want a copy first? Close this and choose{" "}
            <span className="font-medium text-ink">Export JSON</span>.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="confirm-delete" className="text-sm text-ink">
              Type <span className="font-medium">{CONFIRM_PHRASE}</span> to confirm
            </label>
            <Input
              id="confirm-delete"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={CONFIRM_PHRASE}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                pending || typed.trim().toLowerCase() !== CONFIRM_PHRASE
              }
              onClick={runDelete}
            >
              {pending ? "Deleting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AvatarSyncStatus />
    </section>
  );
}
