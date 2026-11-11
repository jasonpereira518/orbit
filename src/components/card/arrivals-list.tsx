"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { addArrivalNote, listMyArrivals } from "@/actions/cards";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import type { Arrival } from "@/lib/cards/arrivals";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const POLL_MS = 5000;

/** People who sent their details back through the card, newest first. Polls while the tab is visible. */
export function ArrivalsList({ initial, limit }: { initial: Arrival[]; limit?: number }) {
  const [rows, setRows] = useState(initial);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () =>
      listMyArrivals()
        .then((next) => alive && setRows(next))
        .catch(() => null); // A missed poll is retried in five seconds.
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      timer = setInterval(tick, POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
      sync();
    };
    sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const shown = limit ? rows.slice(0, limit) : rows;
  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">No one yet. When someone sends their details back, they show up here.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60" aria-live="polite">
      {shown.map((a) => (
        <ArrivalRow key={a.id} arrival={a} />
      ))}
    </ul>
  );
}

function ArrivalRow({ arrival: a }: { arrival: Arrival }) {
  const role = [a.title, a.company].filter(Boolean).join(" @ ");
  const typed = [a.email, a.phone].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 truncate font-medium text-ink">{a.name}</p>
        <p className="text-xs text-muted-foreground">
          <RelativeTime date={a.createdAt} />
          {a.eventTitle && <> · at {a.eventTitle}</>}
        </p>
      </div>
      {role && <p className="-mt-1.5 text-sm text-muted-foreground">{role}</p>}
      <Status arrival={a} />
      {(typed || a.message) && (
        <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <span className="text-xs uppercase tracking-wide">They wrote</span>
          {typed && <span className="block break-all">{typed}</span>}
          {a.message && <span className="block whitespace-pre-wrap break-words">{a.message}</span>}
        </blockquote>
      )}
      {a.status !== "held" && a.contactId && <QuickNote arrival={a} />}
    </li>
  );
}

function Status({ arrival: a }: { arrival: Arrival }) {
  if (a.status === "held") return <p className="text-sm text-warning">Waiting — make room in your contacts</p>;
  if (!a.contactId) return null;
  const link = (
    <Link href={`/contacts/${a.contactId}`} className="text-primary underline-offset-4 hover:underline">
      {a.contactName ?? "your contact"}
    </Link>
  );
  if (a.status === "matched") {
    // They typed an email or phone one of the owner's contacts already has; nothing on that
    // contact changed, and nothing proves it was really them.
    return (
      <p className="text-sm text-muted-foreground">
        Matched to {link} by the email or phone they typed — not verified, and your contact wasn’t changed
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">Added to your contacts as {link}</p>;
}

function QuickNote({ arrival: a }: { arrival: Arrival }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(a.ownerNote ?? "");
  const [saved, setSaved] = useState(a.ownerNote);
  const [pending, start] = useTransition();
  const id = `note-${a.id}`;

  const save = () =>
    start(async () => {
      try {
        const res = await addArrivalNote(a.id, text);
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        setSaved(text.trim());
        setOpen(false);
        toast.success("Note saved");
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });

  if (!open) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {saved && <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink">Your note: {saved}</p>}
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setOpen(true)}>
          {saved ? "Edit note" : "Add a note"}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your note on {a.name}
      </label>
      <Textarea id={id} rows={2} maxLength={2000} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What did you talk about?" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !text.trim()}>
          Save note
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
