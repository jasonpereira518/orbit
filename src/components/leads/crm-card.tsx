"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disconnectCrmAction, startCrmConnectAction, syncCrmNowAction } from "@/actions/crm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { crmProviderLabel, type CrmConnectorId, type CrmStatus } from "@/lib/crm/types";
import { friendlyError } from "@/lib/errors";
import { readOAuthReturn } from "@/lib/oauth-return";
import { toast } from "@/lib/toast";
import { CrmCardView, type CrmPending } from "./crm-card-view";

const CRM_RETURN = {
  param: "crm",
  provider: "your CRM",
  connectedText: "CRM connected — your first sync starts within a few minutes",
  reasons: {
    not_entitled: "CRM sync is on Orbit Pro and Lifetime — upgrade, then connect again",
  },
};

/** The CRM card: connect, sync now, disconnect, and what came back from a CRM's sign-in. */
export function CrmCard({ status }: { status: CrmStatus }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [pending, setPending] = useState<CrmPending>(null);
  const [confirming, setConfirming] = useState<CrmConnectorId | null>(null);
  // The dialog's words outlive `confirming`: Base UI unmounts only after the exit animation, and
  // a cleared id would read "Disconnect ?" while it fades. Set on open, never cleared.
  const [shownId, setShownId] = useState<CrmConnectorId | null>(null);
  function askDisconnect(id: CrmConnectorId) {
    setShownId(id);
    setConfirming(id);
  }

  // The callback's outcome, toasted once. The params are stripped on the first gesture, never
  // in this effect — see `readOAuthReturn`: a replaceState here would drop a sibling's action.
  const toasted = useRef(false);
  useEffect(() => {
    const result = readOAuthReturn(window.location.search, CRM_RETURN);
    if (!result) return;
    if (!toasted.current) {
      toasted.current = true;
      if (result.tone === "success") toast.success(result.text);
      else if (result.tone === "message") toast.message(result.text);
      else toast.error(result.text);
    }
    const strip = () =>
      window.history.replaceState(null, "", `${window.location.pathname}${result.nextSearch}${window.location.hash}`);
    window.addEventListener("pointerdown", strip, { once: true, capture: true });
    window.addEventListener("keydown", strip, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", strip, true);
      window.removeEventListener("keydown", strip, true);
    };
  }, []);

  function connect(id: CrmConnectorId, opts?: { sandbox?: boolean }) {
    setPending({ action: "connect", id });
    start(async () => {
      try {
        const result = await startCrmConnectAction(id, { sandbox: opts?.sandbox === true });
        if (!result.ok) {
          toast.error(result.error);
          setPending(null);
          return;
        }
        // A full navigation, not a router push: the CRM's consent screen is another origin.
        window.location.assign(result.value.url);
      } catch (err) {
        toast.error(friendlyError(err, `Couldn’t open ${crmProviderLabel(id)} — try again?`));
        setPending(null);
      }
    });
  }

  function sync(id: CrmConnectorId) {
    setPending({ action: "sync", id });
    start(async () => {
      try {
        const result = await syncCrmNowAction(id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const r = result.value;
        const label = crmProviderLabel(id);
        // Fixed words: the server already swapped a token endpoint's text for this sentence,
        // and the card must never be the place provider text leaks back in (Ruling 12a).
        if (r.outcome === "needs_reauth") toast.error(`${label} needs you to reconnect — use Reconnect, then sync`);
        else if (r.outcome === "stopped") toast.error(r.message ?? `${label} sync stopped — see the card for why`);
        else if (r.outcome === "partial") toast.message(`Synced part of ${label} — the rest follows automatically`);
        else toast.success(r.records === 0 ? `${label} is up to date` : `Synced ${r.records.toLocaleString()} from ${label}`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, `Couldn’t sync ${crmProviderLabel(id)} — try again?`));
      } finally {
        setPending(null);
      }
    });
  }

  function disconnect() {
    const id = confirming;
    if (!id) return;
    setConfirming(null);
    setPending({ action: "disconnect", id });
    start(async () => {
      try {
        const result = await disconnectCrmAction(id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${crmProviderLabel(id)} disconnected`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, `Couldn’t disconnect ${crmProviderLabel(id)} — try again?`));
      } finally {
        setPending(null);
      }
    });
  }

  const confirmingLabel = shownId ? crmProviderLabel(shownId) : "";

  return (
    <>
      <CrmCardView status={status} pending={pending} onConnect={connect} onSync={sync} onDisconnect={askDisconnect} />
      <Dialog open={confirming !== null} onOpenChange={(open) => setConfirming(open ? confirming : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {confirmingLabel}?</DialogTitle>
            <DialogDescription>
              Orbit stops syncing, asks {confirmingLabel} to revoke its access, and forgets which
              contacts came from it. The work contacts it added stay in your network, and your
              leads stay in the pipeline.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
