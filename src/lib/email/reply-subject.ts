/**
 * Reply subjects (direct-email P5). Pure — the composer shows the locked "Re: …" subject with
 * the same rule the server stores.
 */
const RE = /^\s*(re|aw|sv)\s*:\s*/i;

/** The original subject, without any Re:/AW:/SV: prefixes. */
export function stripReply(subject: string): string {
  let s = subject.trim();
  while (RE.test(s)) s = s.replace(RE, "");
  return s;
}

/** Gmail only threads a send whose subject matches, so the subject is fixed while replying. */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re: (no subject)";
  return RE.test(s) ? s : `Re: ${s}`;
}
