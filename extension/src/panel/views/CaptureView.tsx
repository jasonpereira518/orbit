/**
 * Capture — the hero.
 *
 * The first draft hid the parsed fields behind a "Refine what Orbit saves"
 * expander. That's a form wearing a trench coat: it says "refine", it means
 * "here's the form you were dreading", and it hides the most interesting thing
 * on screen — the proof that Orbit actually read the page.
 *
 * Here the record is the content. Every value is visible, carries its
 * provenance, and is editable in place.
 */
import { useState } from "react";
import { Loader2, Plus, UserCheck, Zap } from "lucide-react";
import type { MatchCandidate, PageContext } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { APP_URL } from "@/lib/env";
import { RecordRow, humanSource, type RecordField } from "../components/RecordRow";
import { StarterList } from "../components/StarterList";
import { Button, MicroLabel, Section } from "../components/ui";
import { CandidateRow } from "./AmbiguousView";
import { useRecordDraft } from "../state/useRecordDraft";
import type { PanelState } from "../state/usePanel";

const FOLLOW_UP_PRESETS = [
  { label: "3d", days: 3 },
  { label: "1w", days: 7 },
  { label: "2w", days: 14 },
  { label: "1mo", days: 30 },
];

const HOW_MET_SUGGESTIONS = [
  "Met at an event",
  "Intro from a mutual",
  "Cold outreach",
];

export function CaptureView({
  page,
  state,
  api,
  onSaved,
  onDirtyChange,
}: {
  page: PageContext;
  state: PanelState;
  api: OrbitApi;
  onSaved: (contactId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const draft = useRecordDraft(
    page,
    state.resolved?.suggested ?? null,
    state.parsed
  );
  const [hovered, setHovered] = useState<RecordField | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<MatchCandidate[] | null>(null);

  const firstName = draft.fields[0]?.value?.trim().split(/\s+/)[0] ?? "";
  const loginWalled = page.warnings.includes("login-wall");

  // Always rendered, so it can never shift the layout. One line of chrome
  // doing the work of six tooltips.
  const provenanceLine = (() => {
    if (hovered && !hovered.readOnly) {
      return hovered.origin === "user"
        ? `You corrected ${hovered.label}`
        : `${hovered.label} ${humanSource(hovered.source)}`;
    }
    if (state.parsing) return "Reading the rest of this page…";
    if (loginWalled) return "LinkedIn hid most of this. Add what you know.";
    if (draft.fromPageCount === 0) {
      return "This page didn't say much. Add what you know.";
    }
    if (draft.editedLabels.length > 0) {
      return `You corrected ${draft.editedLabels.join(", ")} · ${draft.fromPageCount} from the page`;
    }
    const plural = draft.fromPageCount === 1 ? "" : "s";
    return draft.aiCount > 0
      ? `Read from this page · ${draft.fromPageCount} field${plural}, ${draft.aiCount} inferred`
      : `Read from this page · ${draft.fromPageCount} field${plural}`;
  })();

  const save = async (force = false) => {
    const fields = draft.toFields();
    if (!fields.fullName) {
      setError("Orbit needs a name to save this.");
      return;
    }
    setBusy(true);
    setError(null);
    setDuplicates(null);
    try {
      const result = await api.saveContact({
        mode: "create",
        page,
        force,
        fields,
        followUp:
          draft.followUpDays !== null
            ? { inDays: draft.followUpDays }
            : undefined,
      });
      onSaved(result.contact.id);
    } catch (err) {
      const apiError = err as ApiError;
      // A duplicate is a discovery, not a failure — surface the match(es) the
      // server already found rather than asking for a blind decision.
      if (apiError.code === "duplicate") {
        setError("Orbit already has someone like this.");
        setDuplicates((apiError.candidates as MatchCandidate[] | undefined) ?? []);
      } else {
        setError(apiError.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scroll-area flex-1">
        <Section title="Orbit will save" hairline={false}>
          <div
            className="mt-0.5"
            onMouseLeave={() => setHovered(null)}
          >
            {draft.fields.map((field) => (
              <RecordRow
                key={field.key}
                field={field}
                autoFocus={draft.focusKey === field.key}
                onChange={(value) => {
                  draft.setField(field.key, value);
                  onDirtyChange?.(true);
                }}
                onHover={setHovered}
              />
            ))}
          </div>

          {draft.available.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {draft.available.map((item) => (
                <button
                  key={item.key}
                  onClick={() => draft.reveal(item.key)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:border-[var(--ring)] hover:text-[var(--foreground)]"
                >
                  <Plus size={9} />
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          <p className="mt-3 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <Zap size={10} className="shrink-0" />
            <span className="truncate">{provenanceLine}</span>
          </p>
        </Section>

        <Section title="How you met">
          <textarea
            rows={2}
            value={draft.howMet}
            onChange={(e) => {
              draft.setHowMet(e.target.value);
              onDirtyChange?.(true);
            }}
            placeholder="Where does this person fit?"
            className="w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px] leading-[18px] outline-none focus:border-[var(--ring)]"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {HOW_MET_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => {
                  draft.setHowMet(suggestion);
                  onDirtyChange?.(true);
                }}
                className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] transition-colors hover:border-[var(--ring)] hover:text-[var(--foreground)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Follow-up">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={draft.followUpDays !== null}
              onChange={(e) => draft.setFollowUpDays(e.target.checked ? 7 : null)}
              className="h-3.5 w-3.5 accent-[var(--primary)]"
            />
            <span className="text-[13px]">Remind me to follow up</span>
          </label>
          {draft.followUpDays !== null ? (
            <div className="mt-1.5 flex gap-1.5 pl-[22px]">
              {FOLLOW_UP_PRESETS.map((preset) => (
                <button
                  key={preset.days}
                  onClick={() => draft.setFollowUpDays(preset.days)}
                  className={
                    draft.followUpDays === preset.days
                      ? "rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]"
                      : "rounded-full px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : null}
        </Section>

        {state.starters.length > 0 || state.startersLoading ? (
          <Section>
            <StarterList
              title="Opening lines"
              starters={state.starters}
              loading={state.startersLoading}
              degraded={state.startersDegraded}
              degradedReason={state.startersDegradedReason}
            />
          </Section>
        ) : null}
      </div>

      {error ? (
        <div className="border-t border-[var(--border)] bg-[var(--accent)] px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] text-[var(--foreground)]">
            {duplicates ? (
              <UserCheck size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            ) : null}
            {error}
          </p>
          {duplicates && duplicates.length > 0 ? (
            <ul className="mt-1.5 space-y-1.5">
              {duplicates.slice(0, 2).map((candidate) => (
                <li key={candidate.id}>
                  <CandidateRow
                    candidate={candidate}
                    onPick={(c) =>
                      chrome.tabs.create({ url: `${APP_URL}/contacts/${c.id}` })
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {error.startsWith("Orbit already has") ? (
            <button
              onClick={() => void save(true)}
              className="mt-1.5 text-[11px] text-[var(--primary)] underline-offset-2 hover:underline"
            >
              Add anyway
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-[var(--border)] p-2.5">
        <Button
          size="lg"
          onClick={() => void save(false)}
          disabled={busy}
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Plus size={15} />
          )}
          {busy
            ? `Adding${firstName ? ` ${firstName}` : ""}…`
            : firstName
              ? `Add ${firstName} to your orbit`
              : "Add to your orbit"}
        </Button>
      </div>
    </>
  );
}

export { MicroLabel };
