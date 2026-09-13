"use client";

import { useEffect, useState, useTransition } from "react";
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
import { describeOAuthReason, friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * `returnTo` is where Google's consent screen sends the user back to. /imports by default;
 * the Integrations dialog in Settings passes its own URL so a connect started there lands
 * back in the dialog, on this tab.
 */
export function GoogleContactsImport({ returnTo = "/imports" }: { returnTo?: string } = {}) {
  const router = useRouter();
  const job = useImportJob();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [contactsScopeGranted, setContactsScopeGranted] = useState(true);
  const [people, setPeople] = useState<GoogleContactPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const googleJob =
    job?.kind === "google_contacts" && job.status === "running" ? job : null;
  const importProgress = googleJob?.progress ?? null;
  const busy = pending || job?.status === "running";

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google === "connected") {
      toast.success("Google connected");
      params.delete("google");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      // The current path, not a hardcoded one: this card also lives in Settings.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
      );
      router.refresh();
      getGmailConnectionStatus().then(setStatus).catch(() => {});
    } else if (google === "error") {
      {
        const oauth = describeOAuthReason(params.get("reason"), "Google");
        if (oauth.cancelled) toast.message(oauth.message);
        else toast.error(oauth.message);
      }
      params.delete("google");
      params.delete("gmail");
      params.delete("reason");
      const next = params.toString();
      // The current path, not a hardcoded one: this card also lives in Settings.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
      );
      // Re-read the status: a Next router "restore" (which `replaceState` is) drops any
      // server action still queued — here, the status fetch this card fired a moment ago
      // on mount — without settling it, which would leave the card rendering nothing.
      getGmailConnectionStatus().then(setStatus).catch(() => {});
    }
  }, [router]);

  if (!status) {
    return null;
  }

  if (!status.configured) {
    return (
      <IntegrationUnavailable
        id="import-google-contacts"
        title="Google Contacts"
        blurb="Not connected yet. Export your Google contacts as a vCard or Google CSV and upload it as a contacts file on the Imports page — no account connection needed."
        envVars={[
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI",
        ]}
      />
    );
  }

  return (
    <section id="import-google-contacts" className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">Google Contacts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.connected
              ? `Connected as ${status.emailAddress}${!contactsScopeGranted ? " — reconnect to grant contacts access" : ""}`
              : "Connect your Google account to import contacts directly."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!status.connected || !contactsScopeGranted ? (
            <Button
              disabled={busy}
              onClick={() =>
                start(async () => {
                  try {
                    const { url } = await startGmailOAuth(returnTo);
                    window.location.href = url;
                  } catch (err) {
                    toast.error(friendlyError(err, TOAST_COPY.connectFailed));
                  }
                })
              }
            >
              {status.connected ? "Reconnect Google" : "Connect Google"}
            </Button>
          ) : (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    try {
                      const res = await previewGoogleContacts();
                      setContactsScopeGranted(res.contactsScopeGranted);
                      if (!res.contactsScopeGranted) {
                        toast.error("Reconnect Google to allow access to your contacts");
                        return;
                      }
                      setPeople(res.people);
                      setSelected(
                        new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id))
                      );
                      setLoaded(true);
                      toast.success(`Loaded ${res.people.length} contacts`);
                    } catch (err) {
                      toast.error(
                        friendlyError(err, TOAST_COPY.loadContactsFailed)
                      );
                    }
                  })
                }
              >
                {pending ? "Loading…" : loaded ? "Refresh contacts" : "Import contacts"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    await disconnectGmail();
                    setPeople([]);
                    setLoaded(false);
                    setStatus(null);
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
                // Clear the review list immediately; progress lives in the runner.
                setPeople([]);
                setSelected(new Set());
                setLoaded(false);
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.importFailed));
              }
            }}
          >
            {importProgress
              ? `Importing… ${importProgress.done}/${importProgress.total}`
              : `Import ${selected.size} selected`}
          </Button>
        </>
      )}
    </section>
  );
}
