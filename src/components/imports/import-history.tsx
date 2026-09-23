"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useTransition,
  type Ref,
} from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  BookUser,
  Calendar as CalendarIcon,
  Contact,
  FileSpreadsheet,
  Mail,
  MessageSquare,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  getImportDetail,
  getImportPeople,
  type ImportDetail,
  type ImportHistoryItem,
} from "@/actions/imports";
import type {
  ImportedPerson,
  ImportPersonOutcome,
} from "@/lib/imports/import-people";

// Re-exported: `import-hub.tsx` has always imported this type from here, and the row shape is
// now owned by the action that narrows it.
export type { ImportHistoryItem };
import {
  classifyImportError,
  describeImportFailure,
  splitReference,
  type ImportFailureCode,
} from "@/lib/import-errors";
import { ImportUndoButton } from "@/components/imports/import-finish-card";
import { importSourceLabel } from "@/lib/imports/import-sources";
import { summarizeImport, type ImportChip } from "@/lib/imports/import-summary";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { withinUndoWindow } from "@/lib/imports/import-finish";
import { cn } from "@/lib/utils";

const CONNECTIONS_BADGE = "bg-import-connections/10 text-import-connections";
const MESSAGES_BADGE = "bg-import-messages/10 text-import-messages";
const CALENDAR_BADGE = "bg-import-calendar/10 text-import-calendar";

/**
 * Icon and colour per type. The labels live in `lib/imports/import-sources.ts` so a smoke can
 * hold them against the adapter constants; this map is keyed by the same ids and the same
 * guard checks it, which is what stops a new import type showing up as a bare "Import" again.
 */
const SOURCE_ICON: Record<string, { icon: LucideIcon; badge: string }> = {
  linkedin_connections: { icon: FileSpreadsheet, badge: CONNECTIONS_BADGE },
  contacts_file: { icon: BookUser, badge: CONNECTIONS_BADGE },
  google_contacts: { icon: Contact, badge: CONNECTIONS_BADGE },
  outlook_contacts: { icon: Contact, badge: CONNECTIONS_BADGE },
  linkedin_messages: { icon: MessageSquare, badge: MESSAGES_BADGE },
  gmail_recruiter_scan: { icon: Mail, badge: MESSAGES_BADGE },
  outlook_recruiter_scan: { icon: Mail, badge: MESSAGES_BADGE },
  calendar_ics: { icon: CalendarIcon, badge: CALENDAR_BADGE },
  calendar_csv: { icon: CalendarIcon, badge: CALENDAR_BADGE },
};

const UNKNOWN_ICON = { icon: Upload, badge: "bg-muted text-muted-foreground" };

const STATUS_LABEL: Record<string, string> = {
  processing: "In progress",
  pending: "Waiting",
  completed: "Done",
  failed: "Didn’t finish",
  cancelled: "Stopped",
};

function statusLabel(status: string) {
  return (
    STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
  );
}

function failureCodeOf(item: ImportHistoryItem): ImportFailureCode {
  const stored = item.stats?.errorCode;
  // The stored code is the precise one, from the error instance. Classifying the message is
  // the fallback that makes every row written before that existed still read properly.
  if (stored) return stored as ImportFailureCode;
  return classifyImportError(item.errorMessage);
}

const CHIP_TONE: Record<ImportChip["tone"], string> = {
  neutral: "text-muted-foreground",
  good: "text-foreground",
  warn: "text-destructive",
  offer: "text-primary",
};

function Chips({ chips }: { chips: ImportChip[] }) {
  if (!chips.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {chips.map((chip, i) => (
        <span
          key={chip.label}
          className={cn("flex items-center gap-2", CHIP_TONE[chip.tone])}
        >
          {i > 0 ? (
            <span aria-hidden className="text-border">
              ·
            </span>
          ) : null}
          {chip.href ? (
            <a href={chip.href} className="underline underline-offset-2">
              {chip.label}
            </a>
          ) : (
            chip.label
          )}
        </span>
      ))}
    </p>
  );
}

/**
 * What an undone import says instead of its chips.
 *
 * The chips describe what the import brought in. Once it has been taken back out they are
 * describing people who are no longer here, so the row says what happened to them instead —
 * and says it in the plainest way available, because "undone" is a thing the person did on
 * purpose and not a fault.
 */
function undoneLine(stats: ImportHistoryItem["stats"]): string | null {
  if (!stats?.undoneAt) return null;
  const removed = stats.undoneRemoved ?? 0;
  const kept = stats.undoneKept ?? 0;
  const parts = [`${removed} ${removed === 1 ? "person" : "people"} removed`];
  if (kept > 0) parts.push(`${kept} kept`);
  return `Undone · ${parts.join(" · ")}`;
}

/** What the done card holds on to so its "See what changed" button can open this sheet. */
export type ImportHistoryHandle = { open: (importId: string) => void };

export function ImportHistory({
  history,
  onUndone,
  ref,
}: {
  history: ImportHistoryItem[];
  /**
   * Called after an undo run from the detail sheet. The rows come from the server, so somebody
   * has to re-read them — the page, which owns the router. This component stays router-free on
   * purpose: `smoke-import-history-render.ts` renders it outside one.
   */
  onUndone?: () => void;
  /**
   * Lets the done card open one import's sheet. A handle rather than a prop the sheet watches:
   * opening is something a person just did, so it belongs in their click and not in an effect
   * chasing a prop that changed.
   */
  ref?: Ref<ImportHistoryHandle>;
}) {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [loading, load] = useTransition();

  const open = useCallback(
    (id: string) => {
      setOpenFor(id);
      setDetail(null);
      load(async () => {
        setDetail(await getImportDetail(id));
      });
    },
    [load],
  );

  useImperativeHandle(ref, () => ({ open }), [open]);

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Import history</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every import on this account, newest first — LinkedIn, contacts files,
          Google, Outlook and calendars.
        </p>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No imports yet. Drop a LinkedIn export or a contacts file above,
          connect Google or Outlook, or add a calendar to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {history.map((h) => {
            const meta =
              (h.importType && SOURCE_ICON[h.importType]) || UNKNOWN_ICON;
            const Icon = meta.icon;
            const label = importSourceLabel(h.importType);
            const title = h.fileName || label;
            const failure =
              h.status === "failed"
                ? describeImportFailure(failureCodeOf(h))
                : null;
            const undone = undoneLine(h.stats);

            return (
              <li
                key={h.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.badge}`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{title}</p>
                    {label !== title ? (
                      <p className="text-xs text-muted-foreground">{label}</p>
                    ) : null}
                    {undone ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {undone}
                      </p>
                    ) : (
                      <Chips chips={summarizeImport(h)} />
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(h.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                    {failure ? (
                      <p className="mt-1 text-xs text-destructive">
                        {failure.cause} — {failure.next}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => open(h.id)}
                  >
                    Details
                  </Button>
                  <Badge
                    variant={
                      h.status === "failed"
                        ? "destructive"
                        : h.status === "processing" || h.status === "cancelled"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {statusLabel(h.status)}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={openFor !== null}
        onOpenChange={(next) => {
          if (!next) {
            setOpenFor(null);
            setDetail(null);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <ImportDetailBody
            detail={detail}
            loading={loading}
            onUndone={() => {
              // The sheet's own detail is client state and the rows behind it are the page's.
              if (openFor) open(openFor);
              onUndone?.();
            }}
          />
        </SheetContent>
      </Sheet>
    </section>
  );
}

function ImportDetailBody({
  detail,
  loading,
  onUndone,
}: {
  detail: ImportDetail | null;
  loading: boolean;
  onUndone?: () => void;
}) {
  if (loading || !detail) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Import details</SheetTitle>
          <SheetDescription>
            {loading
              ? "Looking this one up…"
              : "This import is no longer available"}
          </SheetDescription>
        </SheetHeader>
      </>
    );
  }

  const { item, counts, problems, moreProblems, people } = detail;
  const label = importSourceLabel(item.importType);
  const failure =
    item.status === "failed"
      ? describeImportFailure(failureCodeOf(item))
      : null;
  const ref = splitReference(item.errorMessage).ref;
  const undone = undoneLine(item.stats);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{item.fileName || label}</SheetTitle>
        <SheetDescription>
          {label} ·{" "}
          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-5 px-4 pb-6">
        {failure ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">
              {failure.cause}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{failure.next}</p>
            {failure.fix ? (
              <a
                href={failure.fix.href}
                className="mt-2 inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {failure.fix.label}
              </a>
            ) : null}
          </div>
        ) : null}

        <div>
          <h3 className="text-sm font-medium">What came in</h3>
          {undone ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{undone}</p>
          ) : (
            <>
              <Chips chips={summarizeImport(item)} />
              {summarizeImport(item).length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Nothing was brought in by this one
                </p>
              ) : null}
            </>
          )}
        </div>

        {/*
          The way back out. Offered only while it would do something: this import created
          people, nobody has undone it already, and it is still inside the window. Past that
          the sheet says so rather than showing a button that would refuse.
        */}
        {!undone && (item.contactsCreated ?? 0) > 0 ? (
          withinUndoWindow(new Date(item.createdAt)) ? (
            <div>
              <ImportUndoButton
                importIds={[item.id]}
                variant="outline"
                onUndone={onUndone}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {IMPORT_COPY.undoWindowClosed}
            </p>
          )
        ) : null}

        {counts.done + counts.skipped + counts.failed + counts.pending > 0 ? (
          <div>
            <h3 className="text-sm font-medium">Rows</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {counts.done} imported
              {counts.skipped ? ` · ${counts.skipped} skipped` : ""}
              {counts.failed ? ` · ${counts.failed} Orbit couldn’t save` : ""}
              {counts.pending ? ` · ${counts.pending} still to go` : ""}
            </p>
          </div>
        ) : null}

        {people.added + people.existing > 0 ? (
          <ImportPeopleList
            importId={item.id}
            added={people.added}
            existing={people.existing}
          />
        ) : null}

        {problems.length ? (
          <div>
            <h3 className="text-sm font-medium">What didn’t come in</h3>
            <ul className="mt-1.5 space-y-1.5">
              {problems.map((p, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-border/60 px-3 py-2 text-xs"
                >
                  <span className="font-medium">{p.who ?? "One row"}</span>
                  <span className="text-muted-foreground"> — {p.reason}</span>
                </li>
              ))}
            </ul>
            {moreProblems ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                +{moreProblems} more like these
              </p>
            ) : null}
          </div>
        ) : null}

        {ref ? (
          <p className="text-[0.7rem] text-muted-foreground">
            Reference {ref} — quote this if you ask us about it
          </p>
        ) : null}
      </div>
    </>
  );
}

const OUTCOME_LABEL: Record<ImportPersonOutcome, string> = {
  added: "Added",
  existing: "Already in Orbit",
};

/**
 * Everyone the import touched, split into who it added and who it matched to someone already
 * here. Paged from the server — a LinkedIn export can be thousands of people.
 */
function ImportPeopleList({
  importId,
  added,
  existing,
}: {
  importId: string;
  added: number;
  existing: number;
}) {
  const [outcome, setOutcome] = useState<ImportPersonOutcome>(
    added > 0 ? "added" : "existing",
  );
  const [pages, setPages] = useState<
    Partial<Record<ImportPersonOutcome, { people: ImportedPerson[]; hasMore: boolean }>>
  >({});
  const [loading, load] = useTransition();

  const page = pages[outcome];

  function fetchMore(which: ImportPersonOutcome, offset: number) {
    load(async () => {
      const next = await getImportPeople(importId, which, offset);
      setPages((prev) => ({
        ...prev,
        // Spliced in at its offset rather than appended, so a repeated fetch of the same page
        // (the effect runs twice under StrictMode) replaces itself instead of doubling the list.
        [which]: {
          people: [
            ...(prev[which]?.people ?? []).slice(0, offset),
            ...next.people,
          ],
          hasMore: next.hasMore,
        },
      }));
    });
  }

  // First page of whichever list is showing, once.
  useEffect(() => {
    if (!pages[outcome]) fetchMore(outcome, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on switch only; `pages` is read, not tracked
  }, [outcome]);

  const tabs: { key: ImportPersonOutcome; n: number }[] = [
    { key: "added", n: added },
    { key: "existing", n: existing },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium">People</h3>
      <div
        role="tablist"
        aria-label="People in this import"
        className="mt-1.5 inline-flex rounded-lg border border-border/60 p-0.5 text-xs"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={outcome === t.key}
            disabled={t.n === 0}
            onClick={() => setOutcome(t.key)}
            className={cn(
              "rounded-md px-2.5 py-1 transition-colors disabled:opacity-50",
              outcome === t.key
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {OUTCOME_LABEL[t.key]} · {t.n.toLocaleString()}
          </button>
        ))}
      </div>

      {!page ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading people…</p>
      ) : page.people.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nobody here any more — they may have been deleted since
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border/50 rounded-lg border border-border/60">
          {page.people.map((p) => (
            <li key={p.id}>
              <Link
                href={`/contacts/${p.id}`}
                className="block px-3 py-2 text-xs hover:bg-muted/50"
              >
                <span className="font-medium text-foreground">{p.name}</span>
                {p.detail ? (
                  <span className="block truncate text-muted-foreground">
                    {p.detail}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page?.hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1.5"
          disabled={loading}
          onClick={() => fetchMore(outcome, page.people.length)}
        >
          {loading ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
