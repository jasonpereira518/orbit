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
