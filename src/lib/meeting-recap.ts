/**
 * The recap email after a recorded meeting, written from the stored digest — no model call,
 * so it says exactly what the summary page says and costs nothing. Pure: the action
 * (`getMeetingRecap`) gathers the inputs; `scripts/smoke-meeting-calendar-context.ts` drives this.
 */
import type { MeetingDigest } from "@/db/schema";

export type MeetingRecap = { to: string[]; subject: string; body: string };

/** Mail clients cut long mailto: links; past this the "Copy" button is the reliable path. */
export const RECAP_MAX_CHARS = 1800;

export function buildMeetingRecap(input: {
  title: string;
  digest: MeetingDigest;
  /** Everyone invited or listed, with emails where known. */
  attendees: Array<{ name: string; email: string | null }>;
  /** The user's own first name, for their action items. */
  userFirstName: string | null;
  isSelf: (name: string) => boolean;
}): MeetingRecap {
  const others = input.attendees.filter((a) => !input.isSelf(a.name));
  const to = [
    ...new Set(others.map((a) => a.email?.trim().toLowerCase()).filter((e): e is string => !!e && /^[^\s,;<>"]+@[^\s,;<>"]+$/.test(e))),
  ];
  const firstNames = others.map((a) => a.name.trim().split(/\s+/)[0]).filter(Boolean);
  const greeting =
    firstNames.length === 1
      ? `Hi ${firstNames[0]},`
      : firstNames.length === 2
        ? `Hi ${firstNames[0]} and ${firstNames[1]},`
        : "Hi all,";
  const me = input.userFirstName || "me";
  const lines = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const steps = input.digest.actionItems.map((a) => (a.owner ? `${a.text} (${a.owner === "me" ? me : a.owner})` : a.text));

  const body = [
    greeting,
    "",
    `Thanks for the time today. A quick recap of ${input.title}:`,
    input.digest.summary ? `\n${input.digest.summary}` : "",
    input.digest.decisions.length ? `\nWhat we agreed\n${lines(input.digest.decisions)}` : "",
    steps.length ? `\nNext steps\n${lines(steps)}` : "",
    input.digest.openQuestions.length ? `\nStill open\n${lines(input.digest.openQuestions.map((q) => q.text))}` : "",
    "",
    "Let me know if I missed anything.",
  ]
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n");

  return { to, subject: `Recap: ${input.title}`, body };
}

export function recapMailto(recap: MeetingRecap): string {
  const params = new URLSearchParams({ subject: recap.subject, body: recap.body.slice(0, RECAP_MAX_CHARS) });
  // URLSearchParams writes spaces as "+", which mail clients show literally.
  // Addresses go in raw (already shape-checked above): some clients won't decode "%40".
  return `mailto:${recap.to.join(",")}?${params.toString().replace(/\+/g, "%20")}`;
}
