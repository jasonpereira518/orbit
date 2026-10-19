import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import { getContactLabel } from "@/actions/contacts";
import { getActiveCaptureJob, getActiveCaptureJobs } from "@/actions/capture-jobs";
import { getCloudNotesState } from "@/actions/cloud-notes";
import { countIgnoredPeople } from "@/actions/ignored-people";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import { CaptureHistory, CaptureHistorySkeleton } from "@/components/capture/capture-history";
import type { CaptureMode } from "@/components/capture/capture-tabs";
import { requireUserId } from "@/lib/auth";
import { FEATURE_DENIAL, getEntitlements } from "@/lib/entitlements";
import { getResumableMeeting } from "@/lib/meeting-sessions";
import { RenderStamp } from "@/components/layout/render-stamp";
import { findEventById } from "@/lib/calendar-events";
import { userTimeZone } from "@/lib/meeting-context";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { CLOUD_NOTES_SURFACE_KEY } from "@/lib/surfaces";
import { isSurfaceLive } from "@/lib/surface-visibility";

// Page-level, because it governs the server actions called from this page: summarizing an
// hour-long meeting is a map-reduce over several model calls. The (main) layout is 60, so
// this page needs its own.
export const maxDuration = 300;

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string; review?: string; event?: string }>;
}) {
  const gate = await pageVisibilityGate("page.capture");
  if (gate) return gate;

  const params = await searchParams;
  const requestedContactId = params.contactId || null;
  // `structured` was the form tab Drive & OneDrive replaced; old links land on the notes box,
  // which takes the same contact.
  const modeParam: CaptureMode | null =
    params.mode === "messy" || params.mode === "voice" || params.mode === "meeting" || params.mode === "cloud"
      ? params.mode
      : params.mode === "structured"
        ? "messy"
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
  // Null hides the Drive & OneDrive tab: the surface is not live for this viewer, or the read failed.
  const cloudNotesPromise = userIdPromise
    .then((userId) => isSurfaceLive(userId, CLOUD_NOTES_SURFACE_KEY))
    .then((live) => (live ? getCloudNotesState() : null))
    .catch(() => null);

  let contactId: string | null = null;
  let contactName: string | null = null;
  if (requestedContactId) {
    const contact = await getContactLabel(requestedContactId);
    if (contact) {
      contactId = contact.id;
      contactName = contact.name;
    }
  }

  const settings = await settingsPromise;
  const userId = await userIdPromise;

  // "Add a note" after a meeting (the "How did it go?" card): the attendees, the day and the
  // kind of interaction are known, so the parse starts from them instead of guessing.
  const event =
    params.event && /^[0-9a-f-]{36}$/i.test(params.event) ? await findEventById(userId, params.event).catch(() => null) : null;
  const initialMeeting = event
    ? {
        notes: `Notes from “${event.title || "the meeting"}”${
          event.attendees.length ? ` with ${event.attendees.map((a) => a.name || a.email).join(", ")}` : ""
        }:\n`,
        hints: {
          eventDate: ymdInZone(event.startAt, await userTimeZone(userId)),
          interactionType: "meeting",
          seedPeople: event.attendees.map((a) => ({ name: a.name || null, email: a.email || null })),
        },
      }
    : null;
  const { usage } = await planPromise;
  const { canUseMeetings, canUseSync } = await getEntitlements(userId);
  const resumableMeeting = await resumablePromise;
  const job = await jobPromise;
  const jobs = await jobsPromise;
  const ignoredCount = await ignoredPromise;
  const cloudNotes = await cloudNotesPromise;
  // An unfinished meeting is the one thing on this page that can be lost by ignoring it,
  // so it opens on the Meeting tab unless the link asked for something specific.
  const defaultMode: CaptureMode =
    modeParam || (resumableMeeting && !contactId && !initialMeeting ? "meeting" : "messy");
  // The gate's own answer for the engine chain in `transcribeAudioWithAI` (Whisper or
  // Gemini — or Orbit's on Lifetime). Anthropic has no speech-to-text, so an Anthropic-only
  // BYOK account can summarize but not transcribe.
  const canTranscribe = settings.ai.canTranscribe;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <div>
        <h1 className="font-heading text-3xl text-ink">Capture</h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
            : "Notes, a voice memo, a meeting, or docs from your drive. Orbit pulls out each person; you review them one card at a time."}
        </p>
      </div>
      <CaptureFlowLazy
        // The toast's and the bell's Review link to this same page: a client navigation would
        // keep the flow's tab state and never open the dialog, so a review link remounts it.
        key={params.review === "1" ? "cloud-review" : "capture"}
        initialJob={job}
        initialJobs={jobs}
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
        initialMeeting={initialMeeting}
        hasApiKey={settings.hasApiKey}
        aiReason={settings.ai.reason}
        canTranscribe={canTranscribe}
        canUseMeetings={canUseMeetings}
        meetingsDeniedMessage={FEATURE_DENIAL.meetings}
        resumableMeeting={resumableMeeting}
        ignoredCount={ignoredCount}
        quota={{ used: usage.used, limit: usage.limit }}
        userId={userId}
        canUseSync={canUseSync}
        cloudNotes={cloudNotes}
        openCloudReview={params.review === "1"}
        drive={{
          apiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
          appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? null,
          // Public (it's in every Google consent URL), read on the server so the browser's
          // drive.file token comes from the same client as the stored grant — as on /imports.
          clientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
        }}
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
