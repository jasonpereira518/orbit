/**
 * Warm Introduction Request Drafter
 *
 * Pre-drafts a concise, respectful email to a mutual 1st-degree contact asking for
 * an introduction to a surfaced candidate, referencing their shared context.
 */

export type IntroDraftParams = {
  introducerFirstName: string;
  candidateFullName: string;
  candidateTitle?: string | null;
  candidateCompany?: string | null;
  relationshipContext: string;
  projectTitle?: string | null;
  sharedTopic?: string | null;
};

export type IntroDraftResult = {
  subject: string;
  body: string;
};

export function generateIntroRequestDraft(params: IntroDraftParams): IntroDraftResult {
  const introTarget = [params.candidateTitle, params.candidateCompany]
    .filter(Boolean)
    .join(" at ");
  const candidateDescriptor = introTarget
    ? `${params.candidateFullName} (${introTarget})`
    : params.candidateFullName;

  const subject = `Quick question re: intro to ${params.candidateFullName}?`;

  const projectHook = params.projectTitle
    ? `I've been working on ${params.projectTitle}${params.sharedTopic ? ` around ${params.sharedTopic}` : ""} and noticed their work aligns really closely.`
    : `I came across their work and saw you both were connected via ${params.relationshipContext}.`;

  const body = [
    `Hi ${params.introducerFirstName},`,
    "",
    `Hope you're having a great week!`,
    "",
    `I saw that you're connected with ${candidateDescriptor}. ${projectHook}`,
    "",
    `Would you be open to introducing us over a quick email if you feel comfortable? Happy to send over a forwardable blurb if that makes it easier.`,
    "",
    `No pressure at all either way!`,
    "",
    `Best,`,
  ].join("\n");

  return { subject, body };
}
