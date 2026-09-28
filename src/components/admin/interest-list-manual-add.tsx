"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { addManualInterestListSignupAction } from "@/actions/admin";
import { SIGNUP_EVENT_LABEL_MAX } from "@/lib/interest-list";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const INPUT =
  "w-full rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/50";

/**
 * Operator-added waitlist signups from in-person events. Sends the normal welcome note with
 * the event named in the opening line.
 */
export function InterestListManualAddForm() {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [eventLabel, setEventLabel] = useState("");
  const [pending, start] = useTransition();

  const ready =
    email.trim().length > 3 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    eventLabel.trim().length >= 2;

  const previewHref = `/api/admin/email-preview?template=welcome&event=${encodeURIComponent(
    eventLabel.trim() || "UNC CS Founded Event"
  )}`;

  function submit(reason: string) {
    return new Promise<void>((resolve, reject) => {
      start(async () => {
        try {
          const res = await addManualInterestListSignupAction({
            email: email.trim(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            eventLabel: eventLabel.trim(),
            reason,
          });
          toast.success(`Welcome email sent to ${res.email}`);
          setEmail("");
          setFirstName("");
          setLastName("");
          setEventLabel("");
          resolve();
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t add that signup — try again?"));
          reject(err);
        }
      });
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        For someone who signed up at an event in person. They join the line like any other
        signup and get the welcome email with the event named in it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 sm:col-span-2">
          <span className="text-xs font-medium">Email</span>
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className={INPUT}
            disabled={pending}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">First name</span>
          <input
            type="text"
            autoComplete="off"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={INPUT}
            disabled={pending}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">Last name</span>
          <input
            type="text"
            autoComplete="off"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={INPUT}
            disabled={pending}
          />
        </label>
        <label className="block space-y-1.5 sm:col-span-2">
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
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmActionDialog
          trigger={
            <button
              type="button"
              disabled={!ready || pending || eventLabel.length > SIGNUP_EVENT_LABEL_MAX}
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors duration-fast hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UserPlus className="size-3.5" aria-hidden />
              {pending ? "Adding…" : "Add and send welcome"}
            </button>
          }
          title="Add to the waitlist?"
          description={`Send the welcome email to ${email.trim() || "this address"} with the event named as “${eventLabel.trim() || "…"}”.`}
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
