import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getContactLabel } from "@/actions/contacts";
import { getActiveCaptureJob, getActiveCaptureJobs } from "@/actions/capture-jobs";
import { getCloudNotesState } from "@/actions/cloud-notes";
import { countIgnoredPeople } from "@/actions/ignored-people";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import { CaptureHistory, CaptureHistorySkeleton } from "@/components/capture/capture-history";
import { ImportsTabBar } from "@/components/capture/capture-tabs";
import type { CaptureMode } from "@/components/capture/capture-tabs";
import { ImportsPanel } from "@/components/imports/imports-panel";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RenderStamp } from "@/components/layout/render-stamp";
import { findEventById } from "@/lib/calendar-events";
import { userTimeZone } from "@/lib/meeting-context";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { CLOUD_NOTES_SURFACE_KEY, NOTION_SURFACE_KEY } from "@/lib/surfaces";
import { isSurfaceLive } from "@/lib/surface-visibility";

export const metadata = { title: "Capture" };

// Page-level, because it governs the server actions called from this page: a long paste or
// a stack of files is several model calls, and the Imports tab runs large connections imports
// in `after()`. The (main) layout is 60, so this page needs its own. (/meetings carries the
// same for summarizing a recording.)
export const maxDuration = 300;

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string; review?: string; event?: string }>;
}) {
  const gate = await pageVisibilityGate("page.capture");
  if (gate) return gate;

  const params = await searchParams;
  // Recording moved to /meetings; old links (the nudge, bookmarks, notifications) follow it.
  if (params.mode === "meeting") redirect("/meetings");

  const userIdPromise = requireUserId();
  // The Imports tab (the old /imports page) is its own surface: hidden, coming soon or
  // tier-locked for this viewer, the tab is not shown and `?mode=imports` opens the notes box.
  const importsLivePromise = userIdPromise.then((userId) => isSurfaceLive(userId, "page.imports")).catch(() => false);
  // Null hides the Drive & OneDrive tab: the surface is not live for this viewer, or the read failed.
  const cloudLivePromise = userIdPromise.then((userId) => isSurfaceLive(userId, CLOUD_NOTES_SURFACE_KEY)).catch(() => false);
  const notionLivePromise = userIdPromise.then((userId) => isSurfaceLive(userId, NOTION_SURFACE_KEY)).catch(() => false);

  // The Imports tab renders on the server only when selected, so an ordinary capture visit
  // pays for none of the import hub's reads — and none of the capture reads below run here.
  if (params.mode === "imports" && (await importsLivePromise)) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <RenderStamp />
        <CaptureHeader contactName={null} />
        <ImportsTabBar showCloud={await cloudLivePromise} />
        {/* The Imports tab's `aria-controls` names this panel (`capturePanelId("imports")` and
            `captureTabId("imports")` in capture-tabs.tsx, a client module a server page cannot
            call): without it the tab points at nothing, a critical axe violation. */}
        <div role="tabpanel" id="capture-panel-imports" aria-labelledby="capture-tab-imports">
          <ImportsPanel userId={await userIdPromise} />
        </div>
      </div>
    );
  }

  const requestedContactId = params.contactId || null;
  // `structured` was the form tab Drive & OneDrive replaced; old links land on the notes box,
  // which takes the same contact.
  const modeParam: CaptureMode | null =
    params.mode === "messy" || params.mode === "voice" || params.mode === "cloud" || params.mode === "library"
      ? params.mode
      : params.mode === "structured"
        ? "messy"
        : null;

  const settingsPromise = getSettings();
  const planPromise = getPlanOverview();
  // Same for the job and the ignored count: the page must render without either.
  const jobPromise = getActiveCaptureJob().catch(() => null);
  // Every job still reachable, so a multi-file drop can render its queue. `.catch` because a
  // failed side read must not take the page with it — the single-job resume above is what
  // the page actually needs to function.
  const jobsPromise = getActiveCaptureJobs().catch(() => []);
  const ignoredPromise = countIgnoredPeople().catch(() => 0);
  const cloudNotesPromise = cloudLivePromise
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
  const { canUseSync } = await getEntitlements(userId);
  const job = await jobPromise;
  const jobs = await jobsPromise;
  const ignoredCount = await ignoredPromise;
  const cloudNotes = await cloudNotesPromise;
  const showImports = await importsLivePromise;
  const showNotion = await notionLivePromise;
  const defaultMode: CaptureMode = modeParam || "messy";
  // The gate's own answer for the engine chain in `transcribeAudioWithAI` (Whisper or
  // Gemini — or Orbit's on Lifetime). Anthropic has no speech-to-text, so an Anthropic-only
  // BYOK account can summarize but not transcribe.
  const canTranscribe = settings.ai.canTranscribe;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <CaptureHeader contactName={contactName} />
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
        ignoredCount={ignoredCount}
        quota={{ used: usage.used, limit: usage.limit }}
        userId={userId}
        canUseSync={canUseSync}
        cloudNotes={cloudNotes}
        openCloudReview={params.review === "1"}
        showImports={showImports}
        showNotion={showNotion}
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

function CaptureHeader({ contactName }: { contactName: string | null }) {
  return (
    <div>
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Capture</h1>
      <p className="mt-1 text-muted-foreground">
        {contactName
          ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
          : "Notes, a voice memo, docs from your drive, or your exports. Orbit pulls out each person; you review them one card at a time."}
      </p>
    </div>
  );
}
