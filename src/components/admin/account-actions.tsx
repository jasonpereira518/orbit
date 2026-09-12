"use client";

import { Ban, Flame, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  deleteAccountAction,
  hardDeleteAccountAction,
  resetOnboardingAction,
  setAccountSuspendedAction,
} from "@/actions/admin";

/**
 * The danger zone.
 *
 * Set apart at the bottom of the inspector, and visually distinct, because these are the
 * only controls in the console whose consequences reach the user rather than the operator.
 * Each dialog names the actual consequence rather than the mechanism — "they can still sign
 * in but land in onboarding with an empty workspace" tells you what you are about to do in
 * a way that "purges user data" does not.
 */

const ACTION_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs transition-colors duration-fast";

export function AccountDangerZone({
  targetUserId,
  email,
  suspendedAt,
  suspendedReason,
  contactCount,
}: {
  targetUserId: string;
  email: string | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  contactCount: number;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-destructive/30 p-4">
      <div>
        <h3 className="text-sm font-medium text-destructive">Danger zone</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          These reach the user. Everything else in this console only reaches you.
        </p>
      </div>

      {suspendedAt && (
        <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          Suspended{" "}
          <span className="tabular-nums">
            {suspendedAt.toISOString().slice(0, 10)}
          </span>
          {suspendedReason ? ` — ${suspendedReason}` : ""}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <ConfirmActionDialog
          trigger={
            <button
              type="button"
              className={`${ACTION_BUTTON} text-muted-foreground hover:text-foreground`}
            >
              <RotateCcw className="size-3" aria-hidden />
              Reset onboarding
            </button>
          }
          title="Reset onboarding and the wizard?"
          // Said out loud because otherwise the operator runs it, sees nothing change, and
          // runs it again: needsOnboarding() treats any contact or import as onboarded
          // regardless of the timestamp, and backfills the column afterwards.
          description="Clears the onboarding and wizard timestamps so setup runs again. Note this is a no-op on an account that already has contacts or imports — Orbit treats those as onboarded whatever the column says, and re-backfills it. Useful only for accounts that stalled early."
          confirmLabel="Reset onboarding"
          onConfirm={(reason) =>
            resetOnboardingAction({ targetUserId, scope: "both", reason })
          }
        />

        {suspendedAt ? (
          <ConfirmActionDialog
            trigger={
              <button
                type="button"
                className={`${ACTION_BUTTON} text-muted-foreground hover:text-foreground`}
              >
                <Undo2 className="size-3" aria-hidden />
                Restore access
              </button>
            }
            title="Restore this account?"
            description="They can sign in again immediately, and their calendar feed starts serving. Nothing was deleted while they were suspended."
            confirmLabel="Restore access"
            onConfirm={(reason) =>
              setAccountSuspendedAction({
                targetUserId,
                suspended: false,
                reason,
              })
            }
          />
        ) : (
          <ConfirmActionDialog
            trigger={
              <button
                type="button"
                className={`${ACTION_BUTTON} text-destructive hover:bg-destructive/5`}
              >
                <Ban className="size-3" aria-hidden />
                Suspend
              </button>
            }
            title="Suspend this account?"
            description="They are signed out of the app on their next request and see a notice explaining the hold. Their calendar feed goes quiet. Nothing is deleted, and restoring is one click."
            confirmLabel="Suspend account"
            danger
            onConfirm={(reason) =>
              setAccountSuspendedAction({
                targetUserId,
                suspended: true,
                reason,
              })
            }
          />
        )}

        <ConfirmActionDialog
          trigger={
            <button
              type="button"
              className={`${ACTION_BUTTON} text-destructive hover:bg-destructive/5`}
            >
              <Trash2 className="size-3" aria-hidden />
              Delete data
            </button>
          }
          title="Delete every trace of this account's data?"
          description={`Permanently removes ${contactCount} contacts and everything attached to them — interactions, reminders, chats, imports, embeddings, outreach. This cannot be undone. It does NOT delete their Clerk login: they can still sign in, and will land in onboarding with an empty workspace. Delete them in Clerk separately if that is what you meant.`}
          confirmLabel="Delete all data"
          danger
          minReason={8}
          typedConfirmation={email ?? undefined}
          typedConfirmationHint={`Type ${email ?? "the account email"} to confirm`}
          onConfirm={(reason) =>
            deleteAccountAction({
              targetUserId,
              confirmEmail: email ?? "",
              reason,
            })
          }
        />

        <ConfirmActionDialog
          trigger={
            <button
              type="button"
              className={`${ACTION_BUTTON} border-destructive/50 text-destructive hover:bg-destructive/10`}
            >
              <Flame className="size-3" aria-hidden />
              Hard delete everything
            </button>
          }
          title="Permanently delete this account, not just its data?"
          description={`This is different from "Delete data" above: it also removes their Clerk login (they can never sign in again), and it does NOT preserve their API keys, billing/subscription link, or suspension history — those all survive "Delete data" but not this. There is no undo, and no dashboard to restore from.`}
          confirmLabel="Hard delete account"
          danger
          minReason={20}
          typedConfirmation={email ?? undefined}
          typedConfirmationHint={`Type ${email ?? "the account email"} to confirm`}
          redirectTo="/admin/users"
          onConfirm={(reason) =>
            hardDeleteAccountAction({
              targetUserId,
              confirmEmail: email ?? "",
              reason,
            })
          }
        />
      </div>
    </div>
  );
}
