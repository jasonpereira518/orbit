/**
 * The useful files of a LinkedIn export beyond Connections, messages and the four about you.
 *
 *   - Invitations.csv, Notes.csv, Recommendations_Received/_Given.csv → one note per person,
 *     attached to someone already in Orbit (`LinkedInSignalRowPayload`, run by the engine).
 *   - Jobs/Job Seeker Preferences, Job Applications, Saved Jobs → target companies, and the
 *     preferred job titles as role keywords.
 *   - Certifications, Honors, Projects, Volunteering, Organizations, Publications → the user's
 *     background, shown in Settings.
 *
 * Pure parsers, no I/O. Every string is cleaned and capped: these land next to other people's
 * data, and the note text is read by chat. Files are keyed by lowercased path inside the export.
 */
import Papa from "papaparse";
import { createHash } from "node:crypto";
import { cleanSingleLine } from "@/lib/ai-security";
import type { CareerBackgroundEntry, LinkedInSignalRowPayload } from "@/db/schema";

const NAME_MAX = 120;
const TEXT_MAX = 2000;
const MAX_SIGNALS = 5000;
const MAX_TARGETS = 50;
const MAX_BACKGROUND = 100;
const MAX_TITLES = 10;

type Row = Record<string, string>;

function rowsOf(text: string | undefined): Row[] {
  if (!text) return [];
  const parsed = Papa.parse<Row>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  // Header keys lowercased, so a renamed-case column still reads.
  return parsed.data.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), typeof v === "string" ? v : ""])),
  );
}

const line = (v: string | undefined, max = NAME_MAX) => cleanSingleLine(v ?? "", max) ?? "";

/** Note text keeps its line breaks, minus control characters. */
function body(v: string | undefined): string {
  return (v ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, TEXT_MAX);
}

/**
 * LinkedIn's export stamps: `9/22/26, 8:50 AM` (invitations, jobs), `08/25/26, 07:03 PM`
 * (recommendations). Anything else falls back to `Date.parse`. Read as UTC: the export carries
 * no zone, and a day's precision is all a timeline needs.
 */
export function parseExportStamp(raw: string | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === "PM") hour += 12;
    const d = new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]), hour, Number(m[5])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function key(...parts: (string | null | undefined)[]): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0001")).digest("hex").slice(0, 24);
}

function fullName(first: string | undefined, last: string | undefined): string {
  return line(`${first ?? ""} ${last ?? ""}`.trim());
}

/** A connection request with a message. Direction says whose; the other side's URL identifies them. */
function invitations(text: string | undefined): LinkedInSignalRowPayload[] {
  return rowsOf(text).flatMap((r) => {
    const message = body(r["message"]);
    if (!message) return [];
    const out = (r["direction"] ?? "").trim().toUpperCase() === "OUTGOING";
    const url = line(out ? r["inviteeprofileurl"] : r["inviterprofileurl"], 300);
    if (!url) return [];
    const date = parseExportStamp(r["sent at"]);
    return [
      {
        kind: "linkedin_signal" as const,
        signal: out ? ("invitation_sent" as const) : ("invitation_received" as const),
        externalKey: key("inv", url, r["sent at"], message),
        date: date?.toISOString() ?? null,
        fullName: line(out ? r["to"] : r["from"]),
        linkedinUrl: url,
        company: null,
        title: null,
        text: message,
      },
    ];
  });
}

/** Notes the user wrote on connections inside LinkedIn. */
function notes(text: string | undefined): LinkedInSignalRowPayload[] {
  return rowsOf(text).flatMap((r) => {
    const note = body(r["note"]);
    const url = line(r["connection profile url"], 300);
    if (!note || !url) return [];
    const date = parseExportStamp(r["created on"]);
    return [
      {
        kind: "linkedin_signal" as const,
        signal: "note" as const,
        externalKey: key("note", url, r["created on"], note),
        date: date?.toISOString() ?? null,
        fullName: fullName(r["connection first name"], r["connection last name"]),
        linkedinUrl: url,
        company: null,
        title: null,
        text: note,
      },
    ];
  });
}

/** No URL in these files: matched by name and company, which the engine's 0.85 floor requires both of. */
function recommendations(text: string | undefined, given: boolean): LinkedInSignalRowPayload[] {
  return rowsOf(text).flatMap((r) => {
    const said = body(r["text"]);
    const name = fullName(r["first name"], r["last name"]);
    if (!said || !name) return [];
    if ((r["status"] ?? "").trim().toUpperCase() === "HIDDEN") return [];
    const date = parseExportStamp(r["creation date"]);
    return [
      {
        kind: "linkedin_signal" as const,
        signal: given ? ("recommendation_given" as const) : ("recommendation_received" as const),
        externalKey: key(given ? "rec-given" : "rec", name, r["creation date"], said),
        date: date?.toISOString() ?? null,
        fullName: name,
        linkedinUrl: null,
        company: line(r["company"]) || null,
        title: line(r["job title"]) || null,
        text: said,
      },
    ];
  });
}

export type ExportTexts = ReadonlyMap<string, string>;

/** Every per-person note the export holds, for the engine to attach. */
export function parseExportSignals(texts: ExportTexts): LinkedInSignalRowPayload[] {
  return [
    ...invitations(texts.get("invitations.csv")),
    ...notes(texts.get("notes.csv")),
    ...recommendations(texts.get("recommendations_received.csv"), false),
    ...recommendations(texts.get("recommendations_given.csv"), true),
  ].slice(0, MAX_SIGNALS);
}

export type ExportTarget = { name: string; priority: 1 | 2; note: string };

/** Lists in Job Seeker Preferences are `A | B | C`; older exports used commas or semicolons. */
function splitList(v: string | undefined): string[] {
  return (v ?? "").split(/\s*[|;]\s*/).map((s) => line(s)).filter(Boolean);
}

function day(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/**
 * Companies the user wants to work at: dream companies first (1), then where they applied or
 * saved a job (2). One entry per company, keeping the keenest reason. Company Follows is NOT
 * read — following a page is too casual to put a company on the list.
 */
export function parseExportTargets(texts: ExportTexts): ExportTarget[] {
  const byName = new Map<string, ExportTarget>();
  const add = (name: string, priority: 1 | 2, note: string) => {
    const k = name.toLowerCase();
    if (!name || byName.has(k)) return;
    byName.set(k, { name, priority, note });
  };
  const prefs = rowsOf(texts.get("jobs/job seeker preferences.csv"))[0];
  for (const name of splitList(prefs?.["dream companies"])) add(name, 1, "From LinkedIn: a dream company");
  for (const r of rowsOf(texts.get("jobs/job applications.csv"))) {
    const when = day(parseExportStamp(r["application date"]));
    add(line(r["company name"]), 2, `From LinkedIn: applied${when ? ` ${when}` : ""}`);
  }
  for (const r of rowsOf(texts.get("jobs/saved jobs.csv"))) {
    add(line(r["company name"]), 2, "From LinkedIn: a saved job");
  }
  return [...byName.values()].slice(0, MAX_TARGETS);
}

/** The job titles the user told LinkedIn they want — the same use as saved-alert keywords. */
export function parseExportJobTitles(texts: ExportTexts): string[] {
  const prefs = rowsOf(texts.get("jobs/job seeker preferences.csv"))[0];
  const seen = new Set<string>();
  return splitList(prefs?.["job titles"])
    .map((t) => t.slice(0, 60))
    .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_TITLES);
}

/** Certifications, honors, projects, volunteering, organizations and publications. */
export function parseExportBackground(texts: ExportTexts): CareerBackgroundEntry[] {
  const out: CareerBackgroundEntry[] = [];
  const push = (e: CareerBackgroundEntry) => {
    if (e.title) out.push(Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as CareerBackgroundEntry);
  };
  for (const r of rowsOf(texts.get("certifications.csv")))
    push({ kind: "certification", title: line(r["name"]), org: line(r["authority"]), start: line(r["started on"], 20), end: line(r["finished on"], 20) });
  for (const r of rowsOf(texts.get("honors.csv")))
    push({ kind: "honor", title: line(r["title"]), start: line(r["issued on"], 20) });
  for (const r of rowsOf(texts.get("projects.csv")))
    push({ kind: "project", title: line(r["title"]), start: line(r["started on"], 20), end: line(r["finished on"], 20) });
  for (const r of rowsOf(texts.get("volunteering.csv")))
    push({ kind: "volunteering", title: line(r["role"]), org: line(r["company name"]), start: line(r["started on"], 20), end: line(r["finished on"], 20) });
  for (const r of rowsOf(texts.get("organizations.csv")))
    push({ kind: "organization", title: line(r["name"]), org: line(r["position"]), start: line(r["started on"], 20), end: line(r["finished on"], 20) });
  for (const r of rowsOf(texts.get("publications.csv")))
    push({ kind: "publication", title: line(r["name"]), org: line(r["publisher"]), start: line(r["published on"], 20) });
  return out.slice(0, MAX_BACKGROUND);
}
