"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  getGmailConnectionStatus,
  startGmailOAuth,
  disconnectGmail,
  type GmailConnectionStatus,
} from "@/actions/gmail";
import { previewGoogleContacts, type GoogleContactPerson } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { toast } from "@/lib/toast";
import { IntegrationUnavailable } from "@/components/imports/integration-unavailable";

export function GoogleContactsImport({
  returnTo = "/imports",
  compact = false,
  autoPreview = false,
  onImportStarted,
  onUnavailable,
  onSelectionChange,
}: {
  returnTo?: string;
  /** No outer card chrome / h2 — the caller supplies its own. */
  compact?: boolean;
  /** Call `previewGoogleContacts()` unprompted after `?google=connected` and when already
   *  connected with the contacts scope. */
  autoPreview?: boolean;
  onImportStarted?: (count: number) => void;
  /** Fired once when `!status.configured`. */
  onUnavailable?: () => void;
  /** Fired whenever the selected set or the loaded people list changes — including the
   *  reset to `(0, 0)` when the review list clears (import started, job finished,
   *  disconnected). */
  onSelectionChange?: (selected: number, total: number) => void;
}) {
  const router = useRouter();
  const job = useImportJob();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  // Seeded from the server-reported connection status; `previewGoogleContacts` can later
  // override it (e.g. Google silently dropped the scope since the last status fetch).
  const [contactsScopeOverride, setContactsScopeOverride] = useState<boolean | null>(null);
  const [people, setPeople] = useState<GoogleContactPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [oauthErrorReason, setOauthErrorReason] = useState<string | null>(null);
  // `onUnavailable` fires once per mount, not once per render of the unavailable branch.
  const unavailableFiredRef = useRef(false);
  // Guards the auto-preview call so it fires once per "just became eligible" transition,
  // not on every render while eligible.
  const autoPreviewFiredRef = useRef(false);

  const googleJob =
    job?.kind === "google_contacts" && job.status === "running" ? job : null;
  const importProgress = googleJob?.progress ?? null;
  const busy = pending || job?.status === "running";
  // Null-safe so it can be used as an effect dependency before the `!status`/
  // `!status.configured` gates below run.
  const contactsScopeGranted = status
    ? (contactsScopeOverride ?? status.canImportContacts)
    : false;

  const loadContacts = useCallback(async () => {
    try {
      const res = await previewGoogleContacts();
      setContactsScopeOverride(res.contactsScopeGranted);
      if (!res.contactsScopeGranted) {
        toast.error("Reconnect Google to grant contacts access");
        return;
      }
      setPeople(res.people);
      setSelected(new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id)));
      setLoaded(true);
      if (res.people.length > 0) {
        toast.success(`Loaded ${res.people.length} contacts`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load contacts");
    }
  }, []);

  const connectGoogle = useCallback(() => {
    start(async () => {
      try {
        const { url } = await startGmailOAuth({ returnTo, scopes: "contacts" });
        window.location.href = url;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "OAuth failed");
      }
    });
  }, [returnTo, start]);

  // Clear local review UI once this job finishes (toast handled globally by
  // ImportJobWatcher, same as the LinkedIn connections import). The setState calls are
  // deferred a microtask so this reads as reacting to the external job-runner singleton
  // (react-hooks/set-state-in-effect's own carve-out: "calling setState in a callback
  // function when external state changes") rather than an unconditional synchronous
  // setState in the effect body.
  useEffect(() => {
    if (!job || job.kind !== "google_contacts") return;
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
  }, [job]);

  useEffect(() => {
    getGmailConnectionStatus().then(setStatus).catch(() => {});
  }, []);

  // Notifies the caller of the current selected/total counts on every change — including
  // the initial (0, 0) on mount and the reset to (0, 0) whenever the review list clears.
  // No local state of our own here: `onSelectionChange` is a plain derived-value callback,
  // not a reaction to an external singleton, so it needs none of the microtask deferral the
  // job-runner effects above use. Reports 0 whenever the list is empty rather than trusting
  // `selected.size` directly — a reset path that clears `people` but (by omission) not
  // `selected` must not leak a stale selected count to the caller; Disconnect used to be
  // exactly that gap.
  useEffect(() => {
    onSelectionChange?.(people.length === 0 ? 0 : selected.size, people.length);
  }, [selected, people, onSelectionChange]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google === "connected") {
      toast.success("Google connected");
      // Deferred a microtask, same as the job-finish effect above — this is a
      // synchronous mount-time URL parse, not a reaction to a state change, so it
      // needs the same nudge out of the effect body to satisfy
      // react-hooks/set-state-in-effect.
      queueMicrotask(() => setOauthErrorReason(null));
      params.delete("google");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${next ? `?${next}` : ""}`
      );
      router.refresh();
      getGmailConnectionStatus()
        .then((s) => {
          // Let the fresh status (not a stale preview-derived override) decide the
          // scope UI.
          setContactsScopeOverride(null);
          setStatus(s);
        })
        .catch(() => {});
    } else if (google === "error") {
      const reason = params.get("reason") || "Google connection failed";
      toast.error(reason);
      queueMicrotask(() => setOauthErrorReason(reason));
      params.delete("google");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${next ? `?${next}` : ""}`
      );
    }
  }, [router]);

  // Fires once when this deployment has no Google credentials, so a caller (the wizard)
  // can route away instead of stranding the user on the "unavailable" card.
  useEffect(() => {
    if (!status || status.configured) return;
    if (unavailableFiredRef.current) return;
    unavailableFiredRef.current = true;
    onUnavailable?.();
  }, [status, onUnavailable]);

  // Loads contacts unprompted right after `?google=connected` lands (status flips to
  // scope-granted) and for a return visit that's already connected with contacts scope —
  // the wizard shouldn't make someone click "Import contacts" after they just consented.
  useEffect(() => {
    if (!autoPreview) return;
    if (!status || !status.configured) return;
    if (!contactsScopeGranted) return;
    if (loaded || busy) return;
    if (autoPreviewFiredRef.current) return;
    autoPreviewFiredRef.current = true;
    start(loadContacts);
  }, [autoPreview, status, contactsScopeGranted, loaded, busy, loadContacts, start]);

  if (!status) {
    return null;
  }

  if (!status.configured) {
    return (
      <IntegrationUnavailable
        id="import-google-contacts"
        title="Google Contacts"
        blurb="Google isn't available on this deployment yet. Upload a LinkedIn export, or paste your notes into Capture and Orbit will pull the people out."
        envVars={[
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI",
        ]}
      />
    );
  }

  const Wrapper = compact ? "div" : "section";

  return (
    <Wrapper
      id="import-google-contacts"
      className={
        compact
          ? "space-y-4"
          : "space-y-4 rounded-2xl border border-border/70 bg-card p-6"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {!compact && (
            <h2 className="text-lg font-medium text-ink">Google Contacts</h2>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {status.connected
              ? `Connected as ${status.emailAddress}${!contactsScopeGranted ? " — reconnect to grant contacts access" : ""}`
              : "Connect your Google account to import contacts directly."}
          </p>
          {compact && oauthErrorReason ? (
            <p className="mt-1 text-sm text-muted-foreground">{oauthErrorReason}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!status.connected || !contactsScopeGranted ? (
            <Button disabled={busy} onClick={connectGoogle}>
              {status.connected ? "Reconnect Google" : "Connect Google"}
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => start(loadContacts)}>
                {pending ? "Loading…" : loaded ? "Refresh contacts" : "Import contacts"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    await disconnectGmail();
                    setPeople([]);
                    setSelected(new Set());
                    setLoaded(false);
                    setStatus(null);
                    setContactsScopeOverride(null);
                    toast.success("Google disconnected");
                    router.refresh();
                    getGmailConnectionStatus().then(setStatus).catch(() => {});
                  })
                }
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      </div>

      {pending && !loaded ? <BusyHint>Loading contacts…</BusyHint> : null}

      {loaded && people.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            No contacts in this Google account.
          </p>
          <Button variant="outline" disabled={busy} onClick={connectGoogle}>
            Use a different account
          </Button>
        </div>
      ) : null}

      {people.length > 0 && (
        <>
          <ImportPeopleReview
            people={people.map((p) => ({
              id: p.id,
              name: p.fullName,
              subtitle: [p.title, p.company].filter(Boolean).join(" · "),
              isRepeat: p.isRepeat,
              repeatReason: p.duplicate?.reason,
            }))}
            selectedIds={selected}
            onSelectedIdsChange={setSelected}
            onRemove={(id) => {
              setPeople((prev) => prev.filter((p) => p.id !== id));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }}
          />
          <Button
            disabled={busy || selected.size === 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              if (busy) return;
              try {
                const ids = [...selected];
                startImportJob({ kind: "google_contacts", ids });
                onImportStarted?.(ids.length);
                // Clear the review list immediately; progress lives in the runner.
                setPeople([]);
                setSelected(new Set());
                setLoaded(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Import failed");
              }
            }}
          >
            {importProgress
              ? `Importing… ${importProgress.done}/${importProgress.total}`
              : `Import ${selected.size} selected`}
          </Button>
        </>
      )}
    </Wrapper>
  );
}
