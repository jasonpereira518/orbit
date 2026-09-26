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
import type { CrmStatus } from "@/lib/crm/types";
import { friendlyError } from "@/lib/errors";
import { readOAuthReturn } from "@/lib/oauth-return";
import { toast } from "@/lib/toast";
import { CrmCardView } from "./crm-card-view";

const CRM_RETURN = {
  param: "crm",
  provider: "HubSpot",
  connectedText: "HubSpot connected — your first sync starts within a few minutes",
  reasons: {
    not_entitled: "HubSpot sync is on Orbit Pro and Lifetime — upgrade, then connect again",
  },
};

/** The CRM card: connect, sync now, disconnect, and what came back from HubSpot's sign-in. */
export function CrmCard({ status }: { status: CrmStatus }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [pending, setPending] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);

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

  function connect() {
    setPending("connect");
    start(async () => {
      try {
        const result = await startCrmConnectAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          setPending(null);
          return;
        }
        // A full navigation, not a router push: HubSpot's consent screen is another origin.
        window.location.assign(result.value.url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t open HubSpot — try again?"));
        setPending(null);
      }
    });
  }

  function sync() {
    setPending("sync");
    start(async () => {
      try {
        const result = await syncCrmNowAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const r = result.value;
        if (r.outcome === "stopped" || r.outcome === "needs_reauth") toast.error(r.message ?? "HubSpot sync stopped — see the card for why");
        else if (r.outcome === "partial") toast.message("Synced part of HubSpot — the rest follows automatically");
        else toast.success(r.records === 0 ? "HubSpot is up to date" : `Synced ${r.records.toLocaleString()} from HubSpot`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t sync HubSpot — try again?"));
      } finally {
        setPending(null);
      }
    });
  }

  function disconnect() {
    setConfirming(false);
    setPending("disconnect");
    start(async () => {
      try {
        const result = await disconnectCrmAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("HubSpot disconnected");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t disconnect HubSpot — try again?"));
      } finally {
        setPending(null);
      }
    });
  }

  return (
    <>
      <CrmCardView status={status} pending={pending} onConnect={connect} onSync={sync} onDisconnect={() => setConfirming(true)} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect HubSpot?</DialogTitle>
            <DialogDescription>
              Orbit stops syncing, asks HubSpot to revoke its access, and forgets which contacts came
              from it. The work contacts it added stay in your network, and your leads stay in the
              pipeline.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
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
