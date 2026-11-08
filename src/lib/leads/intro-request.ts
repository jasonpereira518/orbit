/**
 * The intro ask, as a mailto link to the teammate who knows the lead. Deliberately just an
 * email in the person's own client: no request record, no notification, nothing a teammate
 * has to opt out of. An in-app request is a later phase. Pure and client-safe.
 */
import { buildMailtoUrl } from "@/lib/outreach-channels";

export function introRequestMailto(input: {
  teammateName: string;
  teammateEmail: string;
  leadName: string;
  leadCompany: string | null;
}): string {
  const first = input.teammateName.trim().split(/\s+/)[0] || input.teammateName;
  const at = input.leadCompany ? ` at ${input.leadCompany}` : "";
  return buildMailtoUrl({
    email: input.teammateEmail,
    subject: `Intro to ${input.leadName}?`,
    body: [
      `Hi ${first},`,
      "",
      `Orbit says you know ${input.leadName}${at}. Would you be up for introducing me? I can send a short blurb you can forward.`,
      "",
      "Thanks!",
    ].join("\n"),
  });
}
