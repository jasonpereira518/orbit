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
import { useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  MoreHorizontal,
  PenLine,
} from "lucide-react";
import type { ContactSnapshot, PageContext } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { APP_URL } from "@/lib/env";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
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

  const knowledge = [
    ...contact.keyFacts.map((v) => ({ v, tone: "fact" as const })),
    ...contact.sharedInterests.map((v) => ({ v, tone: "shared" as const })),
    ...contact.opportunities.map((v) => ({ v, tone: "opportunity" as const })),
  ];

  const isSparse =
    knowledge.length === 0 &&
    contact.openActionItems.length === 0 &&
    contact.recentInteractions.length === 0;

  return (
    <>
      <div className="scroll-area flex-1">
        {contact.isFollowUpOverdue ? (
          <div className="flex items-center gap-2 border-l-2 border-[var(--destructive)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-3 py-2">
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
                    ×
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

        <Section title="Open loops">
          {contact.openActionItems.length > 0
            ? contact.openActionItems.slice(0, 3).map((item) => (
                <p key={item} className="py-0.5 text-[13px] leading-[18px]">
                  {item}
                </p>
              ))
            : null}
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
              icon={<MoreHorizontal size={15} />}
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
