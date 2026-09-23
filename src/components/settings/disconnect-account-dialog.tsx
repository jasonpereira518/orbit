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
import {
  DATA_CATEGORY_META,
  DISCONNECT_DELETE_CATEGORIES,
  MICROSOFT_ACCOUNT_URL,
  type DisconnectProvider,
} from "@/lib/data-categories";

const NAMES: Record<DisconnectProvider, string> = { gmail: "Google", outlook: "Outlook" };

/**
 * One confirmation for every Gmail/Outlook Disconnect button. DB-free imports only.
 *
 * Opens itself from its own outline button, unless a caller passes `open` — the account
 * pages reach Disconnect through the header's ⋯ menu, which is the trigger, so there the
 * button would be a second one nobody asked for.
 *
 * `hasDeletableData` decides between the two halves below: the checkbox that offers to
 * delete what this account produced, or the paragraph saying contacts stay. It defaults to
 * offering the checkbox, because a caller that hasn't looked must not hide a way to delete
 * data that exists.
 */
export function DisconnectAccountDialog({
  provider,
  disabled,
  onConfirm,
  open: openProp,
  onOpenChange,
  hasDeletableData,
}: {
  provider: DisconnectProvider;
  disabled?: boolean;
  onConfirm: (opts: { alsoDelete: boolean }) => void;
  /** Controlled: the caller owns the open state, and no trigger button is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Whether this account has actually produced any of `DISCONNECT_DELETE_CATEGORIES`'
   * data. Only an explicit `false` — a caller that looked and found none — drops the
   * checkbox; `undefined` means "not known", and keeps it.
   */
  hasDeletableData?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  function setOpen(next: boolean) {
    if (controlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  }
  const [alsoDelete, setAlsoDelete] = useState(false);
  const name = NAMES[provider];
  const extra =
    hasDeletableData === false
      ? []
      : DATA_CATEGORY_META.filter((c) =>
          DISCONNECT_DELETE_CATEGORIES[provider].includes(c.id)
        );

  return (
    <>
      {controlled ? null : (
        <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
          Disconnect
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAlsoDelete(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {name}?</DialogTitle>
            <DialogDescription>
              {provider === "gmail" ? (
                <>Orbit deletes its copy of the sign-in and asks Google to revoke its access.</>
              ) : (
                <>
                  Orbit deletes its copy of the sign-in. Microsoft doesn’t let apps revoke their
                  own access, so to remove Orbit completely, open{" "}
                  <a
                    href={MICROSOFT_ACCOUNT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    your Microsoft account
                  </a>{" "}
                  and remove Orbit from the apps with access.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {extra.length > 0 ? (
            <label className="flex cursor-pointer gap-3 rounded-lg p-2 hover:bg-muted/60">
              <Checkbox
                checked={alsoDelete}
                onCheckedChange={(v) => setAlsoDelete(v === true)}
                aria-label="Also delete what Orbit imported from this account"
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium text-ink">
                  Also delete what Orbit imported from this account
                </span>
                {extra.map((c) => (
                  <span key={c.id} className="mt-1 block text-xs leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground/80">{c.label}:</span> {c.description}
                  </span>
                ))}
              </span>
            </label>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              Contacts imported from {name} stay in Orbit. Delete them from Contacts, or remove
              everything in Settings → Data and privacy.
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const choice = { alsoDelete };
                setOpen(false);
                setAlsoDelete(false);
                onConfirm(choice);
              }}
            >
              {alsoDelete ? "Disconnect and delete" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
