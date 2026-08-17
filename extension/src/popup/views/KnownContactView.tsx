import { useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  PenLine,
  RefreshCw,
} from "lucide-react";
import type { ContactSnapshot, FieldChange, PageContext } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { APP_URL } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { StarterList } from "../components/StarterList";
import { ClosenessRing } from "../components/ClosenessRing";
import { Badge, Button } from "../components/ui";
import type { PanelState } from "../state/usePanel";

const FOLLOW_UP_PRESETS = [
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
];

/**
 * The page disagrees with the record — "now VP Eng at Stripe". The highest
 * value thing the extension can tell you about someone you already know, so it
 * gets a one-tap accept rather than being buried in a suggestion.
 */
function ChangesCard({
  changes,
  onAccept,
  busy,
}: {
  changes: FieldChange[];
  onAccept: () => void;
  busy: boolean;
}) {
  if (changes.length === 0) return null;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--accent)] p-3">
      <p className="text-[12px] text-[var(--foreground)]">
        Their profile has changed since you last saved it:
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {changes.map((change) => (
          <li key={change.field} className="text-[12px]">
            <span className="text-[var(--muted-foreground)]">
              {change.field}:{" "}
            </span>
            <span className="line-through opacity-60">{change.from}</span>{" "}
            <span className="font-medium">→ {change.to}</span>
          </li>
        ))}
      </ul>
      <Button size="sm" className="mt-2" onClick={onAccept} disabled={busy}>
        <RefreshCw size={12} />
        Update Orbit
      </Button>
    </div>
  );
}

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
  const [toast, setToast] = useState<string | null>(null);

  const lastSpoke = relativeTime(contact.lastInteractionAt);
  const followUpDue = relativeTime(contact.nextFollowUpAt);

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  };

  const saveNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api.logInteraction({ contactId: contact.id, rawNotes: note.trim() });
      setNote("");
      setPanel("none");
      flash("Note added");
      onChanged();
    } catch {
      flash("Couldn't save that note");
    } finally {
      setBusy(false);
    }
  };

  const scheduleFollowUp = async (days: number) => {
    setBusy(true);
    try {
      await api.followUp({ contactId: contact.id, inDays: days });
      setPanel("none");
      flash(`Follow-up set for ${days} days`);
      onChanged();
    } catch {
      flash("Couldn't schedule that");
    } finally {
      setBusy(false);
    }
  };

  const acceptChanges = async () => {
    setBusy(true);
    try {
      const fields: Record<string, string> = { fullName: contact.fullName };
      for (const change of state.resolved?.changes ?? []) {
        fields[change.field] = change.to;
      }
      await api.saveContact({
        mode: "merge",
        contactId: contact.id,
        page,
        fields: fields as never,
      });
      flash("Updated");
      onChanged();
    } catch {
      flash("Couldn't update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scroll-area reveal-stagger flex-1 space-y-3 px-4 py-3">
        {contact.isFollowUpOverdue ? (
          <div className="rounded-[var(--radius)] bg-[var(--destructive)]/12 px-3 py-2 text-[12px] text-[var(--destructive)]">
            Follow-up was due {followUpDue}
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <ClosenessRing tier={contact.closenessTier} />
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {lastSpoke ? `Last spoke ${lastSpoke}` : "No conversations yet"}
          </span>
        </div>

        <ChangesCard
          changes={state.resolved?.changes ?? []}
          onAccept={acceptChanges}
          busy={busy}
        />

        {contact.openActionItems.length > 0 ? (
          <div>
            <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              Open loops
            </h2>
            <ul className="space-y-1">
              {contact.openActionItems.slice(0, 2).map((item) => (
                <li key={item} className="text-[13px] leading-snug">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {contact.keyFacts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contact.keyFacts.slice(0, 3).map((fact) => (
              <Badge key={fact} tone="primary">
                {fact}
              </Badge>
            ))}
          </div>
        ) : null}

        {contact.recentInteractions[0]?.summary ? (
          <div>
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              Last interaction
            </h2>
            <p className="line-clamp-3 text-[13px] leading-snug text-[var(--muted-foreground)]">
              {contact.recentInteractions[0].summary}
            </p>
          </div>
        ) : null}

        <StarterList
          starters={state.starters}
          loading={state.startersLoading}
          degraded={state.startersDegraded}
        />
      </div>

      {panel === "note" ? (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened?"
            rows={3}
            className="w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2 text-[13px] outline-none focus:border-[var(--ring)]"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveNote} disabled={busy || !note.trim()}>
              Save note
            </Button>
          </div>
        </div>
      ) : null}

      {panel === "followup" ? (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {FOLLOW_UP_PRESETS.map((preset) => (
              <Button
                key={preset.days}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => scheduleFollowUp(preset.days)}
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

      {toast ? (
        <div className="flex items-center gap-1.5 border-t border-[var(--border)] px-4 py-2 text-[12px] text-[var(--primary)]">
          <Check size={13} />
          {toast}
        </div>
      ) : null}

      <nav className="grid grid-cols-4 border-t border-[var(--border)]">
        <QuickAction
          icon={<PenLine size={15} />}
          label="Log note"
          active={panel === "note"}
          onClick={() => setPanel(panel === "note" ? "none" : "note")}
        />
        <QuickAction
          icon={<CalendarClock size={15} />}
          label="Follow up"
          active={panel === "followup"}
          onClick={() => setPanel(panel === "followup" ? "none" : "followup")}
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
      className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors ${
        active
          ? "bg-[var(--accent)] text-[var(--primary)]"
          : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
