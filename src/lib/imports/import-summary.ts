/**
 * The counters a finished import is worth describing by.
 *
 * Written as chips rather than one string because the three "not created" numbers mean three
 * different things and the schema is explicit that they must stay apart: `skipped` parsed but
 * had nothing to attach to, `blockedByPlan` was refused by the contact cap and wants an
 * upgrade rather than an apology, and `failedRows` is the database having rejected a row.
 * Flattening them into "12 not imported" would lose the only part a person can act on.
 *
 * It also stops calendar imports reading as "0 created · 0 updated". A calendar file import
 * runs with `createsContacts: false` by design, so the number that matters is the meetings it
 * logged, not the people it did not invent.
 */
import { createsContacts } from "@/lib/imports/import-sources";

export type ImportChipTone = "neutral" | "good" | "warn" | "offer";

export type ImportChip = {
  label: string;
  tone: ImportChipTone;
  /** Set on the plan chip, which is an upgrade prompt and not a fault. */
  href?: string;
};

export type SummarisableImport = {
  importType?: string | null;
  contactsCreated?: number | null;
  contactsUpdated?: number | null;
  duplicatesFound?: number | null;
  stats?: {
    skipped?: number;
    blockedByPlan?: number;
    failedRows?: number;
    interactionsLogged?: number;
    remindersCreated?: number;
    messagesImported?: number;
    meetingsLogged?: number;
    docsRead?: number;
    flaggedCommitments?: unknown[];
  } | null;
};

export function summarizeImport(item: SummarisableImport): ImportChip[] {
  const chips: ImportChip[] = [];
  const stats = item.stats ?? {};
  const add = (
    n: number | null | undefined,
    label: (n: number) => string,
    tone: ImportChipTone,
    href?: string,
  ) => {
    if (!n) return;
    chips.push({ label: label(n), tone, href });
  };

  // The engine counts every person it merges into an existing contact under BOTH
  // `contactsUpdated` and `duplicatesFound` (import-engine.ts, the merge batch), so for any
  // engine-era import they are one group of people. Showing both read as "2 updated · 2 already
  // here" — four people where there were two — next to a row count and a People list that
  // (correctly) said two. Rows written before the engine can carry different numbers, and those
  // keep both chips, because there the two counters did mean different things.
  const updated = item.contactsUpdated ?? 0;
  const duplicates = item.duplicatesFound ?? 0;
  const sameGroup = updated === duplicates;

  if (item.importType === "drive_docs") {
    add(stats.docsRead, (n) => `${n} doc${n === 1 ? "" : "s"} read`, "neutral");
  }

  if (createsContacts(item.importType)) {
    add(item.contactsCreated, (n) => `${n} added`, "good");
    add(
      updated,
      (n) => (sameGroup ? `${n} already in Orbit` : `${n} updated`),
      "neutral",
    );
  }

  // Calendar's real output, and the one every calendar row used to be missing.
  add(stats.interactionsLogged, (n) => `${n} meetings logged`, "good");
  add(
    stats.remindersCreated,
    (n) => `${n} reminder${n === 1 ? "" : "s"}`,
    "neutral",
  );
  // No `href`: the section this points at only exists inside the (closed) detail sheet, so
  // a chip on the collapsed list row has nowhere real to link.
  add(stats.flaggedCommitments?.length, (n) => `${n} to look at`, "offer");

  // Legacy per-type counters, still rendered so rows from before the engine keep their numbers.
  add(stats.messagesImported, (n) => `${n} messages`, "neutral");
  add(stats.meetingsLogged, (n) => `${n} meetings`, "neutral");

  if (!sameGroup || !createsContacts(item.importType)) {
    add(item.duplicatesFound, (n) => `${n} already here`, "neutral");
  }
  add(stats.skipped, (n) => `${n} skipped`, "neutral");
  add(
    stats.blockedByPlan,
    (n) => `${n} waiting on your plan`,
    "offer",
    "/settings?section=settings-plan",
  );
  add(stats.failedRows, (n) => `${n} Orbit couldn’t save`, "warn");

  return chips;
}
