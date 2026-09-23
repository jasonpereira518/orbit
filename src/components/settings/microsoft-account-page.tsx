"use client";

/**
 * Microsoft, as one page: connect once, then a row per feature. The Google page's twin.
 *
 * Four rows where Google has five. Microsoft has no send purpose — `microsoft-scopes.ts`
 * asks for Contacts, Calendars and Mail and nothing else — so there is no "Send from"
 * row here, and `microsoftAccountStatus` returns no `send` capability for one to read.
 *
 * The recruiter scan appears in Settings for the first time on this page. Before it, the
 * Outlook scan lived only on /recruiters: the Settings dialog had a Gmail tab and no Outlook
 * one, so an Outlook account's inbox was set up in one place and its contacts in another.
 *
 * ## Who owns what
 *
 * - `useMicrosoftConnection` owns the status, the sign-in return and Connect/Disconnect. One
 *   owner per page: two components each stripping the OAuth params race each other's
 *   `history.replaceState`, and the loser's queued server action is dropped unsettled (see
 *   `use-provider-connection.ts`).
 * - `useContactsImport("microsoft")` owns the preview, the selection and the import job.
 * - `useRecruiterScan("microsoft", …)` owns the scan — mounted inside `InboxRow` so that
 *   `active` going false unmounts it and stops its two-second poll. Base UI only unmounts the
 *   dialog body once its exit animation ends, which a backgrounded tab never finishes, so
 *   stopping on unmount alone would leave the poll running.
 * - `useLatestScan` owns the one read that tells that hook where the scan already is — see
 *   "The scan that is already running", below. The same read answers the disconnect dialog:
 *   recruiter data can only come from a scan, so a read that ran, succeeded and found none
 *   is the one case where there is nothing for it to offer to delete — until the inbox row
 *   reports a scan started here, which is later than that read and undoes it.
 * - `microsoftAccountStatus` + `rowControl` decide what each row offers; neither lives here,
 *   so this page cannot answer a state differently from the Google one.
 *
 * ## The scan that is already running
 *
 * A scan can be started from /recruiters and still be going when this page opens, and the last
 * one's result is worth showing whoever opens the page next. `useRecruiterScan` reads its
 * `initialScan` once, on mount, so this page reads the latest scan itself and remounts the row
 * — `key` — the moment that read lands. Until it does the row is present but its action is
 * disabled: pressing Scan in that window would start a scan the remount then forgot about.
 *
 * The read is held back until the connection status has landed, which is what keeps it clear
 * of the sign-in return: `useMicrosoftConnection` strips the OAuth params with
 * `history.replaceState`, and that drops any server action queued at the time without ever
 * settling it. A status in hand means the strip has already happened.
 *
 * ## `jobRunning`, not any job
 *
 * The card this replaces disabled its buttons whenever *any* import was running — a LinkedIn
 * import greyed out the Outlook contacts button. These rows read this provider's own job
 * (`contacts.jobRunning`) instead, as the Google page's do.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { CalendarClock, CalendarDays, Loader2, Mail, Users } from "lucide-react";
import { getOutlookScanStatus, setCalendarSync, type OutlookScanStatus } from "@/actions/outlook";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { AccountPageShell, FeatureRow } from "@/components/settings/account-page";
import { useContactsImport } from "@/components/settings/use-contacts-import";
import { useMicrosoftConnection } from "@/components/settings/use-provider-connection";
import { useLatestScan, useRecruiterScan } from "@/components/settings/use-recruiter-scan";
import type { IntegrationTabId } from "@/components/settings/sections";
import { friendlyError } from "@/lib/errors";
import {
  microsoftAccountStatus,
  rowControl,
  type CapabilityStatus,
  type RowControl,
} from "@/lib/integration-status";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

export function MicrosoftAccountPage({
  returnTo,
  inboxVisible,
  canUseRecruiters,
  aiReady,
  active,
  onOpenPage,
}: {
  returnTo: string;
  /** False when /recruiters is hidden — the inbox row is left out. */
  inboxVisible: boolean;
  canUseRecruiters: boolean;
  /** AI is on. The inbox row needs it; false renders a "Turn on AI" link instead. */
  aiReady: boolean;
  /** False from the moment the dialog starts closing: stops the scan poll. */
  active: boolean;
  /** Opens another page of this dialog — the Reminders row and the "Turn on AI" link. */
  onOpenPage: (page: IntegrationTabId) => void;
}) {
  const connection = useMicrosoftConnection({ returnTo, label: "Microsoft" });
  const contacts = useContactsImport("microsoft");
  const { status } = connection;
  const account = status ? microsoftAccountStatus(status, { canUseRecruiters }) : null;
  const capabilities = account?.capabilities ?? {};

  const showsInbox = inboxVisible && active;
  // Exactly the conditions under which the row could show a scan: it is on the page, the plan
  // includes it, and the account is reachable. `account` being set also means the connection
  // status has landed, which is what holds this read clear of the sign-in return's strip.
  const latestScan = useLatestScan(
    getOutlookScanStatus,
    showsInbox && canUseRecruiters && account?.state === "connected"
  );
  // What the disconnect dialog offers to delete is this account's recruiter data, and that
  // can only come from a scan — so "no scan has ever run" is "there is nothing to delete".
  // Only an answer this page actually has counts. The read above is gated, so where it never
  // ran this knows nothing (a free plan is the case that matters: an account can still hold
  // recruiter data from a past subscription), and a rejected read settles as "no scan" for
  // the row's sake. Either would hide the offer for data that exists, so both stay
  // `undefined`, which leaves the dialog's checkbox exactly where it was.
  //
  // The read happens once per mount — `useLatestScan`'s effect deps are `[read, enabled]`,
  // and `read` is a module-level action while `enabled` stays true once it flips — so a scan
  // started from the inbox row below is always later than the only answer it has. Without
  // this flag, opening a never-scanned account, pressing Scan inbox, then ⋯ → Disconnect
  // would say only that contacts stay, for an account whose fresh recruiter summaries also
  // stay. The row reports the press; from then on this page stops claiming there is nothing
  // to delete. Set on the press rather than on the scan's first status, so it costs no round
  // trip and errs towards showing the checkbox if the start is refused.
  //
  // The flag lives here, not in the row, so it survives the row's `key` remount.
  //
  // Known boundary: a scan started in *another tab* while this dialog sits open is still not
  // seen, and the dialog will say contacts stay. Accepted — the other branch's copy names
  // Settings → Data and privacy as the route to delete everything — rather than paid for
  // with a poll behind an open dialog.
  const [scanStartedHere, setScanStartedHere] = useState(false);
  const hasDeletableData = scanStartedHere
    ? true
    : latestScan.loaded && !latestScan.failed
      ? latestScan.scan !== null
      : undefined;

  return (
    <AccountPageShell
      provider="microsoft"
      account={account}
      loading={connection.loading}
      failed={connection.failed}
      onRetry={connection.retry}
      onConnect={() => connection.connect()}
      onDisconnect={(opts) =>
        connection.disconnect(opts).then(
          () => contacts.reset(),
          (err) => toast.error(friendlyError(err, "Couldn’t disconnect that account — try again?"))
        )
      }
      hasDeletableData={hasDeletableData}
    >
      <ContactsRow
        capability={capabilities.contacts}
        contacts={contacts}
        busy={connection.busy}
        onAllow={() => connection.connect(["contacts"])}
      />

      <MeetingsRow
        capability={capabilities.meetings}
        lastCheckedAt={status?.lastSyncedAt ?? null}
        busy={connection.busy}
        onRefresh={connection.refresh}
        onAllow={() => connection.connect(["calendar"])}
      />

      {showsInbox ? (
        // Keyed on what the scan read found: `useRecruiterScan` takes `initialScan` as a
        // `useState` initialiser, so the row has to be a new one to start from a scan that
        // arrived after it first rendered. `latestScan` settles once, so this remounts once.
        <InboxRow
          key={latestScan.loaded ? (latestScan.scan?.importId ?? "no-scan") : "reading-scan"}
          capability={capabilities.inbox}
          aiReady={aiReady}
          busy={connection.busy}
          initialScan={latestScan.scan}
          scanKnown={latestScan.loaded}
          onScanStarted={() => setScanStartedHere(true)}
          onAllow={() => connection.connect(["recruiter_scan"])}
          onOpenPage={onOpenPage}
        />
      ) : null}

      <FeatureRow
        icon={<CalendarClock className="size-4" />}
        title="Reminders in Outlook"
        description="See your follow-ups next to your meetings."
        // Not a capability of the grant: the reminders page hands out its own private
        // calendar address, which works whether or not Microsoft is connected at all.
        control={{ kind: "action", label: "Add" }}
        onAction={() => onOpenPage("reminders")}
      />
    </AccountPageShell>
  );
}

function ContactsRow({
  capability,
  contacts,
  busy,
  onAllow,
}: {
  capability: CapabilityStatus | undefined;
  contacts: ReturnType<typeof useContactsImport>;
  busy: boolean;
  onAllow: () => void;
}) {
  const control = rowControl("contacts", capability);
  const needsAllow = control.kind === "action" && control.label === "Allow";
  // This provider's own job, not any job — see the note at the top of the file.
  const working = busy || contacts.loading || contacts.jobRunning;

  // With a list already on screen, the row's own button fetches it again — pressing
  // "Import contacts" beside an Import button that imports would be two different promises
  // under one word. "Check for new" is the same label the state after an import uses.
  const rowControlForState: RowControl =
    !needsAllow && contacts.loaded && control.kind === "action"
      ? { kind: "action", label: "Check for new" }
      : control;

  /**
   * Nothing in Orbit records what a connected account has already brought in, so `detail` is
   * empty today and every account reads as one that hasn't imported yet. When a count does
   * arrive it is the capability's `detail` — "12 imported last week" — and it leads the line.
   */
  const imported = capability?.state === "on" ? capability.detail : undefined;

  return (
    <FeatureRow
      icon={<Users className="size-4" />}
      title="Contacts"
      description={
        imported
          ? `${imported} You pick who comes in.`
          : "Bring your Microsoft contacts into Orbit. You choose who before anything’s added."
      }
      control={rowControlForState}
      disabled={working}
      onAction={needsAllow ? onAllow : contacts.load}
    >
      {contacts.loading && !contacts.loaded ? <BusyHint>Loading contacts…</BusyHint> : null}

      {contacts.people.length > 0 ? (
        <>
          <ImportPeopleReview
            people={contacts.people}
            selectedIds={contacts.selected}
            onSelectedIdsChange={contacts.setSelected}
            onRemove={contacts.remove}
          />
          <Button
            size="sm"
            disabled={working || contacts.selected.size === 0}
            onClick={() => {
              if (working) return;
              contacts.start();
            }}
          >
            {contacts.progress
              ? `Importing… ${contacts.progress.done}/${contacts.progress.total}`
              : `Import ${contacts.selected.size} selected`}
          </Button>
        </>
      ) : null}
    </FeatureRow>
  );
}

function MeetingsRow({
  capability,
  lastCheckedAt,
  busy,
  onRefresh,
  onAllow,
}: {
  capability: CapabilityStatus | undefined;
  /** ISO, from the connection status. Null until the first run. */
  lastCheckedAt: string | null;
  busy: boolean;
  onRefresh: () => void;
  onAllow: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const control = rowControl("meetings", capability);

  function toggle(on: boolean) {
    startTransition(async () => {
      try {
        // The action answers rather than throws: a thrown Server Action message reaches the
        // browser as a digest, and this refusal — "allow Orbit to see your calendar first" —
        // is the whole point of pressing the switch.
        const result = await setCalendarSync(on);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(on ? "Meetings are on" : "Meetings are off");
        onRefresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  return (
    <FeatureRow
      icon={<CalendarDays className="size-4" />}
      title="Meetings"
      description={meetingsLine(capability, lastCheckedAt)}
      control={control}
      disabled={busy || pending}
      onAction={() => {
        // Fix and Allow both come down to asking Microsoft for the calendar again; only a
        // live grant has a switch to flip.
        if (control.kind === "switch") toggle(!control.on);
        else onAllow();
      }}
    />
  );
}

/** Never `syncError`, which can be a raw provider body — `detail` is already safe to show. */
function meetingsLine(capability: CapabilityStatus | undefined, lastCheckedAt: string | null): string {
  if (capability?.state === "paused" && capability.detail) return capability.detail;
  if (capability?.state === "off") return "Off — meetings aren’t being logged.";
  const base = "Logs meetings with people you know onto their timelines.";
  if (capability?.state !== "on" || !lastCheckedAt) return base;
  return `${base} Checked ${formatDistanceToNow(new Date(lastCheckedAt), { addSuffix: true })}.`;
}

/**
 * The recruiter scan. Owns `useRecruiterScan`, and is mounted only while the dialog is open,
 * so closing it stops the poll rather than waiting for Base UI's late unmount.
 */
function InboxRow({
  capability,
  aiReady,
  busy,
  initialScan,
  scanKnown,
  onScanStarted,
  onAllow,
  onOpenPage,
}: {
  capability: CapabilityStatus | undefined;
  aiReady: boolean;
  busy: boolean;
  /** The scan the page found, if any. Only meaningful once `scanKnown`. */
  initialScan: OutlookScanStatus | null;
  /** The page's scan read has settled. False means "not known yet", never "no scan". */
  scanKnown: boolean;
  /**
   * A scan is being started from this row. The page's own scan read is older than this, so
   * this is the only way it learns that recruiter data now exists — see `hasDeletableData`
   * above. Told, never asked: it must not gate or delay the scan.
   */
  onScanStarted: () => void;
  onAllow: () => void;
  onOpenPage: (page: IntegrationTabId) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { scan, running, phaseLabel, percent, start, cancel } = useRecruiterScan(
    "microsoft",
    initialScan
  );

  const control = rowControl("inbox", capability);
  const isScan = control.kind === "action" && control.label === "Scan inbox";
  const isAllow = control.kind === "action" && control.label === "Allow";
  // A scan reads mail with the AI, so it cannot start without one — the row says where to
  // turn it on rather than starting something the server would refuse.
  const needsAi = isScan && !aiReady;
  // `!scanKnown` covers the window before the page's scan read lands. Scan is the only action
  // that window blocks — Allow and Upgrade don't depend on where a scan is — and it blocks it
  // because the row is about to be replaced by one that starts from what the read found, which
  // would drop a scan begun in between.
  const disabled =
    control.kind === "locked"
      ? false
      : busy || pending || running || needsAi || (isScan && !scanKnown);

  return (
    <FeatureRow
      icon={<Mail className="size-4" />}
      title="Recruiters in Outlook"
      description={
        needsAi ? (
          <>
            Finds recruiter emails and sums up each one. Asks Microsoft first.{" "}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 align-baseline text-sm"
              onClick={() => onOpenPage("ai")}
            >
              Turn on AI
            </Button>{" "}
            to use it.
          </>
        ) : (
          "Finds recruiter emails and sums up each one. Asks Microsoft first."
        )
      }
      control={control}
      disabled={disabled}
      onAction={() => {
        if (control.kind === "locked") router.push("/upgrade");
        else if (isAllow) onAllow();
        else {
          onScanStarted();
          startTransition(() => start());
        }
      }}
    >
      {control.kind === "locked" ? (
        <p className="text-sm text-muted-foreground">
          {capability?.detail ?? "Part of Orbit Pro and Lifetime"}
        </p>
      ) : null}

      {running && scan ? (
        <div className="space-y-2 rounded-xl bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 text-foreground">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              {phaseLabel}
            </span>
            <Button variant="ghost" size="sm" onClick={() => startTransition(() => cancel())}>
              Cancel
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={
                percent == null
                  ? "h-full w-1/3 animate-pulse rounded-full bg-primary/60"
                  : "h-full rounded-full bg-primary transition-[width] duration-500"
              }
              style={percent == null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Runs on our side — you can close this and come back.
            {scan.recruitersFound > 0 ? ` ${scan.recruitersFound} found so far.` : ""}
          </p>
        </div>
      ) : null}

      {!running && scan?.status === "completed" ? (
        <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
          Last scan read {scan.messagesScanned.toLocaleString()} messages and found{" "}
          <span className="font-medium text-foreground">
            {scan.recruitersFound} recruiter{scan.recruitersFound === 1 ? "" : "s"}
          </span>
          . Summaries are private to you.
        </p>
      ) : null}

      {!running && scan?.status === "failed" ? (
        <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          {/* The stored message can be a raw Graph body. */}
          {friendlyError(scan.errorMessage, "The last scan didn’t finish — try again?")}
        </p>
      ) : null}
    </FeatureRow>
  );
}
