/**
 * Where they've worked and studied, and — on their LinkedIn — the one click
 * that reads it off the page.
 *
 * The stored history shows on every plan (it may have come from Apollo). The
 * read is Pro, and it is the only thing in the panel that sends a whole
 * profile's text: the light copy every other call gets is too short to hold a
 * career, and the full one goes only on this click.
 *
 * A conflict is a question, not an error: this page is someone else's
 * LinkedIn, and only the user knows whether the contact is misfiled.
 */
import { useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import type {
  ContactSnapshot,
  PageContext,
  ProfileCaptureResponse,
  SnapshotWorkHistory,
} from "@contract";
import { ApiError, type OrbitApi } from "@/lib/api";
import { browser } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { APP_URL } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { readActivePage } from "@/lib/page";
import { unlockFeature } from "@/lib/unlock";
import {
  canReadWorkHistory,
  captureOutcome,
  detailsUrl,
  profileListsOnlySome,
  type CaptureOutcome,
} from "@/lib/work-history";
import { Button, Meta, Section } from "./ui";

export function WorkHistory({
  contact,
  page,
  api,
  locked,
  onSaved,
}: {
  contact: ContactSnapshot;
  page: PageContext;
  api: OrbitApi;
  /** undefined: a server too old to have the route — offer nothing. */
  locked: boolean | undefined;
  onSaved: () => void;
}) {
  const [history, setHistory] = useState<SnapshotWorkHistory | null>(contact.workHistory ?? null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome | null>(null);
  const [conflict, setConflict] = useState<ProfileCaptureResponse["conflict"] | null>(null);
  const [lockedNow, setLockedNow] = useState(false);

  const readable = canReadWorkHistory(page) && locked !== undefined;
  const isLocked = locked === true || lockedNow;

  const capture = async (confirmMismatch = false) => {
    setBusy(true);
    setOutcome(null);
    setConflict(null);
    try {
      const read = await readActivePage({ full: true });
      if (!read.ok) {
        setOutcome({ tone: "error", text: read.message });
        return;
      }
      const res = await api.profile({
        contactId: contact.id,
        page: read.page,
        ...(confirmMismatch ? { confirmMismatch } : {}),
      });
      if (res.status === "conflict" && res.conflict) {
        setConflict(res.conflict);
        return;
      }
      if (res.status === "saved") {
        setHistory(res.workHistory ?? null);
        onSaved();
      }
      setOutcome(captureOutcome(res));
    } catch (error) {
      if (error instanceof ApiError && error.code === "feature_locked") setLockedNow(true);
      else setOutcome({ tone: "error", text: "Couldn't read that page. Try again." });
    } finally {
      setBusy(false);
    }
  };

  if (!history && !readable) return null;

  const openSection = (section: "experience" | "education") => {
    const url = detailsUrl(page, section);
    if (url) browser().openTab(url);
  };

  return (
    <Section title="Work history">
      {history ? <HistoryList history={history} /> : null}

      {readable ? (
        <div className={cn(history && "mt-2.5")}>
          {isLocked ? (
            <div className="flex items-center gap-2">
              <Lock size={13} className="shrink-0 text-[var(--muted-foreground)]" />
              <Meta className="flex-1">Reading work history from LinkedIn is part of Orbit Pro.</Meta>
              <button
                onClick={() => void unlockFeature(api, "workHistory")}
                className="shrink-0 text-[11px] text-[var(--primary)] hover:underline"
              >
                See plans
              </button>
            </div>
          ) : conflict ? (
            <div className="space-y-1.5">
              <Meta>
                This page is linkedin.com/in/{conflict.pageSlug || "?"}, but {conflict.contactName} is
                on file as /in/{conflict.contactSlug}. Is this them?
              </Meta>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void capture(true)}>
                  It&apos;s them — save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void capture()}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                {busy
                  ? "Reading their page…"
                  : page.section === "education"
                    ? "Save education from this page"
                    : page.section === "experience"
                      ? "Save all roles from this page"
                      : history
                        ? "Update from this page"
                        : "Save work history from this page"}
              </Button>
              {!outcome && profileListsOnlySome(page) ? (
                <Meta className="mt-1.5">
                  This profile lists only some roles.{" "}
                  <button
                    onClick={() => openSection("experience")}
                    className="text-[var(--primary)] hover:underline"
                  >
                    Open the full list
                  </button>{" "}
                  to save them all.
                </Meta>
              ) : null}
            </>
          )}

          {outcome ? (
            <Meta
              className={cn(
                "mt-1.5",
                outcome.tone === "error" && "text-[var(--destructive)]"
              )}
            >
              {outcome.text}{" "}
              {outcome.openSection ? (
                <button
                  onClick={() => openSection(outcome.openSection!)}
                  className="text-[var(--primary)] hover:underline"
                >
                  Open it
                </button>
              ) : null}
              {outcome.settings ? (
                <button
                  onClick={() => browser().openTab(`${APP_URL}/settings?integration=ai`)}
                  className="text-[var(--primary)] hover:underline"
                >
                  Add a key
                </button>
              ) : null}
            </Meta>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

function HistoryList({ history }: { history: SnapshotWorkHistory }) {
  const moreRoles = history.roleCount - history.roles.length;
  const source =
    history.source === "extension"
      ? `From their LinkedIn, ${relativeTime(history.capturedAt) ?? "earlier"}`
      : "From Apollo";
  return (
    <div className="space-y-1">
      {[...history.roles, ...history.schools].map((entry, i) => (
        <div key={`${entry.organization}-${i}`} className="flex gap-2">
          <p className="min-w-0 flex-1 text-[13px] leading-[18px]">
            <span className={cn(!entry.isCurrent && "text-[var(--muted-foreground)]")}>
              {entry.organization}
            </span>
            {entry.title ? (
              <span className="text-[var(--muted-foreground)]"> · {entry.title}</span>
            ) : null}
          </p>
          {entry.dates ? (
            <Meta className="shrink-0 whitespace-nowrap pt-[1px] tabular-nums">{entry.dates}</Meta>
          ) : null}
        </div>
      ))}
      <Meta>
        {moreRoles > 0 ? `and ${moreRoles} more · ` : ""}
        {source}
      </Meta>
    </div>
  );
}
