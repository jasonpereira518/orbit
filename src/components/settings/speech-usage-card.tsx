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

export function formatMinutes(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

/**
 * What Orbit did: minutes actually transcribed this month, added across both meters. Rounds
 * to whole minutes, so anything under 30 seconds would otherwise print "0 min transcribed" —
 * worded as if nothing happened instead.
 */
/** Seconds transcribed this month and the plan's total, across meetings and short-form. */
export function speechTotals(speech: SpeechAllowances) {
  const used = speech.meeting.used + speech.shortform.used;
  const limit = Math.max(0, speech.meeting.limit) + Math.max(0, speech.shortform.limit);
  return { used, limit };
}

function Meter({ label, allowance }: { label: string; allowance: SpeechAllowanceView }) {
  if (allowance.limit <= 0) {
    return (
      <li className="flex min-h-7 items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-muted-foreground">Not on this plan</span>
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
 * The per-kind meters, for Advanced. Deepgram runs on Orbit's own key and allowance, never the
 * person's, so this stays apart from the AI usage above it. Read server-side via
 * `speechAllowance` and handed down through Settings' server page.
 */
export function SpeechDetails({ speech }: { speech: SpeechAllowances }) {
  return (
    <ul className="space-y-1 text-sm text-muted-foreground">
      <Meter label="Meetings" allowance={speech.meeting} />
      <Meter label="Voice notes & chat mic" allowance={speech.shortform} />
    </ul>
  );
}
