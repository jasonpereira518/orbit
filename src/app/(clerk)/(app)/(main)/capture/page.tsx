import { Suspense } from "react";
import { getContact } from "@/actions/contacts";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { CaptureFormLazy } from "@/components/capture/capture-form-lazy";
import {
  CaptureHistory,
  CaptureHistorySkeleton,
} from "@/components/capture/capture-history";
import { UnresolvedMentionsCard } from "@/components/capture/unresolved-mentions-card";
import { requireUserId } from "@/lib/auth";
import { getResumableMeeting } from "@/lib/meeting-sessions";

// Page-level, because it governs the server actions called from this page: summarizing an
// hour-long meeting is a map-reduce over several model calls, and the capture save runs
// contact writes for everyone on the call. The (main) layout's 300 is a stopgap slated to
// go back to 60; this page needs its own.
export const maxDuration = 300;

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string }>;
}) {
  const params = await searchParams;
  const requestedContactId = params.contactId || null;
  const modeParam =
    params.mode === "structured" ||
    params.mode === "messy" ||
    params.mode === "voice" ||
    params.mode === "meeting"
      ? params.mode
      : null;

  const userIdPromise = requireUserId();
  const settingsPromise = getSettings();
  const planPromise = getPlanOverview();
  const resumablePromise = requireUserId()
    .then((userId) => getResumableMeeting(userId))
    // The banner is a convenience; a failure to read it must never take capture down.
    .catch(() => null);

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
  // An unfinished meeting is the one thing on this page that can be lost by ignoring it,
  // so it opens on the Meeting tab unless the link asked for something specific.
  const defaultMode =
    modeParam || (contactId ? "structured" : resumableMeeting ? "meeting" : "messy");
  // Mirrors the engine chain in `transcribeAudioWithAI`: Wispr, Whisper, Gemini. Anthropic
  // has no speech-to-text, so an Anthropic-only account can summarize but not transcribe.
  const canTranscribe =
    settings.hasWisprKey ||
    settings.providers.some(
      (p) => (p.id === "openai" || p.id === "gemini") && (p.hasPersonalKey || p.usingEnv)
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Capture
        </h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
            : "Paste notes about one person or many, review each profile, then save."}
        </p>
      </div>
      {/* Only on the general capture page: when you arrived to log an interaction with one
          named person, a list of other people is a distraction from the thing you came for. */}
      {!contactId && <UnresolvedMentionsCard />}
      {/* Capture creates contacts, so the same cap applies. Logging an interaction with
          an existing contact is never blocked — only creating new people is. */}
      {!contactId && (
        <ContactQuotaNotice used={usage.used} limit={usage.limit} />
      )}
      <CaptureFormLazy
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
        hasApiKey={settings.hasApiKey}
        userId={userId}
        canTranscribe={canTranscribe}
        resumableMeeting={resumableMeeting}
      />
      {/* Hidden when logging with one named person, for the same reason the mentions card
          is: the page is doing one specific thing, and a feed of past captures is not it. */}
      {!contactId && (
        <Suspense fallback={<CaptureHistorySkeleton />}>
          <CaptureHistory />
        </Suspense>
      )}
    </div>
  );
}
