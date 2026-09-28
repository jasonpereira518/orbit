"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { addManualInterestListPasteAction } from "@/actions/admin";
import {
  ADMIN_EVENT_PASTE_MAX,
  SIGNUP_EVENT_LABEL_MAX,
  parseEventSignupPaste,
} from "@/lib/interest-list";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const INPUT =
  "w-full rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/50";

/**
 * Operator-added waitlist signups from an in-person event. Paste a spreadsheet column of
 * timestamp / name / email; they join in that order and get the welcome note naming the event.
 */
export function InterestListManualAddForm() {
  const [paste, setPaste] = useState("");
  const [eventLabel, setEventLabel] = useState("");
  const [pending, start] = useTransition();

  const preview = useMemo(() => parseEventSignupPaste(paste), [paste]);
  const ready =
    preview.rows.length > 0 &&
    eventLabel.trim().length >= 2 &&
    eventLabel.length <= SIGNUP_EVENT_LABEL_MAX;

  const previewHref = `/api/admin/email-preview?template=welcome&event=${encodeURIComponent(
    eventLabel.trim() || "UNC CS Founded Event"
  )}`;

  function submit(reason: string) {
    return new Promise<void>((resolve, reject) => {
      start(async () => {
        try {
          const res = await addManualInterestListPasteAction({
            paste,
            eventLabel: eventLabel.trim(),
            reason,
          });
          if (res.added > 0) {
            toast.success(
              res.added === 1
                ? "Welcome email sent to 1 person"
                : `Welcome emails sent to ${res.added} people`
            );
          }
          if (res.skipped > 0) {
            toast.warning(
              `${res.skipped} skipped${
                res.skippedEmails[0] ? `: ${res.skippedEmails[0].email} (${res.skippedEmails[0].reason})` : ""
              }`
            );
          }
          if (res.parseErrors.length > 0 && res.added === 0) {
            toast.error(res.parseErrors[0]!);
          }
          if (res.added > 0) {
            setPaste("");
          }
          resolve();
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t add those signups — try again?"));
          reject(err);
        }
      });
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Paste rows from a spreadsheet — timestamp, full name, email (tab- or comma-separated).
        They join in spreadsheet order and each gets the welcome email with this event named
        in it.
      </p>

      <label className="block space-y-1.5">
        <span className="flex items-baseline justify-between text-xs font-medium">
          Event / reason
          <span
            className={cn(
              "tabular-nums font-normal",
              eventLabel.length > SIGNUP_EVENT_LABEL_MAX
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {eventLabel.length}/{SIGNUP_EVENT_LABEL_MAX}
          </span>
        </span>
        <input
          type="text"
          value={eventLabel}
          onChange={(e) => setEventLabel(e.target.value)}
          placeholder="UNC CS Founded Event"
          className={INPUT}
          disabled={pending}
        />
      </label>

      <label className="block space-y-1.5">
        <span className="flex items-baseline justify-between text-xs font-medium">
          Spreadsheet paste
          <span className="font-normal text-muted-foreground">
            {preview.rows.length > 0
              ? `${preview.rows.length} ready${
                  preview.errors.length ? ` · ${preview.errors.length} row issue${preview.errors.length === 1 ? "" : "s"}` : ""
                }`
              : `up to ${ADMIN_EVENT_PASTE_MAX}`}
          </span>
        </span>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={
            "9/9/2026 17:32:18\tSai Nagamalla\tshreyas.nagamalla@gmail.com\n9/9/2026 17:40:43\tLuke Allen\tapl1@unc.edu"
          }
          className={cn(INPUT, "font-mono text-xs leading-relaxed")}
          disabled={pending}
        />
      </label>

      {preview.rows.length > 0 && (
        <ol className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs tabular-nums text-muted-foreground">
          {preview.rows.map((r, i) => (
            <li key={`${r.email}-${r.line}`}>
              {i + 1}. {r.firstName}
              {r.lastName !== r.firstName ? ` ${r.lastName}` : ""} · {r.email}
              {r.signedAt ? (
                <span className="ml-1 opacity-70">
                  ·{" "}
                  {r.signedAt.toLocaleString("en-US", {
                    timeZone: "America/New_York",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {preview.errors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {preview.errors.slice(0, 5).map((err) => (
            <li key={err}>{err}</li>
          ))}
          {preview.errors.length > 5 ? (
            <li>…and {preview.errors.length - 5} more</li>
          ) : null}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ConfirmActionDialog
          trigger={
            <button
              type="button"
              disabled={!ready || pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors duration-fast hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UserPlus className="size-3.5" aria-hidden />
              {pending
                ? "Adding…"
                : preview.rows.length <= 1
                  ? "Add and send welcome"
                  : `Add ${preview.rows.length} and send welcome`}
            </button>
          }
          title={
            preview.rows.length <= 1
              ? "Add to the waitlist?"
              : `Add ${preview.rows.length} people to the waitlist?`
          }
          description={`Send the welcome email${preview.rows.length === 1 ? "" : "s"} with the event named as “${eventLabel.trim() || "…"}”. They join in spreadsheet order. Addresses already on the list are skipped.`}
          confirmLabel="Add and send"
          onConfirm={submit}
        />
        <Link
          href={previewHref}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Preview welcome with this event
        </Link>
      </div>
    </div>
  );
}
