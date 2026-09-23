"use client";

import { useEffect, useState, useTransition } from "react";
import { previewGoogleContacts, type GoogleContactPerson } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { SESSION_EXPIRED_LINE, calendarPauseLine } from "@/lib/connection-status";
import { DisconnectAccountDialog } from "@/components/settings/disconnect-account-dialog";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { toast } from "@/lib/toast";
import { IntegrationUnavailable } from "@/components/imports/integration-unavailable";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";

/**
 * `returnTo` is where Google's consent screen sends the user back to. /imports by default;
 * the Integrations dialog in Settings passes its own URL so a connect started there lands
 * back in the dialog, on this tab.
 */
export function GoogleContactsImport({ returnTo = "/imports" }: { returnTo?: string } = {}) {
  const job = useImportJob();
  const [pending, start] = useTransition();
  const connection = useGoogleConnection({ returnTo });
  const { status } = connection;
  const [contactsScopeGranted, setContactsScopeGranted] = useState(true);
  const [people, setPeople] = useState<GoogleContactPerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const googleJob =
    job?.kind === "google_contacts" && job.status === "running" ? job : null;
  const importProgress = googleJob?.progress ?? null;
  const busy = connection.busy || pending || job?.status === "running";
  // One handler for the header link and the button: both start the same contacts consent.
  const connect = () => connection.connect(["contacts"]);
  // The status knows the stored grant; the preview result can narrow it further.
  const contactsGranted = contactsScopeGranted && (status?.canImportContacts ?? true);

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
            {status.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to import contacts again`
              : status.connected
                ? `Connected as ${status.emailAddress}${!contactsGranted ? " — reconnect to grant contacts access" : ""}`
                : "Connect your Google account to import contacts directly."}
          </p>
          {status.status === "disarmed" ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-warning">
              <span>{calendarPauseLine(status.syncError)}</span>
              <Button variant="link" size="sm" className="h-auto px-0" disabled={busy} onClick={connect}>
                Reconnect Google
              </Button>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!status.connected || !contactsGranted ? (
            <Button
              disabled={busy}
              onClick={connect}
            >
              {status.connected || status.status === "needs_reauth"
                ? "Reconnect Google"
                : "Connect Google"}
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
              <DisconnectAccountDialog
                provider="gmail"
                disabled={busy}
                onConfirm={(opts) => {
                  setPeople([]);
                  setLoaded(false);
                  connection.disconnect(opts);
                }}
              />
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
