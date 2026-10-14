"use client";

import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { blockSharedAvatarAction, unblockSharedAvatarAction } from "@/actions/admin";

const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs transition-colors duration-fast";

/** Remove & block, or Unblock, one shared LinkedIn photo. Reason + audit via the shared dialog. */
export function SharedAvatarActions({ slug, blocked }: { slug: string; blocked: boolean }) {
  return blocked ? (
    <ConfirmActionDialog
      trigger={<button type="button" className={`${BUTTON} hover:bg-muted`}>Unblock</button>}
      title="Unblock this photo?"
      description="The next lookup for this person resolves a photo again, and an extension capture can contribute one."
      confirmLabel="Unblock"
      onConfirm={(reason) => unblockSharedAvatarAction({ slug, reason })}
    />
  ) : (
    <ConfirmActionDialog
      trigger={
        <button type="button" className={`${BUTTON} border-destructive/40 text-destructive hover:bg-destructive/10`}>
          Remove &amp; block
        </button>
      }
      title="Remove and block this photo?"
      description="Removes the photo everywhere it came from LinkedIn: the shared photo and any copy saved on a contact in any account. It is never fetched or contributed again. Google, Outlook, Gravatar, Apollo and uploaded photos stay, and are re-checked."
      confirmLabel="Remove & block"
      danger
      onConfirm={(reason) => blockSharedAvatarAction({ slug, reason })}
    />
  );
}
