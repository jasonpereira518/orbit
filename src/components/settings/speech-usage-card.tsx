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

function Meter({ label, allowance }: { label: string; allowance: SpeechAllowanceView }) {
  if (allowance.limit <= 0) {
    return (
      <li className="flex min-h-9 items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-muted-foreground">Not on this plan</span>
      </li>
    );
  }
  return (
    <li className="flex min-h-9 items-center justify-between gap-3">
      <span>{label}</span>
      <span className={allowance.exhausted ? "text-destructive" : undefined}>
        {formatMinutes(allowance.remaining)} left of {formatMinutes(allowance.limit)} · resets{" "}
        {formatAllowanceReset(allowance.resetsAt)}
      </span>
    </li>
  );
}

/**
 * Remaining minutes on both Deepgram meters. Read server-side via `speechAllowance`
 * (`@/lib/speech-quota`) and handed down through Settings' server page — never fetched from
 * here, unlike `AiUsageCard` alongside it, because the allowance is entitlement-gated and
 * cheap to compute once per page load rather than per client mount.
 */
export function SpeechUsageCard({ speech }: { speech: SpeechAllowances }) {
  return (
    <SettingsSection
      title="Speech-to-text"
      description="Minutes left this month on Deepgram, Orbit's transcription engine for voice notes, the chat microphone and meetings."
    >
      <ul className="space-y-1 text-sm text-muted-foreground">
        <Meter label="Meetings" allowance={speech.meeting} />
        <Meter label="Voice notes & chat mic" allowance={speech.shortform} />
      </ul>
    </SettingsSection>
  );
}
