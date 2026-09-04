/**
 * Known contact.
 *
 * Reading order is *what do I need in the next thirty seconds*: what changed,
 * what I owe them, what I know, what to say. Everything else is reference.
 *
 * Structurally this is bands, not cards. A card costs ~26px of chrome per item
 * (border plus padding top and bottom); a band costs a 1px rule and its
 * padding. At full panel height a stack of small bordered boxes reads as a
 * pile, while ruled bands read as a set ledger — denser *and* more deliberate.
 * Cards are reserved for the two things that are actionable and dismissible as
 * a unit: the diff and the starters.
 */
import { useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  Loader2,
  PenLine,
  RefreshCw,
  X,
} from "lucide-react";
import type { ContactSnapshot, PageContext, ProfileCaptureResponse } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { APP_URL } from "@/lib/env";
import { cn } from "@/lib/cn";
import { relativeTime, truncateLabel } from "@/lib/format";
import { captureActiveProfile } from "@/lib/page";
import { StarterList } from "../components/StarterList";
import { Button, Chip, Meta, MicroLabel, Section } from "../components/ui";
import type { PanelState } from "../state/usePanel";

const FOLLOW_UP_PRESETS = [
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
];

export function KnownContactView({
  contact,
  page,
  state,
  api,
  onChanged,
}: {
  contact: ContactSnapshot;
  page: PageContext;
  state: PanelState;
  api: OrbitApi;
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<"none" | "note" | "followup">("none");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);

  const changes = (state.resolved?.changes ?? []).filter(
    (change) => !dismissed.includes(change.field)
  );
  const firstName = contact.preferredName ?? contact.fullName.split(/\s+/)[0];

  const toast = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1800);
  };

  const logNote = async (text: string, type = "note") => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.logInteraction({
        contactId: contact.id,
        rawNotes: text,
        interactionType: type,
      });
      setNote("");
      setPanel("none");
      toast("Note added");
      onChanged();
    } catch {
      toast("Couldn't save that");
    } finally {
      setBusy(false);
    }
  };

  const scheduleFollowUp = async (days: number) => {
    setBusy(true);
    try {
      await api.followUp({ contactId: contact.id, inDays: days });
      setPanel("none");
      toast(`Follow-up in ${days} days`);
      onChanged();
    } catch {
      toast("Couldn't schedule that");
    } finally {
      setBusy(false);
    }
  };

  const acceptChanges = async () => {
    setBusy(true);
    try {
      const fields: Record<string, string> = { fullName: contact.fullName };
      for (const change of changes) fields[change.field] = change.to;
      await api.saveContact({
        mode: "merge",
        contactId: contact.id,
        page,
        fields: fields as never,
      });
      toast("Updated");
      onChanged();
    } catch {
      toast("Couldn't update");
    } finally {
      setBusy(false);
    }
  };

  const saveSummary = async () => {
    setSummaryBusy(true);
    try {
      await api.saveContact({
        mode: "merge",
        contactId: contact.id,
        page,
        fields: { fullName: contact.fullName, aiSummary: summaryDraft.trim() },
      });
      setEditingSummary(false);
      toast("Description saved");
      onChanged();
    } catch {
      toast("Couldn't save that");
    } finally {
      setSummaryBusy(false);
    }
  };

  const knowledge = [
    ...contact.keyFacts.map((v) => ({ v, tone: "fact" as const })),
    ...contact.sharedInterests.map((v) => ({ v, tone: "shared" as const })),
    ...contact.opportunities.map((v) => ({ v, tone: "opportunity" as const })),
  ];

  const isSparse =
    knowledge.length === 0 &&
    contact.openActionItems.length === 0 &&
    contact.recentInteractions.length === 0 &&
    !contact.notesPreview;

  return (
    <>
      <div className="scroll-area flex-1">
        {contact.isFollowUpOverdue ? (
          <div className="flex items-center gap-2 border-l-2 border-[var(--destructive)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-3 py-2">
            <CalendarClock size={12} className="shrink-0 text-[var(--destructive)]" />
            <span className="flex-1 text-[12px]">
              Follow-up was due {relativeTime(contact.nextFollowUpAt)}
            </span>
            <button
              onClick={() => void scheduleFollowUp(7)}
              className="shrink-0 text-[11px] text-[var(--primary)] hover:underline"
            >
              Snooze
            </button>
          </div>
        ) : null}

        {changes.length > 0 ? (
          <Section hairline={false} className="pt-3">
            <MicroLabel className="mb-1.5 flex items-center gap-1.5 !text-[var(--primary)]">
              <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
              Since you last looked
            </MicroLabel>
            <div className="rounded-[var(--radius)] bg-[var(--accent)] p-2.5">
              {changes.map((change) => (
                <div
                  key={change.field}
                  className="group flex items-center gap-2 py-0.5 text-[12px]"
                >
                  <span className="w-[58px] shrink-0 text-[11px] capitalize text-[var(--muted-foreground)]">
                    {change.field}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-[var(--muted-foreground)] line-through opacity-60">
                      {change.from}
                    </span>{" "}
                    <span className="font-medium">{change.to}</span>
                  </span>
                  {/* Per-row dismiss: LinkedIn headlines go stale, and an
                      all-or-nothing card teaches people to ignore it. */}
                  <button
                    onClick={() => setDismissed((d) => [...d, change.field])}
                    title="Ignore this one"
                    className="shrink-0 px-1 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--foreground)] group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <Button
                size="sm"
                className="mt-2"
                onClick={() => void acceptChanges()}
                disabled={busy}
              >
                Update Orbit
              </Button>
            </div>
          </Section>
        ) : null}

        {/* Keyed on the page + contact so a fresh page (or a re-resolved contact) never
            inherits a stale "Saved N roles" / conflict state from whatever was captured
            before it. */}
        <ExperienceCaptureBand
          key={`${page.url}:${contact.id}`}
          page={page}
          contact={contact}
          api={api}
          toast={toast}
          onChanged={onChanged}
        />

        <Section title="Open loops">
          {contact.openActionItems.length > 0
            ? contact.openActionItems.slice(0, 3).map((item) => (
                <p key={item} className="py-0.5 text-[13px] leading-[18px]">
                  {item}
                </p>
              ))
            : null}
        </Section>

        <Section title="Who they are">
          {editingSummary ? (
            <>
              <textarea
                autoFocus
                rows={4}
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingSummary(false);
                }}
                placeholder="Who is this, and what should you remember about them?"
                className="w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2 text-[13px] leading-[18px] outline-none focus:border-[var(--ring)]"
              />
              <div className="mt-1.5 flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void saveSummary()}
                  disabled={summaryBusy}
                >
                  {summaryBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </>
          ) : (
            <div className="group flex items-start justify-between gap-2">
              {contact.aiSummary ? (
                <p className="flex-1 text-[13px] leading-[18px] text-[var(--muted-foreground)]">
                  {contact.aiSummary}
                </p>
              ) : isSparse ? (
                <span className="flex-1" />
              ) : (
                <Meta className="flex-1">
                  Orbit hasn&apos;t written a summary yet.
                </Meta>
              )}
              <button
                onClick={() => {
                  setSummaryDraft(contact.aiSummary ?? "");
                  setEditingSummary(true);
                }}
                title="Edit description"
                className={cn(
                  "shrink-0 text-[var(--muted-foreground)] transition-opacity hover:text-[var(--foreground)]",
                  contact.aiSummary
                    ? "opacity-0 group-hover:opacity-100"
                    : "opacity-100"
                )}
              >
                <PenLine size={13} />
              </button>
            </div>
          )}
        </Section>

        <Section title="What you know">
          {knowledge.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {knowledge.map(({ v, tone }) => (
                <Chip key={`${tone}-${v}`}>
                  <span
                    aria-hidden
                    className={cn(
                      "mr-1.5 h-1 w-1 shrink-0 rounded-full",
                      tone === "fact" && "bg-[var(--primary)]",
                      tone === "shared" && "bg-sky-500",
                      tone === "opportunity" && "bg-amber-500"
                    )}
                  />
                  {v}
                </Chip>
              ))}
            </div>
          ) : null}
        </Section>

        <Section title="Last spoke">
          {contact.recentInteractions[0]?.summary ? (
            <p className="line-clamp-3 text-[13px] leading-[18px] text-[var(--muted-foreground)]">
              {contact.recentInteractions[0].summary}
            </p>
          ) : null}
        </Section>

        <Section>
          <StarterList
            starters={state.starters}
            loading={state.startersLoading}
            degraded={state.startersDegraded}
            degradedReason={state.startersDegradedReason}
            onLog={(text) => void logNote(`Sent: ${text}`, "reach_out")}
          />
        </Section>

        {/* The sparse contact is the common case for LinkedIn imports. Rather
            than five empty headers, offer the one thing that fixes it. */}
        {isSparse ? (
          <Section title="Orbit knows the basics">
            <Meta className="mb-2 max-w-[38ch]">
              You haven&apos;t logged anything with {firstName} yet. A few
              seconds now saves you the next time.
            </Meta>
            <Button size="sm" variant="outline" onClick={() => setPanel("note")}>
              <PenLine size={12} />
              What do you know about them?
            </Button>
          </Section>
        ) : null}
      </div>

      {panel === "note" ? (
        <div className="shrink-0 border-t border-[var(--border)] px-3 py-2.5">
          <MicroLabel className="mb-1.5">Note on {firstName}</MicroLabel>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void logNote(note);
              }
              if (e.key === "Escape") setPanel("none");
            }}
            placeholder="What happened?"
            rows={3}
            className="w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2 text-[13px] leading-[18px] outline-none focus:border-[var(--ring)]"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void logNote(note)}
              disabled={busy || !note.trim()}
            >
              Save note
            </Button>
          </div>
        </div>
      ) : null}

      {panel === "followup" ? (
        <div className="shrink-0 border-t border-[var(--border)] px-3 py-2.5">
          <MicroLabel className="mb-1.5">Remind me in</MicroLabel>
          <div className="flex flex-wrap gap-1.5">
            {FOLLOW_UP_PRESETS.map((preset) => (
              <Button
                key={preset.days}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void scheduleFollowUp(preset.days)}
              >
                {preset.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setPanel("none")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* Confirmation lands where the finger already is — the bar's own
          contents swap, rather than a toast band pushing the bar down. */}
      <nav className="grid shrink-0 grid-cols-4 border-t border-[var(--border)]">
        {flash ? (
          <div className="col-span-4 flex items-center justify-center gap-1.5 py-3 text-[12px] text-[var(--primary)]">
            <Check size={13} />
            {flash}
          </div>
        ) : (
          <>
            <QuickAction
              icon={<PenLine size={15} />}
              label="Note"
              active={panel === "note"}
              onClick={() => setPanel(panel === "note" ? "none" : "note")}
            />
            <QuickAction
              icon={<CalendarClock size={15} />}
              label="Follow up"
              active={panel === "followup"}
              onClick={() =>
                setPanel(panel === "followup" ? "none" : "followup")
              }
            />
            <QuickAction
              icon={<ArrowUpRight size={15} />}
              label="Open"
              onClick={() =>
                chrome.tabs.create({ url: `${APP_URL}/contacts/${contact.id}` })
              }
            />
            <QuickAction
              icon={<RefreshCw size={15} />}
              label="Refresh"
              onClick={onChanged}
            />
          </>
        )}
      </nav>
    </>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 border-t-2 py-2.5 text-[10px] transition-colors",
        active
          ? "border-[var(--primary)] bg-[var(--accent)] text-[var(--primary)]"
          : "border-transparent text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

type CaptureStatus = "idle" | "expanding" | "saving" | "conflict" | "degraded" | "success";

/**
 * The one band that can turn a read into an interaction — see `inject/dom/expand.ts`'s
 * header for the full argument. Everything here only ever fires from the button below;
 * nothing in this component runs on mount or on page change.
 *
 * Deliberately scoped to LinkedIn person pages: `page.kind === "person"` can also come
 * from the X and generic adapters (a corroborated personal site, a profile-shaped tweet
 * page), and there is nothing there for `expandProfileSections` to expand or
 * `readProfileSections` to read, so the band renders nothing at all off LinkedIn.
 */
function ExperienceCaptureBand({
  page,
  contact,
  api,
  toast,
  onChanged,
}: {
  page: PageContext;
  contact: ContactSnapshot;
  api: OrbitApi;
  toast: (message: string) => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [conflict, setConflict] = useState<ProfileCaptureResponse["conflict"]>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  // The captured page is held here, not in state, so the "Save anyway" confirmation
  // re-sends the exact same read rather than triggering a second (clicking) capture pass.
  const pendingPageRef = useRef<PageContext | null>(null);

  if (page.site !== "linkedin") return null;

  const isLoginWall = page.warnings.includes("login-wall");
  const isPersonProfile = page.kind === "person";

  const submit = async (capturedPage: PageContext, confirmMismatch: boolean) => {
    setStatus("saving");
    try {
      const result = await api.captureProfile({
        contactId: contact.id,
        page: capturedPage,
        confirmMismatch,
      });
      if (result.conflict) {
        pendingPageRef.current = capturedPage;
        setConflict(result.conflict);
        setStatus("conflict");
        return;
      }
      // `result.experienceCount === 0` is treated as degraded here too, not just
      // `result.degraded` — belt and braces against the server ever regressing the
      // zero-experiences guard (see `profile-capture.ts`): this panel must never be able
      // to render a green "Saved 0 roles" over a contact's previously stored career.
      if (result.degraded || result.experienceCount === 0) {
        const base = capturedPage.identity.profileUrl?.value ?? capturedPage.url;
        setFallbackUrl(`${base.replace(/\/$/, "")}/details/experience`);
        setStatus("degraded");
        return;
      }
      setSavedCount(result.experienceCount);
      setStatus("success");
      onChanged();
    } catch {
      setStatus("idle");
      toast("Couldn't save that");
    }
  };

  const startCapture = async () => {
    setConflict(null);
    setStatus("expanding");
    const read = await captureActiveProfile();
    if (!read.ok) {
      setStatus("idle");
      toast(read.message);
      return;
    }
    await submit(read.page, false);
  };

  if (isLoginWall) {
    return (
      <Section title="Experience">
        <Meta>Sign in to LinkedIn to capture this profile.</Meta>
      </Section>
    );
  }

  if (!isPersonProfile) {
    return (
      <Section title="Experience">
        <Meta>Open someone&apos;s profile to capture their experience.</Meta>
      </Section>
    );
  }

  return (
    <Section title="Experience">
      {status === "conflict" && conflict ? (
        <div className="space-y-2">
          <Meta className="break-words">
            This page is {truncateLabel(conflict.pageSlug)}, but this contact is{" "}
            {truncateLabel(conflict.contactSlug)}. Save anyway?
          </Meta>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                const capturedPage = pendingPageRef.current;
                if (capturedPage) void submit(capturedPage, true);
              }}
            >
              Save anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                pendingPageRef.current = null;
                setConflict(null);
                setStatus("idle");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : status === "degraded" ? (
        <div className="space-y-2">
          <Meta>
            Couldn&apos;t read this profile. Open the full experience page and try again.
          </Meta>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (fallbackUrl) chrome.tabs.create({ url: fallbackUrl });
              }}
            >
              Open experience page
              <ArrowUpRight size={12} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStatus("idle")}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {status === "success" && savedCount !== null ? (
            <Meta className="flex items-center gap-1 !text-[var(--primary)]">
              <Check size={11} />
              Saved {savedCount} {savedCount === 1 ? "role" : "roles"}
            </Meta>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={status === "expanding" || status === "saving"}
            onClick={() => void startCapture()}
          >
            {status === "expanding"
              ? "Expanding sections…"
              : status === "saving"
                ? "Saving…"
                : "Capture experience"}
          </Button>
        </div>
      )}
    </Section>
  );
}
