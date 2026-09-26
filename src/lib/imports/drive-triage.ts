/**
 * Does a picked Drive file look like notes about people?
 *
 * Name and metadata only — the Picker hands us nothing else without reading the file, and
 * reading it before the person has chosen would mean spending their AI key on files they
 * are about to deselect. So this is deliberately simple, and wrong in the direction of
 * asking: a doc it isn't sure about is shown unticked, never hidden.
 */
export const DRIVE_MIME = {
  doc: "application/vnd.google-apps.document",
  slides: "application/vnd.google-apps.presentation",
} as const;

export type PickedDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** ISO timestamp — the Picker's `lastEditedUtc`, converted. */
  modifiedTime: string;
};

const NEGATIVE: [RegExp, string][] = [
  [/\btemplate\b/i, "Looks like a template"],
  [/\b(resume|résumé|cv)\b/i, "Looks like a résumé"],
  [/\b(invoice|receipt|budget)\b/i, "Looks like finance, not notes"],
  [/\b(roadmap|spec|prd)\b/i, "Looks like a plan, not notes"],
  [/\b(pitch|deck)\b/i, "Looks like a presentation, not notes"],
];

const POSITIVE: [RegExp, string][] = [
  [/\b1\s*[:\-]\s*1\b|\b1on1\b|\bone[\s-]on[\s-]one\b/i, "Named like a 1:1"],
  [/\b(debrief|interview)\b/i, "Named like an interview debrief"],
  [/\b(standup|stand-up|sync|retro|meeting|call)\b/i, "Named like meeting notes"],
  [/\b(coffee|catch[\s-]?up|intro)\b/i, "Named like a conversation"],
  [/\bnotes?\b/i, "Named like notes"],
  [/\S\s*(<>|\/)\s*\S/, "Named after two people"],
  [/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, "Has a date in the name"],
];

export function triageDriveFile(
  file: PickedDriveFile,
  _now: Date,
): { likely: boolean; why: string } {
  const name = file.name.trim();
  if (!name || /^untitled( document| presentation)?$/i.test(name)) {
    return { likely: false, why: "The name gives nothing to go on" };
  }
  for (const [re, why] of NEGATIVE) {
    if (re.test(name)) return { likely: false, why };
  }
  for (const [re, why] of POSITIVE) {
    if (re.test(name)) return { likely: true, why };
  }
  return { likely: false, why: "Nothing in the name says notes" };
}
