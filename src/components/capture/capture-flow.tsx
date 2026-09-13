"use client";

/**
 * The capture page, as a view over one durable job.
 *
 *   input → extracting → (resume) → review → summary → saving → saved
 *
 * The phase is derived from the job in the shared store (`lib/capture/job-store.ts`),
 * plus two local facts: "Extract was just pressed" (the animation must start on the
 * click, before the server has a row) and "the resume notice was dismissed". Everything
 * a reload must restore lives on the job; everything else is decoration.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  discardCaptureJob,
  queueCaptureJob,
  recordCaptureChoices,
  recordCaptureDecision,
  saveCaptureJob,
} from "@/actions/capture-jobs";
import { analyzeMeetingSession, type MeetingAnalysis } from "@/actions/meetings";
import { CaptureResumeNotice } from "@/components/capture/capture-resume-notice";
import { CaptureSaved } from "@/components/capture/capture-saved";
import { CaptureSummary, choicesFromSuggestions, suggestionsFromChoices } from "@/components/capture/capture-summary";
import { CAPTURE_MODES, CaptureTabs, capturePanelId, captureTabId, type CaptureMode } from "@/components/capture/capture-tabs";
import { ExtractingStage } from "@/components/capture/extracting-stage";
import { IgnoredPeopleSection } from "@/components/capture/ignored-people-section";
import { MeetingCaptureTab } from "@/components/capture/meeting-capture-tab";
import { MeetingSummaryCard, type SelectableMeetingItem } from "@/components/capture/meeting-summary-card";
import { MessyNotesCapture } from "@/components/capture/messy-notes-capture";
import { PersonDeck } from "@/components/capture/review/person-deck";
import { StructuredCaptureForm } from "@/components/capture/structured-capture-form";
import { VoiceCapture } from "@/components/capture/voice-capture";
import type { SuggestionReviewItem } from "@/components/chat/bulk-notes-panel";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import type { CaptureJobView } from "@/lib/capture-jobs";
import { clearCaptureJob, refreshCaptureJob, seedCaptureJob, useCaptureJob } from "@/lib/capture/job-store";
import { acceptedPeople, countDecisions, firstPendingIndex, initialPhaseFor, type CapturePhase } from "@/lib/capture/review-reducer";
import type { CaptureDecision, CaptureDecisions, CaptureJobSource } from "@/lib/capture/types";
import { useCaptureIngest } from "@/lib/capture/use-capture-ingest";
import { captureDraftKey, clearCaptureDraft } from "@/lib/capture-draft";
import { MISSING_AI_API_KEY_MESSAGE, isMissingAiApiKeyError } from "@/lib/errors";
import { meetingExtrasFromDigest } from "@/lib/meeting-extras";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { DUR, DUR_MS, EASE_HOUSE } from "@/lib/motion";
import { toast } from "@/lib/toast";

const SOURCE_LABEL: Record<CaptureJobSource, string> = {
  messy: "your notes",
  voice: "a voice note",
  meeting: "a meeting",
  scan: "a scan",
  phone: "your phone",
};

export function CaptureFlow({
  initialJob,
  initialContactId = null,
  initialContactName = null,
  defaultMode = "messy",
  hasApiKey = true,
  canTranscribe = false,
  resumableMeeting = null,
  ignoredCount = 0,
  quota,
  userId = null,
  history = null,
}: {
  initialJob: CaptureJobView | null;
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
  hasApiKey?: boolean;
  canTranscribe?: boolean;
  resumableMeeting?: ResumableMeeting | null;
  ignoredCount?: number;
  quota?: { used: number; limit: number | null } | null;
  /** For the notes box's localStorage draft key. */
  userId?: string | null;
  /** The capture history feed, shown under the input UI only. */
  history?: React.ReactNode;
}) {
  const router = useRouter();
  const { job: storeJob } = useCaptureJob();
  // The server's job is shown on first paint and pushed into the store right after mount
  // (not during render: the store has other subscribers, and emitting mid-render is a
  // React error). After that the store is the truth — including "cleared".
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (initialJob) seedCaptureJob(initialJob, { force: true });
  }, [initialJob]);
  const job = seeded.current ? storeJob : (storeJob ?? initialJob);

  const [mode, setMode] = useState<CaptureMode>(() =>
    initialJob && (initialJob.status === "transcribed" || initialJob.status === "ingesting") ? tabForSource(initialJob.sourceKind) : defaultMode
  );
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [foundHold, setFoundHold] = useState(false);
  const [meetingAnalysis, setMeetingAnalysis] = useState<MeetingAnalysis | null>(null);

  const prefill = initialJob && initialJob.status === "transcribed" ? initialJob : null;
  const prefillText = prefill ? [prefill.inputText, ...prefill.blocks.map((b) => b.text)].filter(Boolean).join("\n\n---\n\n") : "";

  const messy = useCaptureIngest({
    sourceKind: "messy",
    hasApiKey,
    initialNotes: prefill && prefill.sourceKind !== "voice" ? prefillText : "",
    initialJobId: prefill && prefill.sourceKind !== "voice" ? prefill.id : null,
    onAutoExtract: (text, hints, jobId) => void startExtraction({ text, hints, jobId, sourceKind: "messy" }),
  });
  const voice = useCaptureIngest({
    sourceKind: "voice",
    hasApiKey,
    initialNotes: prefill && prefill.sourceKind === "voice" ? prefillText : "",
    initialJobId: prefill && prefill.sourceKind === "voice" ? prefill.id : null,
  });

  // ── Phase ───────────────────────────────────────────────────────────────────────────
  const phase: CapturePhase = useMemo(() => {
    if (pendingStart) return "extracting";
    const base = initialPhaseFor(job);
    if (base === "resume" && reviewOpened) return "review";
    return base;
  }, [job, pendingStart, reviewOpened]);

  // Extraction just landed: hold the "Found N" beat, then open the cards.
  const prevStatus = useRef(job?.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = job?.status;
    if (job?.status === "ready" && (was === "extracting" || was === "queued")) {
      setFoundHold(true);
      const t = window.setTimeout(() => {
        setFoundHold(false);
        setReviewOpened(true);
      }, DUR_MS.slow + 350);
      return () => window.clearTimeout(t);
    }
    if (job?.status !== "ready") setReviewOpened(false);
  }, [job?.status]);

  // A meeting job that was reloaded: recover the digest for the header card (cheap — the
  // digest is stored; no model call without `force`).
  useEffect(() => {
    if (!job?.meetingSessionId || meetingAnalysis) return;
    if (!["ready", "reviewing", "saving", "saved"].includes(job.status)) return;
    let cancelled = false;
    void analyzeMeetingSession(job.meetingSessionId).then((res) => {
      if (!cancelled && res.ok) setMeetingAnalysis(res.analysis);
    });
    return () => {
      cancelled = true;
    };
  }, [job?.meetingSessionId, job?.status, meetingAnalysis]);

  // ── Actions ─────────────────────────────────────────────────────────────────────────
  const startExtraction = useCallback(
    async (input: { text: string; hints: Parameters<typeof queueCaptureJob>[0]["hints"]; jobId: string | null; sourceKind: CaptureJobSource; meetingSessionId?: string | null }) => {
      if (!input.text.trim() && !input.jobId) return;
      setPendingStart(true);
      setReviewOpened(false);
      const res = await queueCaptureJob({
        jobId: input.jobId,
        text: input.text,
        hints: input.hints,
        sourceKind: input.sourceKind,
        entryPoint: initialContactId ? "profile" : "capture",
        seedContactId: initialContactId,
        meetingSessionId: input.meetingSessionId ?? null,
      });
      if (!res.ok) {
        setPendingStart(false);
        const missingKey = isMissingAiApiKeyError(res.error);
        if (missingKey) {
          messy.setHasApiKey(false);
          voice.setHasApiKey(false);
        }
        toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
        return;
      }
      seedCaptureJob(res.job, { force: true });
      setPendingStart(false);
      // Extracted means decided: the draft's job is done.
      if (userId && input.sourceKind === "messy") clearCaptureDraft(window.localStorage, captureDraftKey(userId, initialContactId));
    },
    [initialContactId, messy, voice, userId]
  );

  const save = useCallback(async (jobId: string) => {
    const res = await saveCaptureJob(jobId);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    seedCaptureJob(res.job, { force: true });
  }, []);

  const applyDecision = useCallback(
    (key: string, decision: CaptureDecision | null) => {
      if (!job) return;
      const people = { ...(job.decisions.people ?? {}) };
      if (decision) people[key] = decision;
      else delete people[key];
      const decisions: CaptureDecisions = { ...job.decisions, people };
      seedCaptureJob({ ...job, decisions, status: "reviewing", updatedAt: new Date().toISOString() }, { force: true });
      void recordCaptureDecision(job.id, key, decision).then((res) => {
        if (!res.ok) {
          toast.error(res.error);
          void refreshCaptureJob();
          return;
        }
        seedCaptureJob(res.job, { force: true });
        // One person, kept: accept is the save.
        const items = res.job.result?.items ?? [];
        const counts = countDecisions(items, res.job.decisions);
        if (decision?.decision === "accept" && items.length === 1 && counts.pending === 0 && counts.accepted === 1) {
          void save(res.job.id);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job]
  );

  const startOver = useCallback(async () => {
    const id = job?.id;
    clearCaptureJob();
    setReviewOpened(false);
    setMeetingAnalysis(null);
    messy.reset();
    voice.reset();
    if (id) await discardCaptureJob(id);
    router.refresh();
  }, [job?.id, messy, voice, router]);

  const onMeetingAnalyzed = useCallback(
    (analysis: MeetingAnalysis, sessionId: string) => {
      setMeetingAnalysis(analysis);
      void startExtraction({ text: analysis.corpus, hints: analysis.hints, jobId: null, sourceKind: "meeting", meetingSessionId: sessionId });
    },
    [startExtraction]
  );

  // ── Render ──────────────────────────────────────────────────────────────────────────
  const items = job?.result?.items ?? [];
  const reviewIndex = job ? firstPendingIndex(items, job.decisions) : -1;
  const inputLocked = phase !== "input" || meetingBusy;
  const blurb = CAPTURE_MODES.find((m) => m.id === mode)?.blurb;

  const meetingHeader =
    job?.meetingSessionId && meetingAnalysis ? (
      <MeetingHeader job={job} analysis={meetingAnalysis} readOnly={phase === "saving" || phase === "saved"} />
    ) : null;

  return (
    <div className="space-y-6">
      {phase === "input" && quota && !initialContactId && <ContactQuotaNotice used={quota.used} limit={quota.limit} />}

      {phase === "input" && (
        <div className="space-y-2">
          <CaptureTabs mode={mode} onChange={setMode} disabled={inputLocked} />
          {blurb && <p className="text-sm text-muted-foreground">{blurb}</p>}
        </div>
      )}

      {job?.status === "failed" && phase === "input" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] px-3 py-2 text-sm">
          <span>{job.error ?? "Couldn’t finish that capture"}</span>
          <div className="flex gap-2">
            {job.result && (
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => void save(job.id)}>
                Try saving again
              </button>
            )}
            <button type="button" className="font-medium text-muted-foreground hover:underline" onClick={() => void startOver()}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {phase === "input" && (
          <motion.div
            key={`input-${mode}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
          >
            {mode === "messy" && (
              <MessyNotesCapture
                ingest={messy}
                extracting={pendingStart}
                preferredContactName={initialContactName}
                panelId={capturePanelId("messy")}
                tabId={captureTabId("messy")}
                draftKey={userId ? captureDraftKey(userId, initialContactId) : null}
                acceptsHandoff={!initialContactId}
                onExtract={() => void startExtraction({ text: messy.notes, hints: messy.hints, jobId: messy.jobId, sourceKind: "messy" })}
              />
            )}
            {mode === "voice" && (
              <VoiceCapture
                ingest={voice}
                extracting={pendingStart}
                canTranscribe={canTranscribe}
                panelId={capturePanelId("voice")}
                tabId={captureTabId("voice")}
                onExtract={() => void startExtraction({ text: voice.notes, hints: voice.hints, jobId: voice.jobId, sourceKind: "voice" })}
              />
            )}
            {mode === "meeting" && (
              <MeetingCaptureTab
                resumable={resumableMeeting}
                hasApiKey={hasApiKey}
                canTranscribe={canTranscribe}
                onBusyChange={setMeetingBusy}
                onAnalyzed={onMeetingAnalyzed}
                panelId={capturePanelId("meeting")}
                tabId={captureTabId("meeting")}
              />
            )}
            {mode === "structured" && (
              <div id={capturePanelId("structured")} role="tabpanel" aria-labelledby={captureTabId("structured")}>
                <StructuredCaptureForm initialContactId={initialContactId} initialContactName={initialContactName} />
              </div>
            )}
          </motion.div>
        )}

        {phase === "extracting" && (
          <ExtractingStage
            key="extracting"
            phase={foundHold ? "found" : "reading"}
            foundCount={items.length}
            meta={sourceMeta(job, messy.fileName ?? voice.fileName)}
          />
        )}

        {phase === "resume" && job && (
          <CaptureResumeNotice
            key="resume"
            count={items.length}
            sourceLabel={SOURCE_LABEL[job.sourceKind]}
            onReview={() => setReviewOpened(true)}
            onStartOver={() => void startOver()}
          />
        )}

        {phase === "review" && job && reviewIndex >= 0 && (
          <motion.div key="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.base }} className="space-y-4">
            {meetingHeader}
            <PersonDeck
              items={items}
              decisions={job.decisions}
              index={reviewIndex}
              preferredContactId={initialContactId}
              onDecide={applyDecision}
              onBack={(key) => applyDecision(key, null)}
              onStartOver={() => void startOver()}
            />
          </motion.div>
        )}

        {(phase === "summary" || phase === "saving") && job?.result && (
          <SummaryStep
            key={`summary-${job.id}`}
            job={job}
            saving={phase === "saving"}
            headerSlot={meetingHeader}
            onDecide={applyDecision}
            onSave={() => void save(job.id)}
            onStartOver={() => void startOver()}
            onBack={() => {
              const last = acceptedPeople(items, job.decisions).at(-1) ?? null;
              const lastKey = last?.item.key ?? items.at(-1)?.key ?? null;
              if (lastKey) applyDecision(lastKey, null);
            }}
          />
        )}

        {phase === "saved" && job?.result && (
          <motion.div key="saved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            {meetingHeader}
            <CaptureSaved result={job.result} decisions={job.decisions} onCaptureMore={() => void startOver()} />
          </motion.div>
        )}
      </AnimatePresence>

      {phase === "input" && history}
      {phase !== "review" && <IgnoredPeopleSection initialCount={ignoredCount} />}
    </div>
  );
}

function tabForSource(kind: CaptureJobSource): CaptureMode {
  return kind === "voice" ? "voice" : kind === "meeting" ? "meeting" : "messy";
}

function sourceMeta(job: CaptureJobView | null, fileName: string | null): string | null {
  if (fileName) return fileName;
  if (!job) return null;
  if (job.sourceKind === "meeting") return "the meeting";
  if (job.blocks.length) return job.sources.join(", ") || `${job.blocks.length} ${job.blocks.length === 1 ? "block" : "blocks"}`;
  return null;
}

/** The summary owns the reminder ticks locally and writes them to the job as they change. */
function SummaryStep({
  job,
  saving,
  headerSlot,
  onDecide,
  onSave,
  onStartOver,
  onBack,
}: {
  job: CaptureJobView;
  saving: boolean;
  headerSlot: React.ReactNode;
  onDecide: (key: string, decision: CaptureDecision) => void;
  onSave: () => void;
  onStartOver: () => void;
  onBack: () => void;
}) {
  const result = job.result!;
  const [suggestions, setSuggestions] = useState<SuggestionReviewItem[]>(() => suggestionsFromChoices(result, job.decisions.reminders));
  const timer = useRef<number | null>(null);

  function change(next: SuggestionReviewItem[]) {
    setSuggestions(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void recordCaptureChoices(job.id, { reminders: choicesFromSuggestions(next, result.suggestedReminders) }).then((res) => {
        if (res.ok) seedCaptureJob(res.job, { force: true });
      });
    }, 400);
  }

  async function saveNow() {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
      const res = await recordCaptureChoices(job.id, { reminders: choicesFromSuggestions(suggestions, result.suggestedReminders) });
      if (res.ok) seedCaptureJob(res.job, { force: true });
    }
    onSave();
  }

  const meetingExtraCount = job.decisions.meeting?.extraReminderKeys.length ?? 0;
  return (
    <CaptureSummary
      result={result}
      decisions={job.decisions}
      suggestions={suggestions}
      onSuggestionsChange={change}
      onDecide={onDecide}
      onSave={() => void saveNow()}
      onStartOver={onStartOver}
      onBack={onBack}
      saving={saving}
      error={job.status === "failed" ? job.error : null}
      headerSlot={headerSlot}
      hasMeeting={Boolean(job.meetingSessionId)}
      meetingExtraCount={meetingExtraCount}
    />
  );
}

/** The meeting's digest above the cards and the summary, with its tickable items. */
function MeetingHeader({ job, analysis, readOnly }: { job: CaptureJobView; analysis: MeetingAnalysis; readOnly: boolean }) {
  const extras = useMemo(() => meetingExtrasFromDigest(analysis.digest), [analysis]);
  const chosen = job.decisions.meeting;
  const items: SelectableMeetingItem[] = useMemo(
    () =>
      extras.map((e) => ({
        key: e.key,
        kind: e.kind,
        text: e.title,
        owner: e.ownerName ?? (e.kind === "action" && e.checkedByDefault ? "me" : null),
        sourceExcerpt: e.sourceExcerpt,
        checked: chosen ? chosen.extraReminderKeys.includes(e.key) : e.checkedByDefault,
        title: chosen?.titles?.[e.key] ?? e.title,
      })),
    [extras, chosen]
  );
  const timer = useRef<number | null>(null);
  function onItemsChange(next: SelectableMeetingItem[]) {
    const meeting = {
      extraReminderKeys: next.filter((i) => i.checked && i.title.trim()).map((i) => i.key),
      titles: Object.fromEntries(next.filter((i) => i.title.trim() && i.title !== i.text).map((i) => [i.key, i.title])),
    };
    seedCaptureJob({ ...job, decisions: { ...job.decisions, meeting }, updatedAt: new Date().toISOString() }, { force: true });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void recordCaptureChoices(job.id, { meeting }).then((res) => {
        if (res.ok) seedCaptureJob(res.job, { force: true });
      });
    }, 400);
  }
  return (
    <div className="space-y-2">
      <MeetingSummaryCard
        meeting={{
          title: analysis.digest.title || "Meeting",
          summary: analysis.digest.summary,
          keyPoints: analysis.digest.keyPoints,
          decisions: analysis.digest.decisions,
          actionItems: analysis.digest.actionItems,
          blockers: analysis.digest.blockers,
          openQuestions: analysis.digest.openQuestions,
          durationMs: analysis.durationMs,
          startedAtIso: analysis.startedAtIso,
        }}
        items={readOnly ? undefined : items}
        onItemsChange={readOnly ? undefined : onItemsChange}
        sessionId={job.meetingSessionId ?? undefined}
      />
      {analysis.missingSeqs.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {analysis.missingSeqs.length} minute{analysis.missingSeqs.length === 1 ? "" : "s"} of this meeting never reached Orbit, so they are not in the summary.
        </p>
      )}
    </div>
  );
}
