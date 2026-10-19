/**
 * How a meeting transcript's voices are shown: "You", the other person's name in a 1:1, and
 * "Speaker 1, 2, ..." otherwise. Client-safe — no server imports — because the live meeting
 * panel renders with it as well as the server pages and the digest.
 */

/**
 * Names for the anonymous voices, when the call itself settles who they are. Today that is the
 * one unambiguous case: a 1:1 — exactly one other person invited, and exactly one voice besides
 * the user's — where that voice can only be them. Any more people and the voices stay
 * "Speaker N": guessing who is who in a group call would put words in the wrong mouth.
 */
export function speakerNames(
  segments: ReadonlyArray<{ speaker?: string | null }>,
  otherAttendees: readonly string[]
): Map<string, string> {
  const names = new Map<string, string>();
  const others = [...new Set(otherAttendees.map((n) => n.trim()).filter(Boolean))];
  if (others.length !== 1) return names;
  const voices = new Set(segments.map((s) => s.speaker).filter((s): s is string => !!s && s !== "you"));
  if (voices.size === 1) names.set([...voices][0], others[0]);
  return names;
}

/**
 * Every voice in a transcript, as a person should read it: "You", then "Speaker 1",
 * "Speaker 2", ... in the order the other voices first spoke — whatever the stored labels'
 * own numbers are. Stored labels are stable per Deepgram speaker and may skip numbers (the
 * user's own label became "you"; a reconnect numbers on from the voices before it), so they
 * are never shown raw. A 1:1's other voice is named by `speakerNames` instead.
 *
 * `segments` in transcript order. Labels it does not recognise are left out, which callers
 * render as no label, the same as `speakerLabel`.
 */
export function speakerDisplayNames(
  segments: ReadonlyArray<{ speaker?: string | null }>,
  otherAttendees: readonly string[] = []
): Map<string, string> {
  const names = speakerNames(segments, otherAttendees);
  const display = new Map<string, string>();
  let n = 0;
  for (const { speaker } of segments) {
    if (!speaker || display.has(speaker)) continue;
    if (speaker === "you") display.set(speaker, "You");
    else if (names.has(speaker)) display.set(speaker, names.get(speaker)!);
    else if (/^speaker-\d+$/.test(speaker)) display.set(speaker, `Speaker ${++n}`);
  }
  return display;
}
