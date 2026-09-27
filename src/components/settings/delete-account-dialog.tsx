"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteMyAccount } from "@/actions/account";
import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/account-deletion-shared";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * The irreversible one. Same shape as DeleteDataDialog: an unconditional typed
 * confirmation, because there is no undo and no export step in between.
 */
export function DeleteAccountDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const confirmed = typed.trim().toLowerCase() === ACCOUNT_DELETE_CONFIRMATION;

  const submit = () => {
    if (!confirmed || pending) return;
    start(async () => {
      try {
        const res = await deleteMyAccount({ confirmation: typed });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        // A full navigation, not router.push: the session this page was rendered for no
        // longer exists, and nothing cached for it should survive.
        window.location.assign(res.value.redirectTo);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t delete your account — try again?"));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete your account</DialogTitle>
          <DialogDescription>
            This erases every contact, note, import and setting, including saved API keys and
            connected accounts, cancels an active Orbit Pro subscription, and removes your
            sign-in. It can’t be undone — export first if you want a copy.
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">Type {ACCOUNT_DELETE_CONFIRMATION} to confirm</span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={ACCOUNT_DELETE_CONFIRMATION}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={!confirmed || pending}>
            {pending ? "Deleting…" : "Delete my account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
