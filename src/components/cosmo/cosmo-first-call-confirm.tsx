"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Asked once per browser, before the first Cosmo call opens the microphone. */
export function CosmoFirstCallConfirm({ open, onStart, onCancel }: { open: boolean; onStart: () => void; onCancel: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Talk to Cosmo?</DialogTitle>
          <DialogDescription>Cosmo listens through your microphone. Calls use your voice minutes.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Not now</Button>
          <Button onClick={onStart}>Start call</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
