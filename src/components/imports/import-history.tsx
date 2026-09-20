"use client";

import { useState, useTransition } from "react";
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
  type ImportDetail,
  type ImportHistoryItem,
} from "@/actions/imports";

// Re-exported: `import-hub.tsx` has always imported this type from here, and the row shape is
// now owned by the action that narrows it.
export type { ImportHistoryItem };
import {
  classifyImportError,
  describeImportFailure,
  splitReference,
  type ImportFailureCode,
} from "@/lib/import-errors";
import { importSourceLabel } from "@/lib/imports/import-sources";
import { summarizeImport, type ImportChip } from "@/lib/imports/import-summary";
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

export function ImportHistory({ history }: { history: ImportHistoryItem[] }) {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [loading, load] = useTransition();

  function open(id: string) {
    setOpenFor(id);
    setDetail(null);
    load(async () => {
      setDetail(await getImportDetail(id));
    });
  }

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
                    <Chips chips={summarizeImport(h)} />
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
          <ImportDetailBody detail={detail} loading={loading} />
        </SheetContent>
      </Sheet>
    </section>
  );
}

function ImportDetailBody({
  detail,
  loading,
}: {
  detail: ImportDetail | null;
  loading: boolean;
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

  const { item, counts, problems, moreProblems } = detail;
  const label = importSourceLabel(item.importType);
  const failure =
    item.status === "failed"
      ? describeImportFailure(failureCodeOf(item))
      : null;
  const ref = splitReference(item.errorMessage).ref;

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
          <Chips chips={summarizeImport(item)} />
          {summarizeImport(item).length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing was brought in by this one
            </p>
          ) : null}
        </div>

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
