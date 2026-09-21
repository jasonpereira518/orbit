import { Suspense } from "react";
import { getContact } from "@/actions/contacts";
import { getActiveCaptureJob, getActiveCaptureJobs } from "@/actions/capture-jobs";
import { countIgnoredPeople } from "@/actions/ignored-people";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import { CaptureHistory, CaptureHistorySkeleton } from "@/components/capture/capture-history";
import type { CaptureMode } from "@/components/capture/capture-tabs";
import { requireUserId } from "@/lib/auth";
import { getResumableMeeting } from "@/lib/meeting-sessions";

// Page-level, because it governs the server actions called from this page: summarizing an
// hour-long meeting is a map-reduce over several model calls. The (main) layout is 60, so
// this page needs its own.
export const maxDuration = 300;

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string }>;
}) {
  const params = await searchParams;
  const requestedContactId = params.contactId || null;
  const modeParam: CaptureMode | null =
    params.mode === "structured" || params.mode === "messy" || params.mode === "voice" || params.mode === "meeting"
      ? params.mode
      : null;

  const userIdPromise = requireUserId();
  const settingsPromise = getSettings();
  const planPromise = getPlanOverview();
  const resumablePromise = requireUserId()
    .then((userId) => getResumableMeeting(userId))
    // The banner is a convenience; a failure to read it must never take capture down.
    .catch(() => null);
  // Same for the job and the ignored count: the page must render without either.
  const jobPromise = getActiveCaptureJob().catch(() => null);
  // Every job still reachable, so a multi-file drop can render its queue. `.catch` because a
  // failed side read must not take the page with it — the single-job resume above is what
  // the page actually needs to function.
  const jobsPromise = getActiveCaptureJobs().catch(() => []);
  const ignoredPromise = countIgnoredPeople().catch(() => 0);

  let contactId: string | null = null;
  let contactName: string | null = null;
  if (requestedContactId) {
    const contact = await getContact(requestedContactId);
    if (contact) {
      contactId = contact.id;
      contactName = contact.preferredName || contact.fullName;
    }
  }

  const settings = await settingsPromise;
  const userId = await userIdPromise;
  const { usage } = await planPromise;
  const resumableMeeting = await resumablePromise;
  const job = await jobPromise;
  const jobs = await jobsPromise;
  const ignoredCount = await ignoredPromise;
  // An unfinished meeting is the one thing on this page that can be lost by ignoring it,
  // so it opens on the Meeting tab unless the link asked for something specific.
  const defaultMode: CaptureMode =
    modeParam || (contactId ? "structured" : resumableMeeting ? "meeting" : "messy");
  // The gate's own answer for the engine chain in `transcribeAudioWithAI` (Whisper or
  // Gemini — or Orbit's on Lifetime). Anthropic has no speech-to-text, so an Anthropic-only
  // BYOK account can summarize but not transcribe.
  const canTranscribe = settings.ai.canTranscribe;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Capture</h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
            : "Notes, a voice memo, a meeting, or a form. Orbit pulls out each person; you review them one card at a time."}
        </p>
      </div>
      <CaptureFlowLazy
        initialJob={job}
        initialJobs={jobs}
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
        hasApiKey={settings.hasApiKey}
        aiReason={settings.ai.reason}
        canTranscribe={canTranscribe}
        resumableMeeting={resumableMeeting}
        ignoredCount={ignoredCount}
        quota={{ used: usage.used, limit: usage.limit }}
        userId={userId}
        // Hidden when logging with one named person: the page is doing one specific thing,
        // and a feed of past captures is not it.
        history={
          !contactId ? (
            <Suspense fallback={<CaptureHistorySkeleton />}>
              <CaptureHistory />
            </Suspense>
          ) : null
        }
      />
    </div>
  );
}
