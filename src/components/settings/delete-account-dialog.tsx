"use client";

import { useState } from "react";
import { UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteMyAccount } from "@/actions/account";
import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/account-deletion-shared";
import { UserFacingError } from "@/lib/errors";

/**
 * The irreversible one. Same shape as DeleteDataDialog: an unconditional typed
 * confirmation, because there is no undo and no export step in between.
 *
 * `ConfirmDialog` only enables the action once the typed word matches (trimmed,
 * case-insensitive — the same rule `deleteMyAccount` re-checks), so the constant is what is
 * sent. A refusal is thrown as a `UserFacingError`, which the dialog shows inline.
 */
export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="destructive" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        <UserX className="size-3.5" />
        Delete account…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="destructive"
        title="Delete your account?"
        description="This erases every contact, note, import and setting, including saved API keys and connected accounts, cancels an active Orbit subscription, and removes your sign-in. It can’t be undone — export first if you want a copy."
        typedConfirmation={ACCOUNT_DELETE_CONFIRMATION}
        confirmLabel="Delete my account"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          const res = await deleteMyAccount({ confirmation: ACCOUNT_DELETE_CONFIRMATION });
          if (!res.ok) throw new UserFacingError(res.error);
          // A full navigation, not router.push: the session this page was rendered for no
          // longer exists, and nothing cached for it should survive.
          window.location.assign(res.value.redirectTo);
          // Keep the dialog in its pending state until the page unloads.
          await new Promise(() => {});
        }}
      />
    </>
  );
}
