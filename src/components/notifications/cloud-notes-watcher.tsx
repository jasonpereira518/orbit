"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { extractCloudNotes, markCloudNotesNotified } from "@/actions/cloud-notes";
import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import { toast } from "@/lib/toast";

const REVIEW_URL = "/capture?mode=cloud&review=1";

/**
 * Toasts once when the cloud-notes scan finds meeting notes (Extract for one, Review for
 * several), or extracted some on its own. The server stamps each doc as told, so another tab
 * or device never toasts it again; the bell keeps the row until the docs are dealt with.
 */
export function CloudNotesWatcher() {
  const { pulse } = useAppPulse();
  const router = useRouter();
  const seen = useRef(new Set<string>());
  const news = pulse?.panel.cloudNotes;

  useEffect(() => {
    if (!news) return;
    const found = news.newFound.filter((f) => !seen.current.has(f.id));
    const extracted = news.newExtracted.filter((f) => !seen.current.has(f.id));
    if (found.length === 0 && extracted.length === 0) return;
    for (const f of [...found, ...extracted]) seen.current.add(f.id);

    if (found.length === 1) {
      const [doc] = found;
      toast.message(`“${doc.name}” looks like meeting notes`, {
        description: "Extract the people and follow-ups from it?",
        duration: 15_000,
        keep: false,
        action: {
          label: "Extract",
          onClick: async () => {
            const res = await extractCloudNotes({
              provider: doc.provider,
              files: [{ id: doc.fileId, name: doc.name }],
              batchGroupId: crypto.randomUUID(),
            });
            if (!res.ok) {
              toast.error(res.error, { keep: false });
              return;
            }
            router.push("/capture");
          },
        },
      });
    } else if (found.length > 1) {
      toast.message(`${found.length} docs look like meeting notes`, {
        description: "Review them and extract the ones you want",
        duration: 15_000,
        keep: false,
        action: { label: "Review", onClick: () => router.push(REVIEW_URL) },
      });
    }
    if (extracted.length > 0) {
      toast.success(
        extracted.length === 1
          ? `Extracting “${extracted[0].name}” from your drive`
          : `Extracting ${extracted.length} meeting notes from your drive`,
        {
          description: "You’ll review who’s in them on Capture",
          duration: 15_000,
          keep: false,
          action: { label: "Open", onClick: () => router.push("/capture") },
        },
      );
    }
    void markCloudNotesNotified([...found, ...extracted].map((f) => f.id))
      .then(() => refreshPulse(true))
      .catch(() => {});
  }, [news, router]);

  return null;
}
