"use client";

import { useState, useTransition } from "react";
import { ImageDown } from "lucide-react";
import { matchGooglePhotos } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

/**
 * Fills missing contact photos from Google Contacts.
 *
 * Google People photos arrive with the import wizard, but only for the people picked
 * there — anyone added another way keeps the silhouette even when Google has a picture
 * of them. This runs that match over the contacts you already have.
 */
export function GooglePhotoMatch() {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);

  return (
    <div className="border-t border-border/60 pt-4">
      <h3 className="text-sm font-medium text-ink">Photos from Google Contacts</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Matches on email address, so nobody gets someone else&apos;s face.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const res = await matchGooglePhotos();
                if (!res.connected) {
                  toast.error("Connect your Google account first");
                  return;
                }
                if (!res.contactsScopeGranted) {
                  toast.error(
                    "Orbit needs permission to read your Google Contacts"
                  );
                  return;
                }
                setSummary(
                  res.matched === 0
                    ? `No new photos — ${res.remaining} contact${res.remaining === 1 ? "" : "s"} still without one.`
                    : `Added ${res.matched} photo${res.matched === 1 ? "" : "s"}. ${res.remaining} still without one.`
                );
                if (res.matched > 0) {
                  toast.success(
                    `Added ${res.matched} photo${res.matched === 1 ? "" : "s"}`
                  );
                }
              } catch {
                toast.error("Couldn’t reach Google Contacts");
              }
            })
          }
        >
          <ImageDown className="size-4" />
          {pending ? "Matching…" : "Match Google photos"}
        </Button>
        {summary && (
          <p className="text-sm text-muted-foreground">{summary}</p>
        )}
      </div>
    </div>
  );
}
