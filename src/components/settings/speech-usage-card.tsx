import { SettingsSection } from "@/components/settings/settings-section";
import { formatAllowanceReset } from "@/lib/ai-access-copy";

/**
 * The client-safe shape of `SpeechAllowance` (`@/lib/speech-quota`), with `resetsAt` already
 * turned into an ISO string — this card is rendered from a client component
 * (`integrations-dialog.tsx`), so the server page that reads the real allowance is the one
 * that has to do the Date-to-string conversion before handing it down.
 */
export type SpeechAllowanceView = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  warn: boolean;
  exhausted: boolean;
};

export type SpeechAllowances = {
  meeting: SpeechAllowanceView;
  shortform: SpeechAllowanceView;
};

function formatMinutes(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

/** What Orbit did: minutes actually transcribed this month, added across both meters. */
function activityLine(speech: SpeechAllowances): string {
  const usedSeconds = speech.meeting.used + speech.shortform.used;
  if (usedSeconds <= 0) return "Nothing transcribed yet this month.";
  return `${formatMinutes(usedSeconds)} transcribed this month, across meetings and voice notes.`;
}

function Meter({ label, allowance }: { label: string; allowance: SpeechAllowanceView }) {
  if (allowance.limit <= 0) {
    return (
      <li className="flex min-h-7 items-center justify-between gap-3">
        <span>{label}</span>
        <span>Not on this plan</span>
      </li>
    );
  }
  return (
    <li className="flex min-h-7 items-center justify-between gap-3">
      <span>{label}</span>
      <span className={allowance.exhausted ? "text-destructive" : undefined}>
        {formatMinutes(allowance.remaining)} left · resets {formatAllowanceReset(allowance.resetsAt)}
      </span>
    </li>
  );
}

/**
 * The same high-level, activity-first treatment as `AiUsageCard`, but kept as its own card,
 * visually subordinate (smaller type, stacked directly beneath) and never merged with it —
 * this meters Deepgram calls against Orbit's own key and allowance, not the person's, so
 * whose money is being spent has to stay unambiguous.
 *
 * Read server-side via `speechAllowance` (`@/lib/speech-quota`) and handed down through
 * Settings' server page — never fetched from here, unlike `AiUsageCard` above it, because the
 * allowance is entitlement-gated and cheap to compute once per page load rather than per
 * client mount.
 */
export function SpeechUsageCard({ speech }: { speech: SpeechAllowances }) {
  return (
    <SettingsSection
      title="Speech-to-text"
      description="Deepgram, Orbit’s transcription engine for voice notes, the chat microphone and meetings — run on Orbit’s own key, not yours."
    >
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p>{activityLine(speech)}</p>
        <ul className="space-y-1">
          <Meter label="Meetings" allowance={speech.meeting} />
          <Meter label="Voice notes & chat mic" allowance={speech.shortform} />
        </ul>
      </div>
    </SettingsSection>
  );
}
