"use client";

import { useState, useTransition } from "react";
import { ImageDown } from "lucide-react";
import { matchGooglePhotos } from "@/actions/imports";
import { toast } from "@/lib/toast";
import { FeatureRow } from "@/components/settings/account-page";
import { rowControl, type CapabilityStatus } from "@/lib/integration-status";

/**
 * Fills missing contact photos from Google Contacts.
 *
 * Google People photos arrive with the import wizard, but only for the people picked
 * there — anyone added another way keeps the silhouette even when Google has a picture
 * of them. This runs that match over the contacts you already have.
 */
export function GooglePhotoMatch({
  capability,
  busy,
  onAllow,
}: {
  /** The account's Contacts grant — photos come from the same scope. */
  capability: CapabilityStatus | undefined;
  busy: boolean;
  onAllow: () => void;
}) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);

  const control = rowControl("contacts", capability);
  const needsAllow = control.kind === "action" && control.label === "Allow";

  const match = () =>
    start(async () => {
      try {
        const res = await matchGooglePhotos();
        if (!res.connected) {
          toast.error("Connect your Google account first");
          return;
        }
        if (!res.contactsScopeGranted) {
          toast.error("Orbit needs permission to read your Google Contacts");
          return;
        }
        setSummary(
          res.matched === 0
            ? `No new photos — ${res.remaining} contact${res.remaining === 1 ? "" : "s"} still without one.`
            : `Added ${res.matched} photo${res.matched === 1 ? "" : "s"}. ${res.remaining} still without one.`
        );
        if (res.matched > 0) {
          toast.success(`Added ${res.matched} photo${res.matched === 1 ? "" : "s"}`);
        }
      } catch {
        toast.error("Couldn’t reach Google Contacts");
      }
    });

  return (
    <FeatureRow
      icon={<ImageDown className="size-4" />}
      title="Photos from Google Contacts"
      description="Fills in missing contact photos. Matches on email address, so nobody gets someone else’s face."
      control={{ kind: "action", label: pending ? "Matching…" : needsAllow ? "Allow" : "Match photos" }}
      disabled={pending || busy}
      onAction={needsAllow ? onAllow : match}
    >
      {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
    </FeatureRow>
  );
}
