"use client";

import { Button } from "@/components/ui/button";
import {
  SESSION_EXPIRED_LINE,
  calendarOffLine,
  calendarPauseLine,
} from "@/lib/connection-status";
import { DisconnectAccountDialog } from "@/components/settings/disconnect-account-dialog";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { useImportJob } from "@/lib/import-job-runner";
import { IntegrationUnavailable } from "@/components/imports/integration-unavailable";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";
import { useContactsImport } from "@/components/settings/use-contacts-import";

/**
 * `returnTo` is where Google's consent screen sends the user back to. /imports by default;
 * the Integrations dialog in Settings passes its own URL so a connect started there lands
 * back in the dialog, on this tab.
 */
export function GoogleContactsImport({ returnTo = "/imports" }: { returnTo?: string } = {}) {
  const job = useImportJob();
  const connection = useGoogleConnection({ returnTo });
  const { status } = connection;
  const contacts = useContactsImport("google");
  const { people, selected, setSelected, loaded } = contacts;

  const importProgress = contacts.progress;
  const busy = connection.busy || contacts.loading || job?.status === "running";
  // Connect and disconnect run in the hook's own transition, not this component's — so the
  // "loading contacts" label/hint (below) has to read both, the way `pending` alone used to
  // cover all three when they shared one transition. Not `busy`: that also folds in a
  // running import job, which never used to flip this label.
  const loadingContacts = contacts.loading || connection.busy;
  // One handler for the header link and the button: both start the same contacts consent.
  const connect = () => connection.connect(["contacts"]);
  // The status knows the stored grant; the preview result can narrow it further.
  const contactsGranted = contacts.contactsScopeGranted && (status?.canImportContacts ?? true);

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
          ) : status.status === "paused" ? (
            // The person switched meetings off themselves: not a fault, so no warning colour
            // and no Reconnect — a consent screen would not turn them back on.
            <p className="mt-1 text-sm text-muted-foreground">{calendarOffLine()}</p>
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
              <Button disabled={busy} onClick={contacts.load}>
                {loadingContacts ? "Loading…" : loaded ? "Refresh contacts" : "Import contacts"}
              </Button>
              <DisconnectAccountDialog
                provider="gmail"
                disabled={busy}
                onConfirm={(opts) => {
                  connection.disconnect(opts).then(() => {
                    contacts.reset();
                  });
                }}
              />
            </>
          )}
        </div>
      </div>

      {loadingContacts && !loaded ? <BusyHint>Loading contacts…</BusyHint> : null}

      {people.length > 0 && (
        <>
          <ImportPeopleReview
            people={people}
            selectedIds={selected}
            onSelectedIdsChange={setSelected}
            onRemove={contacts.remove}
          />
          <Button
            disabled={busy || selected.size === 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              if (busy) return;
              contacts.start();
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
