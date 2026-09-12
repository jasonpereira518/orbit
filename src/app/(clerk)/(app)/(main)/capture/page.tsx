import { getContact } from "@/actions/contacts";
import { getActiveCaptureJob } from "@/actions/capture-jobs";
import { countIgnoredPeople } from "@/actions/ignored-people";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import type { CaptureMode } from "@/components/capture/capture-tabs";
import { requireUserId } from "@/lib/auth";
import { getResumableMeeting } from "@/lib/meeting-sessions";

// Page-level, because it governs the server actions called from this page: summarizing an
// hour-long meeting is a map-reduce over several model calls. The (main) layout's 300 is
// a stopgap slated to go back to 60; this page needs its own.
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

  const settingsPromise = getSettings();
  const planPromise = getPlanOverview();
  const resumablePromise = requireUserId()
    .then((userId) => getResumableMeeting(userId))
    // The banner is a convenience; a failure to read it must never take capture down.
    .catch(() => null);
  // Same for the job and the ignored count: the page must render without either.
  const jobPromise = getActiveCaptureJob().catch(() => null);
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
  const { usage } = await planPromise;
  const resumableMeeting = await resumablePromise;
  const job = await jobPromise;
  const ignoredCount = await ignoredPromise;
  // An unfinished meeting is the one thing on this page that can be lost by ignoring it,
  // so it opens on the Meeting tab unless the link asked for something specific.
  const defaultMode: CaptureMode =
    modeParam || (contactId ? "structured" : resumableMeeting ? "meeting" : "messy");
  // Mirrors the engine chain in `transcribeAudioWithAI`: Wispr, Whisper, Gemini. Anthropic
  // has no speech-to-text, so an Anthropic-only account can summarize but not transcribe.
  const canTranscribe =
    settings.hasWisprKey ||
    settings.providers.some((p) => (p.id === "openai" || p.id === "gemini") && (p.hasPersonalKey || p.usingEnv));

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
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
        hasApiKey={settings.hasApiKey}
        canTranscribe={canTranscribe}
        resumableMeeting={resumableMeeting}
        ignoredCount={ignoredCount}
        quota={{ used: usage.used, limit: usage.limit }}
      />
    </div>
  );
}
