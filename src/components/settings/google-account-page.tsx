"use client";

/**
 * Google, as one page: connect once, then a row per feature.
 *
 * What this replaces is two separate cards on the same panel — the Google Contacts importer
 * and the Gmail recruiter-scan panel — each stating the account, each with its own Connect and
 * its own Disconnect, and neither able to say anything about the other three things the same
 * grant covers. Here the account is stated once by `AccountPageShell`, and contacts, meetings,
 * the inbox scan, sending and reminders each get a row that answers for itself.
 *
 * ## Who owns what
 *
 * - `useGoogleConnection` owns the status, the sign-in return and Connect/Disconnect. One
 *   owner per page: two components each stripping the OAuth params race each other's
 *   `history.replaceState`, and the loser's queued server action is dropped unsettled (see
 *   `use-provider-connection.ts`).
 * - `useContactsImport("google")` owns the preview, the selection and the import job.
 * - `useRecruiterScan("google", …)` owns the scan — mounted inside `InboxRow` so that
 *   `active` going false unmounts it and stops its two-second poll. Base UI only unmounts the
 *   dialog body once its exit animation ends, which a backgrounded tab never finishes, so
 *   stopping on unmount alone would leave the poll running.
 * - `useLatestScan` owns the one read that tells that hook where the scan already is — see
 *   "The scan that is already running", below. The same read answers the disconnect dialog:
 *   recruiter data can only come from a scan, so a read that ran, succeeded and found none
 *   is the one case where there is nothing for it to offer to delete — until the inbox row
 *   reports a scan started here, which is later than that read and undoes it.
 * - `googleAccountStatus` + `rowControl` decide what each row offers; neither lives here, so
 *   the Microsoft page cannot answer the same state differently.
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
 * of the sign-in return: `useGoogleConnection` strips the OAuth params with
 * `history.replaceState`, and that drops any server action queued at the time without ever
 * settling it. A status in hand means the strip has already happened.
 *
 * ## `jobRunning`, not any job
 *
 * The cards this replaces disabled their buttons whenever *any* import was running — a
 * LinkedIn import greyed out the Google contacts button. These rows read this provider's own
 * job (`contacts.jobRunning`) instead. It is the one deliberate behaviour change here.
 */

import { useViewerPlan } from "@/components/viewer-plan";
import { availableOn } from "@/lib/plans/plan-config";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  HardDrive,
  Loader2,
  Mail,
  MailCheck,
  RefreshCw,
  Send,
  Users,
} from "lucide-react";
import {
  getGmailScanStatus,
  setCalendarSync,
  setGoogleContactsSync,
  type GmailScanStatus,
} from "@/actions/gmail";
import {
  getGooglePanel,
  refreshGoogleCalendars,
  setGoogleCalendarEnabled,
  type GoogleCalendarRow,
  type GooglePanel,
} from "@/actions/google-settings";
import { listImports, type ImportHistoryItem } from "@/actions/imports";
import { setEmailActivitySync } from "@/actions/email-activity";
import { setEmailIntel } from "@/actions/email-intel";
import { getSendCapabilityAction } from "@/actions/email-sends";
import { Button } from "@/components/ui/button";
import { CalendarPicker, SwitchRow, useSyncNow } from "@/components/settings/account-rows";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import { syncAccountNow } from "@/actions/sync-now";
import { cn } from "@/lib/utils";
import { GoogleMark } from "@/components/settings/provider-marks";
import { IMPORT_HISTORY_LIMIT, ImportHistoryRow } from "@/components/settings/import-history-row";
import { GMAIL_SCAN_IMPORT_TYPE } from "@/lib/gmail-scan-type";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { GooglePhotoMatch } from "@/components/settings/google-photo-match";
import { AccountPageShell, FeatureRow, syncStatusLine } from "@/components/settings/account-page";
import { useContactsImport } from "@/components/settings/use-contacts-import";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";
import { useLatestScan, useRecruiterScan } from "@/components/settings/use-recruiter-scan";
import {
  focusTargetId,
  type IntegrationTabId,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { friendlyError } from "@/lib/errors";
import {
  googleAccountStatus,
  rowControl,
  type CapabilityStatus,
  type RowControl,
} from "@/lib/integration-status";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/** Where `?integration=gmail` lands. Kept on the inbox row itself, which is what it names. */
const INBOX_ROW_ID = focusTargetId("google", "inbox");

/**
 * Google's own published colors, exactly as `GoogleMark` draws them (`provider-marks.tsx`).
 * Never a near-miss: Orbit's consent screen is in verification, and a mark in almost-Google
 * colors beside the real one is what gets noticed. Each tints the icon tile of the rows whose
 * feature it stands for; buttons and switches stay Orbit's own.
 */
const GOOGLE = { blue: "#4285F4", red: "#EA4335", yellow: "#FBBC05", green: "#34A853" } as const;
const GOOGLE_IMPORT_TYPES = ["google_contacts", "drive_docs", GMAIL_SCAN_IMPORT_TYPE];

type SendCapability = Awaited<ReturnType<typeof getSendCapabilityAction>>;

export function GoogleAccountPage({
  returnTo,
  inboxVisible,
  canUseRecruiters,
  aiReady,
  active,
  onOpenPage,
  onLeaveTo,
  emailInsights,
}: {
  returnTo: string;
  /** False when /recruiters is hidden — the inbox row is left out. */
  inboxVisible: boolean;
  canUseRecruiters: boolean;
  /** AI is on. The inbox row needs it; false renders a "Turn on AI" link instead. */
  aiReady: boolean;
  /** False from the moment the dialog starts closing: stops the scan poll. */
  active: boolean;
  /** Opens another page of this dialog — the "Turn on AI" link. */
  onOpenPage: (page: IntegrationTabId) => void;
  /** Closes the dialog on a card of the settings page — the Reminders and signature links. */
  onLeaveTo: (anchor: SettingsSectionId) => void;
  /** Email insights, or null while it waits on Radar's release. */
  emailInsights: { initialEnabled: boolean } | null;
}) {
  const router = useRouter();
  const connection = useGoogleConnection({ returnTo });
  const contacts = useContactsImport("google");
  const { status } = connection;
  const recruitersOn = availableOn("recruiters", useViewerPlan().planConfig);
  const account = status ? googleAccountStatus(status, { canUseRecruiters, recruitersOn }) : null;
  const capabilities = account?.capabilities ?? {};

  const showsInbox = inboxVisible && active;
  // Exactly the conditions under which the row could show a scan: it is on the page, the plan
  // includes it, and the account is reachable. `account` being set also means the connection
  // status has landed, which is what holds this read clear of the sign-in return's strip.
  const latestScan = useLatestScan(
    getGmailScanStatus,
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

  // Counts, calendars, history and today's sends: read once the account is known to be
  // connected, which also keeps them clear of the sign-in return's strip (see the scan read).
  const connected = account?.state === "connected";
  const [panel, setPanel] = useState<GooglePanel | null>(null);
  const [history, setHistory] = useState<ImportHistoryItem[] | null>(null);
  const [sendCap, setSendCap] = useState<SendCapability | null>(null);
  const loadPanel = useCallback(() => {
    getGooglePanel().then(setPanel, () => {});
    listImports({ limit: IMPORT_HISTORY_LIMIT, importTypes: GOOGLE_IMPORT_TYPES }).then(setHistory, () =>
      setHistory([])
    );
    getSendCapabilityAction().then(setSendCap, () => {});
  }, []);
  useEffect(() => {
    if (connected) loadPanel();
  }, [connected, loadPanel]);

  const syncNow = useSyncNow(() => syncAccountNow("google"), status?.lastSyncedAt, connection.refresh);

  return (
    <AccountPageShell
      name="Google"
      mark={<GoogleMark className="size-6" />}
      theme={PROVIDER_THEMES.google}
      account={account}
      loading={connection.loading}
      failed={connection.failed}
      onRetry={connection.retry}
      onConnect={() => connection.connect()}
      status={syncStatusLine({
        signedOut: account?.state === "needs_reauth",
        syncing: syncNow.syncing,
        lastSyncedAt: status?.lastSyncedAt,
        error: status?.syncError,
      })}
      primaryAction={{
        label: syncNow.syncing ? "Syncing…" : "Sync now",
        icon: <RefreshCw aria-hidden className={cn(syncNow.syncing && "animate-spin")} />,
        onClick: syncNow.sync,
        disabled: syncNow.syncing || connection.busy,
      }}
      menuItems={[{ label: "Switch account", onSelect: () => connection.connect() }]}
      disconnect={{
        provider: "gmail",
        hasDeletableData,
        onConfirm: (opts) =>
          connection.disconnect(opts).then(
            () => contacts.reset(),
            (err) => toast.error(friendlyError(err, "Couldn’t disconnect that account — try again?"))
          ),
      }}
    >
      <ContactsRow
        capability={capabilities.contacts}
        contacts={contacts}
        fromGoogle={panel?.contactsFromGoogle ?? null}
        busy={connection.busy}
        onAllow={() => connection.connect(["contacts"])}
      />

      {status?.canImportContacts ? (
        <SwitchRow
          icon={<RefreshCw className="size-4" />}
          tone={GOOGLE.blue}
          title="Keep contacts in sync"
          description={
            status.contactsSyncEnabled
              ? `New and changed Google contacts come in on their own.${
                  panel?.contactsSyncedAt
                    ? ` Synced ${formatDistanceToNow(new Date(panel.contactsSyncedAt), { addSuffix: true })}.`
                    : ""
                }`
              : "Off — only the contacts you import yourself come in."
          }
          on={status.contactsSyncEnabled}
          busy={connection.busy}
          save={(on) => setGoogleContactsSync(on)}
          done={(on) => (on ? "Contacts will keep in sync" : "Contacts sync is off")}
          onSaved={() => {
            connection.refresh();
            loadPanel();
          }}
        />
      ) : null}

      <GooglePhotoMatch
        capability={capabilities.contacts}
        tone={GOOGLE.blue}
        busy={connection.busy}
        onAllow={() => connection.connect(["contacts"])}
      />

      <MeetingsRow
        capability={capabilities.meetings}
        lastCheckedAt={status?.lastSyncedAt ?? null}
        meetingsLogged={panel?.meetingsLogged ?? null}
        calendars={panel?.calendars ?? []}
        busy={connection.busy}
        onRefresh={() => {
          connection.refresh();
          loadPanel();
        }}
        onAllow={() => connection.connect(["calendar"])}
      />

      {status?.canRead ? (
        <SwitchRow
          icon={<MailCheck className="size-4" />}
          tone={GOOGLE.red}
          title="Email activity"
          description={
            panel?.emailActivityOn
              ? `Logs emails with people you know onto their timelines.${
                  panel.emailsLogged ? ` ${panel.emailsLogged.toLocaleString()} logged so far.` : ""
                }`
              : "Off — emails aren’t logged. Orbit only ever reads who you wrote to and when."
          }
          on={panel?.emailActivityOn ?? false}
          busy={connection.busy || panel === null}
          save={async (on) => {
            await setEmailActivitySync(on);
            return { ok: true as const };
          }}
          done={(on) => (on ? "Email activity is on" : "Email activity is off")}
          onSaved={loadPanel}
        />
      ) : (
        <FeatureRow
          icon={<MailCheck className="size-4" />}
          tone={GOOGLE.red}
          title="Email activity"
          description="Logs emails with people you know onto their timelines. Asks Google first."
          control={{ kind: "action", label: "Allow" }}
          disabled={connection.busy}
          onAction={() => connection.connect(["email_intel"])}
        />
      )}

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

      {emailInsights ? (
        <EmailInsightsRow
          initialEnabled={emailInsights.initialEnabled}
          canRead={status?.canRead ?? false}
          allowed={canUseRecruiters}
          busy={connection.busy}
          onAllow={() => connection.connect(["email_intel"])}
        />
      ) : null}

      <FeatureRow
        icon={<Send className="size-4" />}
        tone={GOOGLE.red}
        title="Send from Gmail"
        description={
          <>
            Replies you approve go out from your address.
            {status?.canSend && sendCap ? ` ${sendCap.usedToday} of ${sendCap.dailyCap} sent today. ` : " "}
            {status?.canSend ? (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onLeaveTo("settings-email")}
              >
                Signature and defaults
              </button>
            ) : null}
          </>
        }
        control={rowControl("send", capabilities.send)}
        disabled={connection.busy}
        onAction={() => connection.connect(["send"])}
      />

      <FeatureRow
        icon={<HardDrive className="size-4" />}
        tone={GOOGLE.yellow}
        title="Docs and Slides from Drive"
        description="Pick meeting notes from Drive and Orbit adds the people in them. Only the files you pick."
        control={{ kind: "action", label: status?.canImportDrive ? "Import from Drive" : "Allow" }}
        disabled={connection.busy}
        onAction={() =>
          status?.canImportDrive
            ? router.push("/capture?mode=imports#import-panel-drive")
            : connection.connect(["drive"])
        }
      />

      <FeatureRow
        icon={<CalendarClock className="size-4" />}
        title="Reminders in Google Calendar"
        description="See your follow-ups next to your meetings."
        // Not a capability of the grant: the feed is a private calendar address of Orbit's own,
        // which works whether or not Google is connected at all. It lives under Notifications.
        control={{ kind: "action", label: "Add" }}
        onAction={() => onLeaveTo("settings-calendar")}
      />

      <ImportHistoryRow history={history} source="Google" onUndone={loadPanel} />
    </AccountPageShell>
  );
}

const EMAIL_INSIGHTS_COPY =
  "Orbit checks Gmail for job and hiring threads and has your AI provider note the company, role and where things stand. It keeps those notes and one short quote — never the messages themselves.";

/**
 * Email insights: where each application stands, read from new hiring threads. Beside
 * "Recruiters in Gmail", its near twin, and asking for mail access the same way Email activity
 * does — only from this row, never on everyday Connect.
 */
function EmailInsightsRow({
  initialEnabled,
  canRead,
  allowed,
  busy,
  onAllow,
}: {
  initialEnabled: boolean;
  /** The connected grant already covers mail access. */
  canRead: boolean;
  /** The plan includes it (same as the recruiter scan). */
  allowed: boolean;
  busy: boolean;
  onAllow: () => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const icon = <BriefcaseBusiness className="size-4" />;

  if (!allowed || !canRead) {
    return (
      <FeatureRow
        icon={icon}
        tone={GOOGLE.green}
        title="Email insights"
        description={allowed ? EMAIL_INSIGHTS_COPY : `${EMAIL_INSIGHTS_COPY} On Orbit Pro and Orbit Max.`}
        control={allowed ? { kind: "action", label: "Allow" } : { kind: "none" }}
        disabled={busy}
        onAction={onAllow}
      />
    );
  }
  return (
    <SwitchRow
      icon={icon}
      tone={GOOGLE.green}
      title="Email insights"
      description={EMAIL_INSIGHTS_COPY}
      on={enabled}
      busy={busy}
      save={async (on) => {
        const result = await setEmailIntel(on);
        if (result.ok) setEnabled(on);
        return result;
      }}
      done={(on) => (on ? "Email insights on" : "Email insights off")}
      onSaved={() => {}}
    />
  );
}

function ContactsRow({
  capability,
  contacts,
  fromGoogle,
  busy,
  onAllow,
}: {
  capability: CapabilityStatus | undefined;
  contacts: ReturnType<typeof useContactsImport>;
  /** Contacts that came in from Google, imported or synced. Null until the panel read lands. */
  fromGoogle: number | null;
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
      tone={GOOGLE.blue}
      title="Contacts"
      description={
        imported
          ? `${imported} You pick who comes in.`
          : fromGoogle
            ? `${fromGoogle.toLocaleString()} ${fromGoogle === 1 ? "contact" : "contacts"} from Google. You pick who else comes in.`
            : "Bring your Google contacts into Orbit. You choose who before anything’s added."
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
  meetingsLogged,
  calendars,
  busy,
  onRefresh,
  onAllow,
}: {
  capability: CapabilityStatus | undefined;
  /** ISO, from the connection status. Null until the first run. */
  lastCheckedAt: string | null;
  meetingsLogged: number | null;
  calendars: GoogleCalendarRow[];
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
        toast.success(on ? "Meetings are on" : "Meetings are off — contacts and email keep syncing");
        onRefresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  return (
    <FeatureRow
      icon={<CalendarDays className="size-4" />}
      tone={GOOGLE.green}
      title="Meetings"
      description={meetingsLine(capability, lastCheckedAt, meetingsLogged)}
      control={control}
      disabled={busy || pending}
      onAction={() => {
        // Fix and Allow both come down to asking Google for the calendar again; only a live
        // grant has a switch to flip.
        if (control.kind === "switch") toggle(!control.on);
        else onAllow();
      }}
    >
      {control.kind === "switch" && control.on ? (
        <CalendarPicker
          calendars={calendars}
          tone={GOOGLE.green}
          primaryLabel="Primary"
          setEnabled={setGoogleCalendarEnabled}
          refreshList={refreshGoogleCalendars}
          onChanged={onRefresh}
        />
      ) : null}
    </FeatureRow>
  );
}

/** Never `syncError`, which can be a raw provider body — `detail` is already safe to show. */
function meetingsLine(
  capability: CapabilityStatus | undefined,
  lastCheckedAt: string | null,
  meetingsLogged: number | null
): string {
  if (capability?.state === "paused" && capability.detail) return capability.detail;
  if (capability?.state === "off") return "Off — meetings aren’t being logged.";
  const base = "Logs meetings with people you know onto their timelines.";
  if (capability?.state !== "on") return base;
  const logged = meetingsLogged ? ` ${meetingsLogged.toLocaleString()} logged.` : "";
  const checked = lastCheckedAt
    ? ` Checked ${formatDistanceToNow(new Date(lastCheckedAt), { addSuffix: true })}.`
    : "";
  return `${base}${logged}${checked}`;
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
  initialScan: GmailScanStatus | null;
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
  const recruitersOn = availableOn("recruiters", useViewerPlan().planConfig);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { scan, running, phaseLabel, percent, start, cancel } = useRecruiterScan(
    "google",
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
      id={INBOX_ROW_ID}
      icon={<Mail className="size-4" />}
      tone={GOOGLE.red}
      title="Recruiters in Gmail"
      description={
        needsAi ? (
          <>
            Finds recruiter emails and sums up each one. Asks Google first.{" "}
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
          "Finds recruiter emails and sums up each one. Asks Google first."
        )
      }
      control={control}
      disabled={disabled}
      onAction={() => {
        if (control.kind === "locked") router.push("/upgrade?gate=recruiters");
        else if (isAllow) onAllow();
        else {
          onScanStarted();
          startTransition(() => start());
        }
      }}
    >
      {control.kind === "locked" ? (
        <p className="text-sm text-muted-foreground">
          {capability?.detail ?? `Part of ${recruitersOn}`}
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
          {/* The stored message can be a raw Gmail body. */}
          {friendlyError(scan.errorMessage, "The last scan didn’t finish — try again?")}
        </p>
      ) : null}
    </FeatureRow>
  );
}
