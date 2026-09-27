/**
 * Read just the header row of a CSV, without parsing the body.
 *
 * Detection has to ask "what kind of file is this?" of several megabytes it has no intention of
 * parsing yet, and it has to ask the same question `contacts-file.ts` asks when it refuses a
 * LinkedIn export. Both go through here so there is one definition of "the header fields", and
 * so neither pays for a full parse to find out.
 *
 * Deliberately dependency-free apart from PapaParse: this module is imported by
 * `contacts-file.ts` AND by the detection module that imports `contacts-file.ts`, so anything
 * heavier here would be a cycle waiting to happen.
 */
import Papa from "papaparse";

/**
 * The header fields of `text`, lowercased and trimmed by the caller's convention (the
 * predicates that consume this all lowercase again, so this returns them as written).
 *
 * `preview: 1` stops PapaParse after one data row — `meta.fields` is populated from the header
 * regardless, so this is O(header) rather than O(file).
 */
export function headerFields(text: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
  });
  return (parsed.meta.fields ?? []).filter((f) => f.trim());
}
