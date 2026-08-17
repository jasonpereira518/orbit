/**
 * The record Orbit is about to save.
 *
 * The important property: this is fully populated from `page.identity` the
 * moment the local DOM read returns (~40ms), long before `/resolve` answers.
 * The server's `suggested` is a *refinement* of the same data, not its source.
 *
 * Consequence: the capture form is complete and submittable before the network
 * says anything. That — not an animation — is what makes the panel feel
 * instant, and it means an offline or errored panel is still a working one.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ContactFieldSuggestion,
  FieldConfidence,
  PageContext,
} from "@contract";
import type { FieldOrigin, RecordField } from "../components/RecordRow";

type FieldKey =
  | "fullName"
  | "title"
  | "company"
  | "location"
  | "email"
  | "school";

const CORE: FieldKey[] = ["fullName", "title", "company"];
const LABELS: Record<FieldKey, string> = {
  fullName: "Name",
  title: "Title",
  company: "Company",
  location: "Location",
  email: "Email",
  school: "School",
};

type Cell = {
  value: string;
  source: string | null;
  confidence: FieldConfidence | null;
  origin: FieldOrigin;
};

function fromPage(page: PageContext | null, key: FieldKey): Cell {
  const field =
    key === "fullName"
      ? page?.identity.name
      : key === "title"
        ? page?.identity.title
        : key === "company"
          ? page?.identity.company
          : key === "location"
            ? page?.identity.location
            : key === "email"
              ? page?.identity.email
              : page?.identity.school;

  return {
    value: field?.value ?? "",
    source: field?.source ?? null,
    confidence: field?.confidence ?? null,
    origin: "page",
  };
}

export type RecordDraft = {
  fields: RecordField[];
  /** Optional fields with no value yet, offered as ghost chips. */
  available: { key: FieldKey; label: string }[];
  howMet: string;
  followUpDays: number | null;
  /** True once the user has typed anything — binds the panel to the draft. */
  dirty: boolean;
  focusKey: string | null;
};

export function useRecordDraft(
  page: PageContext | null,
  suggested: ContactFieldSuggestion | null
) {
  const [edits, setEdits] = useState<Partial<Record<FieldKey, string>>>({});
  const [revealed, setRevealed] = useState<FieldKey[]>([]);
  const [howMet, setHowMet] = useState("");
  const [followUpDays, setFollowUpDays] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const touchedHowMet = useRef(false);

  const cells = useMemo(() => {
    const out = {} as Record<FieldKey, Cell>;
    for (const key of Object.keys(LABELS) as FieldKey[]) {
      const local = fromPage(page, key);
      const edited = edits[key];

      if (edited !== undefined) {
        out[key] = { ...local, value: edited, origin: "user" };
        continue;
      }
      // The server refines only what the page didn't already answer well.
      const serverValue = suggested?.[key as keyof ContactFieldSuggestion];
      if (!local.value && typeof serverValue === "string" && serverValue) {
        out[key] = {
          value: serverValue,
          source: null,
          confidence: "medium",
          origin: "server",
        };
        continue;
      }
      out[key] = local;
    }
    return out;
  }, [page, suggested, edits]);

  const visible: FieldKey[] = useMemo(() => {
    const keys = [...CORE];
    for (const key of ["location", "email", "school"] as FieldKey[]) {
      if (cells[key]?.value || revealed.includes(key)) keys.push(key);
    }
    return keys;
  }, [cells, revealed]);

  const profileUrl =
    page?.identity.profileUrl?.value ?? suggested?.linkedinUrl ?? page?.url ?? "";

  const fields: RecordField[] = useMemo(() => {
    const rows: RecordField[] = visible.map((key) => ({
      key,
      label: LABELS[key],
      value: cells[key].value,
      source: cells[key].source,
      confidence: cells[key].confidence,
      origin: cells[key].origin,
      brand: key === "company",
      placeholder: key === "fullName" ? "Who is this?" : undefined,
    }));

    if (profileUrl) {
      rows.push({
        key: "source",
        label: "Source",
        // The dedupe key. Shown because it's what makes the match work, and
        // read-only because editing it silently breaks that.
        value: profileUrl.replace(/^https?:\/\/(www\.)?/, ""),
        source: "url",
        confidence: "high",
        origin: "page",
        readOnly: true,
      });
    }
    return rows;
  }, [visible, cells, profileUrl]);

  const available = (["location", "email", "school"] as FieldKey[])
    .filter((key) => !visible.includes(key))
    .map((key) => ({ key, label: LABELS[key] }));

  const setField = useCallback((key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key as FieldKey]: value }));
  }, []);

  const reveal = useCallback((key: FieldKey) => {
    setRevealed((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setFocusKey(key);
  }, []);

  const dirty =
    Object.keys(edits).length > 0 ||
    touchedHowMet.current ||
    followUpDays !== null;

  const editedLabels = (Object.keys(edits) as FieldKey[]).map((k) => LABELS[k]);
  const fromPageCount = fields.filter(
    (f) => f.origin === "page" && f.value && !f.readOnly
  ).length;

  return {
    fields,
    available,
    howMet,
    setHowMet: (value: string) => {
      touchedHowMet.current = true;
      setHowMet(value);
    },
    followUpDays,
    setFollowUpDays,
    setField,
    reveal,
    dirty,
    focusKey,
    editedLabels,
    fromPageCount,
    /** Values the save call should send. */
    toFields: () => ({
      fullName: cells.fullName.value.trim(),
      title: cells.title.value.trim() || undefined,
      company: cells.company.value.trim() || undefined,
      location: cells.location.value.trim() || undefined,
      email: cells.email.value.trim() || undefined,
      school: cells.school.value.trim() || undefined,
      howMet: howMet.trim() || suggested?.howMet || undefined,
      linkedinUrl: suggested?.linkedinUrl ?? undefined,
      xHandle: suggested?.xHandle ?? undefined,
      photoUrl: suggested?.photoUrl ?? undefined,
      tagNames: suggested?.tagNames ?? undefined,
    }),
  };
}
