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
 * - `useRecruiterScan("google", null)` owns the scan — mounted inside `InboxRow` so that
 *   `active` going false unmounts it and stops its two-second poll. Base UI only unmounts the
 *   dialog body once its exit animation ends, which a backgrounded tab never finishes, so
 *   stopping on unmount alone would leave the poll running.
 * - `googleAccountStatus` + `rowControl` decide what each row offers; neither lives here, so
 *   the Microsoft page cannot answer the same state differently.
 *
 * ## `jobRunning`, not any job
 *
 * The cards this replaces disabled their buttons whenever *any* import was running — a
 * LinkedIn import greyed out the Google contacts button. These rows read this provider's own
 * job (`contacts.jobRunning`) instead. It is the one deliberate behaviour change here.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { CalendarClock, CalendarDays, Loader2, Mail, Send, Users } from "lucide-react";
import { setCalendarSync } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { BusyHint } from "@/components/imports/import-utils";
import { AccountPageShell, FeatureRow } from "@/components/settings/account-page";
import { useContactsImport } from "@/components/settings/use-contacts-import";
import { useGoogleConnection } from "@/components/settings/use-provider-connection";
import { useRecruiterScan } from "@/components/settings/use-recruiter-scan";
import type { IntegrationTabId } from "@/components/settings/sections";
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
const INBOX_ROW_ID = "integration-google-inbox";

export function GoogleAccountPage({
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
  const connection = useGoogleConnection({ returnTo });
  const contacts = useContactsImport("google");
  const { status } = connection;
  const account = status ? googleAccountStatus(status, { canUseRecruiters }) : null;
  const capabilities = account?.capabilities ?? {};

  return (
    <AccountPageShell
      provider="google"
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

      {inboxVisible && active ? (
        <InboxRow
          capability={capabilities.inbox}
          aiReady={aiReady}
          busy={connection.busy}
          onAllow={() => connection.connect(["recruiter_scan"])}
          onOpenPage={onOpenPage}
        />
      ) : null}

      <FeatureRow
        icon={<Send className="size-4" />}
        title="Send from Gmail"
        description="Replies you approve go out from your address."
        control={rowControl("send", capabilities.send)}
        disabled={connection.busy}
        onAction={() => connection.connect(["send"])}
      />

      <FeatureRow
        icon={<CalendarClock className="size-4" />}
        title="Reminders in Google Calendar"
        description="See your follow-ups next to your meetings."
        // Not a capability of the grant: the reminders page hands out its own private
        // calendar address, which works whether or not Google is connected at all.
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
        // Fix and Allow both come down to asking Google for the calendar again; only a live
        // grant has a switch to flip.
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
  onAllow,
  onOpenPage,
}: {
  capability: CapabilityStatus | undefined;
  aiReady: boolean;
  busy: boolean;
  onAllow: () => void;
  onOpenPage: (page: IntegrationTabId) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { scan, running, phaseLabel, percent, start, cancel } = useRecruiterScan("google", null);

  const control = rowControl("inbox", capability);
  const isScan = control.kind === "action" && control.label === "Scan inbox";
  const isAllow = control.kind === "action" && control.label === "Allow";
  // A scan reads mail with the AI, so it cannot start without one — the row says where to
  // turn it on rather than starting something the server would refuse.
  const needsAi = isScan && !aiReady;
  const disabled = control.kind === "locked" ? false : busy || pending || running || needsAi;

  return (
    <FeatureRow
      id={INBOX_ROW_ID}
      icon={<Mail className="size-4" />}
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
        if (control.kind === "locked") router.push("/upgrade");
        else if (isAllow) onAllow();
        else startTransition(() => start());
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
          Last look read {scan.messagesScanned.toLocaleString()} messages and found{" "}
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
