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

  if (createsContacts(item.importType)) {
    add(item.contactsCreated, (n) => `${n} added`, "good");
    add(item.contactsUpdated, (n) => `${n} updated`, "neutral");
  }

  // Calendar's real output, and the one every calendar row used to be missing.
  add(stats.interactionsLogged, (n) => `${n} meetings logged`, "good");
  add(stats.remindersCreated, (n) => `${n} reminders`, "neutral");

  // Legacy per-type counters, still rendered so rows from before the engine keep their numbers.
  add(stats.messagesImported, (n) => `${n} messages`, "neutral");
  add(stats.meetingsLogged, (n) => `${n} meetings`, "neutral");

  add(item.duplicatesFound, (n) => `${n} already here`, "neutral");
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
