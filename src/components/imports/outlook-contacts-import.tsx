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
import type { MicrosoftPurpose } from "@/lib/microsoft-scopes";
import { IntegrationUnavailable } from "@/components/imports/integration-unavailable";
import { useMicrosoftConnection } from "@/components/settings/use-provider-connection";
import { useContactsImport } from "@/components/settings/use-contacts-import";

/** `returnTo`: see `GoogleContactsImport`. */
export function OutlookContactsImport({ returnTo = "/imports" }: { returnTo?: string } = {}) {
  const job = useImportJob();
  const connection = useMicrosoftConnection({ returnTo, deletesData: false });
  const { status } = connection;
  const contacts = useContactsImport("microsoft");
  const { people, selected, setSelected, loaded } = contacts;

  const importProgress = contacts.progress;
  const busy = connection.busy || contacts.loading || job?.status === "running";
  // Connect and disconnect run in the hook's own transition, not this component's — so the
  // "loading contacts" label/hint (below) has to read both, the way `pending` alone used to
  // cover all three when they shared one transition. Not `busy`: that also folds in a
  // running import job, which never used to flip this label.
  const loadingContacts = contacts.loading || connection.busy;
  // One handler for every button: each asks Microsoft for that feature's scope and nothing
  // else. "Reconnect" after a session expiry asks as "contacts" (this is the contacts card);
  // a paused calendar sync reconnects as "calendar", which was already granted, so fixing it
  // never asks for anything new.
  const connect = (purpose: MicrosoftPurpose = "contacts") => connection.connect([purpose]);

  if (!status) {
    return null;
  }

  if (!status.configured) {
    return (
      <IntegrationUnavailable
        id="import-outlook-contacts"
        title="Outlook Contacts"
        blurb="Not connected yet. Export your Outlook contacts as a CSV and upload it as a contacts file on the Imports page — no account connection needed."
        envVars={[
          "MICROSOFT_CLIENT_ID",
          "MICROSOFT_CLIENT_SECRET",
          "MICROSOFT_REDIRECT_URI",
        ]}
      />
    );
  }

  return (
    <section id="import-outlook-contacts" className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">Outlook Contacts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to import contacts again`
              : status.connected
                ? `Connected as ${status.emailAddress}${!status.hasContactsScope ? " — allow contacts access to import" : ""}`
                : "Connect your Microsoft account to import contacts directly."}
          </p>
          {status.status === "disarmed" ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-warning">
              <span>{calendarPauseLine(status.syncError, "Microsoft")}</span>
              <Button variant="link" size="sm" className="h-auto px-0" disabled={busy} onClick={() => connect("calendar")}>
                Reconnect Microsoft
              </Button>
            </p>
          ) : status.status === "paused" ? (
            // The person switched meetings off themselves: not a fault, so no warning colour
            // and no Reconnect — a consent screen would not turn them back on.
            <p className="mt-1 text-sm text-muted-foreground">{calendarOffLine("Microsoft")}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!status.connected ? (
            <Button disabled={busy} onClick={() => connect()}>
              {status.status === "needs_reauth" ? "Reconnect Microsoft" : "Connect Microsoft"}
            </Button>
          ) : (
            <>
              {!status.hasContactsScope ? (
                <Button disabled={busy} onClick={() => connect("contacts")}>
                  Allow contacts access
                </Button>
              ) : (
                <Button disabled={busy} onClick={contacts.load}>
                  {loadingContacts ? "Loading…" : loaded ? "Refresh contacts" : "Import contacts"}
                </Button>
              )}
              <DisconnectAccountDialog
                provider="outlook"
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

      {status.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/40 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">Outlook calendar</h3>
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
              {!status.hasCalendarScope
                ? "Read-only. Orbit logs meetings with people you know onto their timelines, and keeps them current."
                : status.status === "disarmed"
                  ? "Sync is paused — see above."
                  : status.status === "paused"
                    ? "Sync is off — see above."
                    : "Sync is on — meetings with people you know are logged on their timelines."}
            </p>
          </div>
          {!status.hasCalendarScope ? (
            <Button variant="outline" disabled={busy} onClick={() => connect("calendar")}>
              Sync your Outlook calendar
            </Button>
          ) : null}
        </div>
      ) : null}

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
