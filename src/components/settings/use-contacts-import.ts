"use client";

/**
 * Owns the contacts-preview review flow shared by the Google and Microsoft contacts cards:
 * loading a preview of the provider's contacts, letting the person pick which ones to keep,
 * and handing the selection to the shared import-job runner (`src/lib/import-job-runner.ts`).
 * Both cards already compose `useGoogleConnection` / `useMicrosoftConnection`
 * (`use-provider-connection.ts`) for the account chrome around this — Connect, Disconnect,
 * the OAuth return — and this hook sits beside it, not instead of it.
 *
 * ## `jobRunning` is scoped, the cards' `busy` isn't (yet)
 *
 * `jobRunning` reflects only THIS provider's own import job (`google_contacts` /
 * `outlook_contacts`). Both cards' current `busy` expression is
 * `connection.busy || pending || job?.status === "running"` — *any* job, so a running
 * LinkedIn import (or the other provider's contacts import) disables this card's buttons
 * too. That is unchanged here: the cards keep reading the shared `useImportJob()` snapshot
 * themselves for that check, exactly as before. A later task switches the cards' rows to the
 * scoped `jobRunning` this hook exposes.
 *
 * ## Google vs. Microsoft: `contactsScopeGranted`
 *
 * Both preview actions return `contactsScopeGranted`, and this hook tracks it for both
 * providers. Only the Google card has ever acted on it: when a Google preview reports the
 * scope missing, `load()` stops before touching `people`/`selected`/`loaded` and shows a
 * toast asking to reconnect — the account can lose the contacts scope out from under an
 * already-connected session between visits. The Outlook card has never had that branch: its
 * gating lives entirely in the connection status's `hasContactsScope`, and
 * `previewOutlookContacts`'s own `contactsScopeGranted` has always been read into
 * `people`/`loaded` unconditionally, even when false (which only happens alongside an empty
 * `people` array). This hook preserves that asymmetry rather than harmonising it — the
 * Outlook card simply never reads `contactsScopeGranted` off this hook, same as it never read
 * it off `previewOutlookContacts()`'s result before.
 *
 * ## `reset`
 *
 * Not one of the things Step 1 lists as moving, because it wasn't part of the preview/start
 * flow — it's what each card's `DisconnectAccountDialog.onConfirm` ran in `connection
 * .disconnect(opts).then(...)` to clear stale review state after a successful disconnect.
 * That cleanup has to move here too, now that `people`/`loaded` live in this hook instead of
 * the card. It deliberately does not touch `selected`, matching what the cards did before —
 * `selected` only mattered while `people` was non-empty, and disconnect already empties
 * `people`, so the next `load()` overwrites `selected` from scratch before it could matter.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { previewGoogleContacts, previewOutlookContacts } from "@/actions/imports";
import type { ReviewPerson } from "@/components/imports/import-people-review";
import type { ImportProgressState } from "@/components/imports/import-utils";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type ContactsProvider = "google" | "microsoft";

export type ContactsImportState = {
  people: ReviewPerson[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  remove: (id: string) => void;
  loaded: boolean;
  /** Preview in flight. */
  loading: boolean;
  contactsScopeGranted: boolean;
  progress: ImportProgressState | null;
  /** This provider's own job, not any job — see the doc comment above. */
  jobRunning: boolean;
  /** Runs the preview. */
  load: () => void;
  /** Starts the import job for the current selection. */
  start: () => void;
  /** Clears `people`/`loaded` (not `selected`) — see the doc comment above. Used after a
   *  successful disconnect. */
  reset: () => void;
};

/** Same mapping both cards apply today: name is the full name, subtitle is title · company. */
function toReviewPerson(p: {
  id: string;
  fullName: string;
  title: string;
  company: string;
  isRepeat: boolean;
  duplicate: { reason: string } | null;
}): ReviewPerson {
  return {
    id: p.id,
    name: p.fullName,
    subtitle: [p.title, p.company].filter(Boolean).join(" · "),
    isRepeat: p.isRepeat,
    repeatReason: p.duplicate?.reason,
  };
}

export function useContactsImport(provider: ContactsProvider): ContactsImportState {
  const job = useImportJob();
  const [pending, startTransition] = useTransition();
  const [contactsScopeGranted, setContactsScopeGranted] = useState(true);
  const [people, setPeople] = useState<ReviewPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const jobKind = provider === "google" ? "google_contacts" : "outlook_contacts";
  const thisJob = job?.kind === jobKind && job.status === "running" ? job : null;

  // Clear local review UI once this job finishes (toast handled globally by
  // ImportJobWatcher, same as the LinkedIn connections import). The setState calls are
  // deferred a microtask so this reads as reacting to the external job-runner singleton
  // (react-hooks/set-state-in-effect's own carve-out: "calling setState in a callback
  // function when external state changes") rather than an unconditional synchronous
  // setState in the effect body.
  useEffect(() => {
    if (!job || job.kind !== jobKind) return;
    if (
      job.status !== "completed" &&
      job.status !== "failed" &&
      job.status !== "cancelled"
    )
      return;
    queueMicrotask(() => {
      setPeople([]);
      setSelected(new Set());
      setLoaded(false);
    });
  }, [job, jobKind]);

  const load = useCallback(() => {
    startTransition(async () => {
      try {
        if (provider === "google") {
          const res = await previewGoogleContacts();
          setContactsScopeGranted(res.contactsScopeGranted);
          if (!res.contactsScopeGranted) {
            toast.error("Reconnect Google to allow access to your contacts");
            return;
          }
          setPeople(res.people.map(toReviewPerson));
          setSelected(
            new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id))
          );
          setLoaded(true);
          toast.success(`Loaded ${res.people.length} contacts`);
        } else {
          const res = await previewOutlookContacts();
          setContactsScopeGranted(res.contactsScopeGranted);
          setPeople(res.people.map(toReviewPerson));
          setSelected(
            new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id))
          );
          setLoaded(true);
          toast.success(`Loaded ${res.people.length} contacts`);
        }
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.loadContactsFailed));
      }
    });
  }, [provider]);

  const reset = useCallback(() => {
    setPeople([]);
    setLoaded(false);
  }, []);

  const remove = useCallback((id: string) => {
    setPeople((prev) => prev.filter((p) => p.id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const start = useCallback(() => {
    try {
      const ids = [...selected];
      if (provider === "google") {
        startImportJob({ kind: "google_contacts", ids });
      } else {
        startImportJob({ kind: "outlook_contacts", ids });
      }
      // Clear the review list immediately; progress lives in the runner.
      setPeople([]);
      setSelected(new Set());
      setLoaded(false);
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.importFailed));
    }
  }, [provider, selected]);

  return {
    people,
    selected,
    setSelected,
    remove,
    loaded,
    loading: pending,
    contactsScopeGranted,
    progress: thisJob?.progress ?? null,
    jobRunning: thisJob != null,
    load,
    start,
    reset,
  };
}
